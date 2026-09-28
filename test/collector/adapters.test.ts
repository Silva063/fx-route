import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AdapterOutput } from '../../src/collector/adapter';
import { adapters } from '../../src/collector/adapters/index';
import { htmlTablesAdapter } from '../../src/collector/adapters/declarative';
import { loadConfig, type ProjectConfig } from '../../src/collector/config';
import { ReplayHttp } from '../../src/collector/fixtures';
import { jsonFrom, type HttpClient, type HttpResponse } from '../../src/collector/http';
import { buildOffers } from '../../src/core/offers';
import type { OfficialRates, RawQuote, SourceDef } from '../../src/core/types';
import { ROOT } from '../helpers';

/**
 * Тесты адаптеров на сохранённых ответах сайтов (test/fixtures/sources/<id>).
 * Фикстуры перезаписываются командой `npm run capture`. Если сайт поменял вёрстку,
 * после перезаписи эти тесты упадут: значения ниже сверены вручную с текстом страниц.
 */

const FIXTURES = join(ROOT, 'test/fixtures/sources');
let cfg: ProjectConfig;
const outputs = new Map<string, { out: AdapterOutput; unused: string[] }>();

async function replay(id: string) {
  const source = cfg.sources.find((s) => s.id === id)!;
  const http = new ReplayHttp(join(FIXTURES, id));
  const now = new Date(http.index.recordedAt);
  const out = await adapters[source.adapter!]!({ source, http, now: () => now, log: () => {} });
  return { out, unused: http.unused() };
}

beforeAll(async () => {
  cfg = await loadConfig(join(ROOT, 'config'));
  for (const id of readdirSync(FIXTURES)) {
    if (existsSync(join(FIXTURES, id, 'index.json'))) outputs.set(id, await replay(id));
  }
});

const quotesOf = (id: string): RawQuote[] => outputs.get(id)!.out.batches!.flatMap((b) => b.quotes);
const find = (id: string, table: string, base: string, quote = 'MDL', branch?: string) =>
  quotesOf(id).find((q) => q.table === table && q.base === base && q.quote === quote && q.branch === branch);

describe('все фикстуры', () => {
  it('есть фикстура для каждого источника с автосбором', () => {
    const auto = cfg.sources.filter((s) => s.collect === 'auto').map((s) => s.id);
    expect([...outputs.keys()].sort()).toEqual(auto.sort());
  });

  it('адаптеры отработали без предупреждений и прочитали все записанные ответы', () => {
    for (const [id, { out, unused }] of outputs) {
      expect(out.warnings ?? [], id).toEqual([]);
      expect(unused, id).toEqual([]);
    }
  });

  it('у каждого банка есть котировки во всех таблицах белого списка', () => {
    for (const s of cfg.sources.filter((x) => x.kind === 'bank' && x.collect === 'auto')) {
      const tables = new Set(quotesOf(s.id).map((q) => q.table));
      expect([...tables].sort(), s.id).toEqual(Object.keys(s.tables!).sort());
    }
  });

  it('реальные курсы проходят проверки правдоподобности (ни одного suspicious)', () => {
    const officials: OfficialRates[] = ['bnm', 'prb'].flatMap((id) =>
      outputs.get(id)!.out.official!.map((o) => ({ ...o, source: id })),
    );
    for (const s of cfg.sources.filter((x) => x.kind === 'bank' && x.collect === 'auto')) {
      for (const b of outputs.get(s.id)!.out.batches!) {
        const { offers, dropped } = buildOffers({
          source: s,
          quotes: b.quotes,
          fetchedAt: b.fetchedAt,
          sourceUrl: b.sourceUrl,
          officials,
          plausibility: cfg.settings.plausibility,
        });
        const bad = offers.filter((o) => o.status === 'suspicious').map((o) => `${o.id}: ${o.issues?.map((i) => i.message).join('; ')}`);
        expect(bad, s.id).toEqual([]);
        expect(dropped.filter((d) => d.reason !== 'нет данных'), s.id).toEqual([]);
      }
    }
  });
});

