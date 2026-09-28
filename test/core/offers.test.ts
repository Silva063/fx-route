import { describe, expect, it } from 'vitest';
import { buildOffers, isRoutable } from '../../src/core/offers';
import { checkQuote } from '../../src/core/plausibility';
import type { RawQuote, SourceDef } from '../../src/core/types';
import { officials, plausibility } from '../helpers';

const source: Pick<SourceDef, 'id' | 'jurisdiction' | 'tables'> = {
  id: 'testbank',
  jurisdiction: 'MD',
  tables: {
    cash: { label: 'Numerar', channel: 'cash', use: 'offer' },
    mystery: { label: 'Без подписи', channel: 'unknown', use: 'offer' },
    branches: { label: 'В отделениях', channel: 'cash', channelConfidence: 'assumed', use: 'offer' },
    info: { label: 'Справка', channel: 'cash', use: 'reference' },
  },
};

const build = (quotes: RawQuote[]) =>
  buildOffers({
    source,
    quotes,
    fetchedAt: '2026-09-28T10:00:00.000Z',
    sourceUrl: 'https://example.md/curs',
    officials,
    plausibility,
  });

describe('buildOffers', () => {
  it('покупка и продажа → два направленных предложения', () => {
    const { offers, dropped } = build([{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.62, sell: 17.82 }]);
    expect(dropped).toEqual([]);
    expect(offers).toHaveLength(2);
    const sellUsd = offers.find((o) => o.from === 'USD')!;
    expect(sellUsd).toMatchObject({
      id: 'testbank|-|cash|USD>MDL',
      to: 'MDL',
      rate: 17.62,
      channel: 'cash',
      status: 'ok',
      origin: 'auto',
      published: { side: 'buy', price: 17.62, nominal: 1 },
    });
    const buyUsd = offers.find((o) => o.from === 'MDL')!;
    expect(buyUsd.rate).toBeCloseTo(1 / 17.82, 12);
    expect(buyUsd.published.side).toBe('sell');
    expect(offers.every(isRoutable)).toBe(true);
  });

  it('номинал учитывается', () => {
    const { offers } = build([{ table: 'cash', base: 'UAH', quote: 'MDL', nominal: 10, buy: 3.3, sell: 3.9 }]);
    expect(offers.find((o) => o.from === 'UAH')!.rate).toBeCloseTo(0.33, 12);
    expect(offers.find((o) => o.from === 'MDL')!.rate).toBeCloseTo(10 / 3.9, 12);
  });

  it('таблица вне белого списка отбрасывается', () => {
    const { offers, dropped } = build([{ table: 'credit', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    expect(offers).toEqual([]);
    expect(dropped[0]!.reason).toMatch(/белом списке/);
  });

  it('нет чисел — нет предложений; только одна сторона — одно предложение', () => {
    expect(build([{ table: 'cash', base: 'RUB', quote: 'MDL', buy: null, sell: null }]).offers).toEqual([]);
    const one = build([{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6 }]).offers;
    expect(one).toHaveLength(1);
    expect(one[0]!.from).toBe('USD');
  });

  it('канал unknown → справочный, в маршрут не идёт', () => {
    const { offers } = build([{ table: 'mystery', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    expect(offers.every((o) => o.status === 'reference' && !isRoutable(o))).toBe(true);
    expect(offers[0]!.issues!.some((i) => i.code === 'channel-unknown')).toBe(true);
  });

  it('подписанный канал → confirmed', () => {
    const { offers } = build([{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    expect(offers.every((o) => o.channelConfidence === 'confirmed' && !o.issues)).toBe(true);
  });

  it('предположенный канал → участвует в маршруте, но помечен «канал не подтверждён»', () => {
    const { offers } = build([{ table: 'branches', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    expect(offers.every((o) => o.status === 'ok' && isRoutable(o) && o.channelConfidence === 'assumed')).toBe(true);
    expect(offers[0]!.issues).toEqual([expect.objectContaining({ code: 'channel-assumed', blocking: false })]);
  });

  it('справочная таблица → reference', () => {
    const { offers } = build([{ table: 'info', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    expect(offers.every((o) => o.status === 'reference')).toBe(true);
  });

  it('неправдоподобный курс → suspicious и не маршрутизируется', () => {
    const { offers } = build([{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.9, sell: 17.8 }]);
    expect(offers.every((o) => o.status === 'suspicious' && !isRoutable(o))).toBe(true);
  });

  it('отделение и validFrom попадают в предложение и в id', () => {
    const { offers } = build([
      { table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8, branch: 'b12', validFrom: '2026-09-28T09:16:00' },
    ]);
    expect(offers[0]).toMatchObject({ id: 'testbank|b12|cash|USD>MDL', branch: 'b12', validFrom: '2026-09-28T09:16:00' });
  });

  it('дубликат в одном запуске не создаёт второе предложение', () => {
    const q: RawQuote = { table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 };
    const { offers, dropped } = build([q, q]);
    expect(offers).toHaveLength(2);
    expect(dropped).toHaveLength(2);
  });
});

describe('checkQuote — правдоподобность', () => {
  const ctx = (jurisdiction: 'MD' | 'PMR' = 'MD') => ({ jurisdiction, officials, refDate: '2026-09-28', settings: plausibility });
  const blocking = (q: RawQuote, j?: 'MD' | 'PMR') => checkQuote(q, ctx(j)).filter((i) => i.blocking).map((i) => i.code);

  it('реальные курсы 28.09.2026 проходят', () => {
    const real: [RawQuote, 'MD' | 'PMR'][] = [
      [{ table: 't', base: 'USD', quote: 'MDL', buy: 17.62, sell: 17.82 }, 'MD'], // maib
      [{ table: 't', base: 'UAH', quote: 'MDL', buy: 0.32, sell: 0.37 }, 'MD'], // OTP карты
      [{ table: 't', base: 'USD', quote: 'RUP', buy: 16.1, sell: 16.5 }, 'PMR'], // Агропромбанк
      [{ table: 't', base: 'EUR', quote: 'RUP', buy: 18.1447, sell: 19.2555 }, 'PMR'],
      [{ table: 't', base: 'MDL', quote: 'RUP', buy: 0.8806, sell: 0.9763 }, 'PMR'],
      [{ table: 't', base: 'RUB', quote: 'RUP', buy: 0.1767, sell: 0.2035 }, 'PMR'],
      [{ table: 't', base: 'USD', quote: 'MDL', buy: 16.5, sell: 18.5 }, 'PMR'], // APB Online USD/MDL
      [{ table: 't', base: 'USD', quote: 'RUB', buy: 83.5, sell: 106.5 }, 'PMR'], // APB Online USD/RUB
      [{ table: 't', base: 'EUR', quote: 'USD', buy: 1.12, sell: 1.16 }, 'PMR'],
    ];
    for (const [q, j] of real) expect(blocking(q, j), `${q.base}/${q.quote}`).toEqual([]);
  });

  it('покупка не ниже продажи', () => {
    expect(blocking({ table: 't', base: 'USD', quote: 'MDL', buy: 17.8, sell: 17.8 })).toContain('buy-not-below-sell');
  });

  it('слишком широкий спред', () => {
    expect(blocking({ table: 't', base: 'USD', quote: 'MDL', buy: 16.5, sell: 18.5 })).toEqual([
      'spread-too-wide',
    ]);
  });

  it('опечатка: курс сильно отличается от официального', () => {
    expect(blocking({ table: 't', base: 'USD', quote: 'MDL', buy: 1.762, sell: 1.782 })).toContain(
      'deviates-from-official',
    );
    expect(blocking({ table: 't', base: 'USD', quote: 'MDL', buy: 176.2 })).toContain('deviates-from-official');
  });

  it('нет официального курса — не блокирует, но отмечается', () => {
    const issues = checkQuote({ table: 't', base: 'GBP', quote: 'MDL', buy: 23.3, sell: 23.6 }, ctx());
    expect(issues).toEqual([expect.objectContaining({ code: 'no-official-reference', blocking: false })]);
  });
});

describe('пороги: переопределение «RUB» относится только к российскому рублю', () => {
  it('RUB/RUP и USD/RUB — свои пороги, RUP и MDL/RUP — нет', async () => {
    const { limitFor } = await import('../../src/core/plausibility');
    const s = plausibility.maxSpreadOverrides;
    expect(limitFor('PMR', 'RUB', 'RUP', plausibility.maxSpreadPercent, s)).toBe(30);
    expect(limitFor('PMR', 'USD', 'RUB', plausibility.maxSpreadPercent, s)).toBe(30);
    expect(limitFor('PMR', 'USD', 'RUP', plausibility.maxSpreadPercent, s)).toBe(plausibility.maxSpreadPercent);
    expect(limitFor('PMR', 'RUP', 'MDL', plausibility.maxSpreadPercent, s)).toBe(plausibility.maxSpreadPercent);
    expect(limitFor('PMR', 'MDL', 'RUP', plausibility.maxSpreadPercent, s)).toBe(15);
    // Ни один ключ переопределений не относится к рублю ПМР как к базовой валюте.
    for (const k of Object.keys({ ...s, ...plausibility.maxOfficialDeviationOverrides })) {
      expect(k.replace(/^(MD|PMR):/, '').split('/')[0]).not.toBe('RUP');
    }
  });
});