describe('официальные курсы', () => {
  it('BNM: XML на дату записи', () => {
    const [o] = outputs.get('bnm')!.out.official!;
    expect(o).toMatchObject({ base: 'MDL', validFor: '2026-09-28' });
    expect(o!.rates.USD).toBe(17.7406);
    expect(o!.rates.EUR).toBe(20.2207);
  });
  it('ПРБ: курс на следующий день, номинал учтён', () => {
    const [o] = outputs.get('prb')!.out.official!;
    expect(o).toMatchObject({ base: 'RUP', validFor: '2026-09-29' });
    expect(o!.rates.USD).toBe(16.1);
    expect(o!.rates.MDL).toBe(0.9068);
    expect(o!.rates.CNY).toBeCloseTo(23.9291 / 10, 10);
  });
});

describe('банки ПМР', () => {
  it('Агропромбанк: коммерческий курс и APB Online с кросс-парами из HTML', () => {
    expect(find('agroprombank', 'commercial', 'USD', 'RUP')).toMatchObject({ buy: 16.1, sell: 16.5, validFrom: '2026-09-28' });
    expect(find('agroprombank', 'commercial', 'MDL', 'RUP')).toMatchObject({ buy: 0.8806, sell: 0.9763 });
    expect(find('agroprombank', 'apb-online', 'USD', 'MDL')).toMatchObject({ buy: 16.5, sell: 18.5 });
    expect(find('agroprombank', 'apb-online', 'EUR', 'USD')).toMatchObject({ buy: 1.12, sell: 1.16 });
    expect(quotesOf('agroprombank').filter((q) => q.table === 'apb-online')).toHaveLength(9);
  });
  it('Приднестровский Сбербанк: наличные и коммерческий курс из API', () => {
    expect(find('prisbank', 'cash', 'USD', 'RUP')).toMatchObject({ buy: 16.3, sell: 16.35, nominal: 1 });
    expect(find('prisbank', 'commercial-individuals', 'MDL', 'RUP')).toMatchObject({ buy: 0.9, sell: 0.96 });
  });
  it('Эксимбанк ПМР: отделения и интернет-банк', () => {
    expect(find('bankexim-pmr', 'branches', 'USD', 'RUP')).toMatchObject({ buy: 16.3, sell: 16.35 });
    expect(find('bankexim-pmr', 'internet-bank', 'EUR', 'RUP')).toMatchObject({ buy: 18.3, sell: 19.1 });
    expect(find('bankexim-pmr', 'branches', 'MDL', 'RUP')).toMatchObject({ buy: 0.9, sell: 0.95 });
  });
});

describe('банки Молдовы', () => {
  it('maib: наличные в отделениях (не таможня) и карта с датой', () => {
    expect(find('maib', 'cash-branches', 'USD')).toMatchObject({ buy: 17.62, sell: 17.82 });
    expect(find('maib', 'card', 'USD')).toMatchObject({ buy: 17.512, sell: 17.9694, validFrom: '2026-09-28' });
    // RUB в таблице «-» — котировки нет.
    expect(find('maib', 'cash-branches', 'RUB')).toBeUndefined();
  });
  it('MICB: наличные и карты; «–» — нет данных', () => {
    expect(find('micb', 'cash', 'USD')).toMatchObject({ buy: 17.63, sell: 17.82 });
    expect(find('micb', 'card', 'EUR')).toMatchObject({ buy: 20.05, sell: 20.55 });
    expect(find('micb', 'cash', 'RUB')).toMatchObject({ buy: null, sell: null });
  });
  it('Victoriabank: последняя запись дня, отделение для наличных, время в UTC', () => {
    expect(find('victoriabank', 'cash', 'USD', 'MDL', 'sucursala-nr-3')).toMatchObject({
      buy: 17.6,
      sell: 17.88,
      validFrom: '2026-09-28T06:00:00.000Z',
    });
    expect(find('victoriabank', 'online', 'USD')).toMatchObject({ buy: 17.58, sell: 17.88, validFrom: '2026-09-28T13:13:00.000Z' });
    expect(outputs.get('victoriabank')!.out.branches).toEqual([{ id: 'sucursala-nr-3', name: 'Sucursala nr.3' }]);
  });
  it('OTP: вкладки «În sucursale» и «Carduri» по подписям', () => {
    expect(find('otpbank', 'branches', 'USD')).toMatchObject({ buy: 17.64, sell: 17.82, validFrom: '2026-09-28' });
    expect(find('otpbank', 'card', 'RUB')).toMatchObject({ buy: 0.181, sell: 0.232 });
    expect(find('otpbank', 'branches', 'RUB')).toBeUndefined(); // 0.0000 — нет данных
  });
  it('ProCredit: наличные и карта', () => {
    expect(find('procreditbank', 'cash', 'USD')).toMatchObject({ buy: 17.62, sell: 17.82, validFrom: '2026-09-28' });
    expect(find('procreditbank', 'card', 'USD')).toMatchObject({ buy: 17.47, sell: 17.97 });
  });
  it('EuroCreditBank: наличные, карты и все агентства из data-unit-*', () => {
    expect(find('eurocreditbank', 'cash', 'USD')).toMatchObject({ buy: 17.6, sell: 17.79 });
    expect(find('eurocreditbank', 'card', 'USD')).toMatchObject({ buy: 17.52, sell: 17.93 });
    // Агентство 28 (Бэлць) — свой курс покупки.
    expect(find('eurocreditbank', 'agencies', 'USD', 'MDL', '28')).toMatchObject({ buy: 17.54, sell: 17.79 });
    expect(outputs.get('eurocreditbank')!.out.branches).toHaveLength(18);
  });
  it('Comerțbank: вкладки COMERTBANK и CARD', () => {
    expect(find('comertbank', 'comertbank', 'USD')).toMatchObject({ buy: 17.6, sell: 17.74, validFrom: '2026-09-28' });
    expect(find('comertbank', 'card', 'EUR')).toMatchObject({ buy: 20, sell: 20.4 });
  });
  it('Eximbank МД: кассы и карта; нулевые курсы отброшены', () => {
    expect(find('eximbank-md', 'cashdesk', 'USD')).toMatchObject({ buy: 17.64, sell: 17.8, validFrom: '2026-09-28' });
    expect(find('eximbank-md', 'card', 'USD')).toMatchObject({ buy: 17.58, sell: 17.86 });
    expect(find('eximbank-md', 'cashdesk', 'UAH')).toBeUndefined();
  });
  it('FinComBank: курсы каждого отделения и карточный курс на следующий день', () => {
    const cash = quotesOf('fincombank').filter((q) => q.table === 'cash-branch');
    const branches = outputs.get('fincombank')!.out.branches!;
    expect(branches.length).toBeGreaterThan(50);
    // Два отделения в Дрокии курсы не публикуют — их нет ни в списке, ни в котировках.
    expect(branches.map((b) => b.id)).not.toContain('1269453194');
    expect(cash.some((q) => q.branch === '6888746848')).toBe(false);
    expect(new Set(cash.map((q) => q.branch)).size).toBe(branches.length);
    expect(find('fincombank', 'cash-branch', 'USD', 'MDL', '12846450')).toMatchObject({ buy: 17.63, sell: 17.79 });
    expect(find('fincombank', 'cash-branch', 'USD', 'MDL', '11041234')).toMatchObject({ buy: 17.63, sell: 17.8 });
    expect(find('fincombank', 'card', 'USD')).toMatchObject({ buy: 17.48, sell: 17.96, validFrom: '2026-09-29' });
  });
});

describe('декларативный адаптер html-tables', () => {
  const page = (html: string): HttpClient => {
    const res = (): HttpResponse => ({ url: 'https://t.md/', status: 200, headers: new Headers(), text: html, fetchedAt: '2026-09-28T10:00:00.000Z' });
    return { request: async () => res(), getText: async () => res(), getJson: async () => jsonFrom(res()) };
  };
  const source = (params: unknown): SourceDef => ({
    id: 't',
    name: 't',
    jurisdiction: 'MD',
    kind: 'bank',
    website: 'https://t.md/',
    ratesUrl: 'https://t.md/',
    collect: 'auto',
    adapter: 'html-tables',
    params: params as Record<string, unknown>,
  });
  const html = `<div><h3>Numerar în sucursale</h3><table><tr><th>valuta</th><th>buy</th><th>sell</th></tr>
    <tr><td>USD</td><td>17.62</td><td>17.82</td></tr><tr><td>RUB</td><td>-</td><td>-</td></tr></table></div>`;
  const run = (params: unknown) =>
    htmlTablesAdapter({ source: source(params), http: page(html), now: () => new Date(), log: () => {} });
  const base = { url: 'https://t.md/', quote: 'MDL' };
  const cols = { code: 0, buy: 1, sell: 2 };

  it('находит таблицу по заголовку и пропускает «-»', async () => {
    const out = await run({ ...base, tables: [{ table: 'cash', locate: { heading: 'Numerar' }, columns: cols }] });
    expect(out.batches![0]!.quotes).toEqual([{ table: 'cash', base: 'USD', quote: 'MDL', nominal: 1, buy: 17.62, sell: 17.82 }]);
    expect(out.warnings).toBeUndefined();
  });
  it('селектор попал не в ту таблицу — предупреждение, котировок нет', async () => {
    const out = await run({ ...base, tables: [{ table: 'card', locate: { selector: 'table' }, expect: 'card', columns: cols }] });
    expect(out.batches![0]!.quotes).toEqual([]);
    expect(out.warnings).toEqual([expect.stringMatching(/подпись не совпала/)]);
  });
  it('таблица не найдена — предупреждение', async () => {
    const out = await run({ ...base, tables: [{ table: 'x', locate: { heading: 'Carduri' }, columns: cols }] });
    expect(out.warnings).toEqual([expect.stringMatching(/не найдена/)]);
  });
});

describe('рубль ПМР (RUP) и российский рубль (RUB) не смешиваются', () => {
  const quotesBy = (j: 'MD' | 'PMR') =>
    cfg.sources.filter((s) => s.kind === 'bank' && s.collect === 'auto' && s.jurisdiction === j).flatMap((s) => quotesOf(s.id));

  it('в банках Молдовы нет котировок рубля ПМР', () => {
    expect(quotesBy('MD').filter((q) => q.base === 'RUP' || q.quote === 'RUP')).toEqual([]);
  });

  it('в банках ПМР все цены — в рублях ПМР; RUB котируется к RUP как российский рубль', () => {
    const pmr = quotesBy('PMR');
    expect(pmr.every((q) => q.quote === 'RUP' || q.base !== 'RUP')).toBe(true);
    const prbRub = outputs.get('prb')!.out.official![0]!.rates.RUB!;
    const rub = pmr.filter((q) => q.base === 'RUB');
    expect(rub.length).toBeGreaterThanOrEqual(3); // Агропромбанк, Сбербанк ПМР, Эксимбанк ПМР
    for (const q of rub) {
      expect(q.quote).toBe('RUP');
      // Около официального курса российского рубля у ПРБ (~0.19), а не ~1 (как было бы при путанице).
      for (const p of [q.buy, q.sell]) expect(Math.abs(p! / prbRub - 1)).toBeLessThan(0.15);
    }
  });

  it('в банках Молдовы RUB — российский рубль (около курса BNM)', () => {
    const bnmRub = outputs.get('bnm')!.out.official![0]!.rates.RUB!;
    for (const q of quotesBy('MD').filter((x) => x.base === 'RUB' && x.buy)) {
      expect(Math.abs(q.buy! / bnmRub - 1)).toBeLessThan(0.2);
    }
  });

  it('официальные курсы: RUB у обоих нацбанков — российский рубль, RUP — база ПРБ', () => {
    const [prb] = outputs.get('prb')!.out.official!;
    expect(prb!.base).toBe('RUP');
    expect(prb!.rates.RUP).toBeUndefined();
    expect(outputs.get('bnm')!.out.official![0]!.rates.RUP).toBeUndefined();
  });
});
