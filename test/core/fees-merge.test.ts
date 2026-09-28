import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyFee, convertStep, matchingFeeRules } from '../../src/core/fees';
import { freshness } from '../../src/core/freshness';
import { nodeKey, offerFromNode, offerToNode } from '../../src/core/graph';
import { manualOffers } from '../../src/core/manual';
import { applyRegistry, emptyRates, mergeRates } from '../../src/core/merge';
import { buildOffers } from '../../src/core/offers';
import { feesConfigSchema, manualDataSchema } from '../../src/core/schema';
import type { FeeRule, Offer, RatesFile, SourceDef } from '../../src/core/types';
import { officials, plausibility, ROOT } from '../helpers';

const feeRules = feesConfigSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/fees.json'), 'utf8')))
  .rules as FeeRule[];

describe('комиссии', () => {
  it('deduct: процент и фикс удерживаются из суммы', () => {
    expect(applyFee(1000, { percent: 1, fixed: 5 })).toEqual({ net: 985, fee: 15 });
  });
  it('deduct: минимальная и максимальная комиссия', () => {
    expect(applyFee(100, { percent: 1, minFee: 10 })).toEqual({ net: 90, fee: 10 });
    expect(applyFee(100000, { percent: 1, maxFee: 50 })).toEqual({ net: 99950, fee: 50 });
  });
  it('onTop: сбор 0,1% сверху — из 10010 лей на обмен уходит 10000', () => {
    const r = applyFee(10010, { percent: 0.1, mode: 'onTop' })!;
    expect(r.net).toBeCloseTo(10000, 9);
    expect(r.fee).toBeCloseTo(10, 9);
  });
  it('onTop с минимальной комиссией', () => {
    const r = applyFee(1000, { percent: 0.1, minFee: 5, mode: 'onTop' })!;
    expect(r.net).toBe(995);
  });
  it('суммы не хватает на комиссию → null', () => {
    expect(applyFee(5, { fixed: 10 })).toBeNull();
  });

  it('правило 0,1% МД: только покупка валюты за леи наличными в МД', () => {
    const ctx = { jurisdiction: 'MD' as const, channel: 'cash' as const, from: 'MDL', to: 'USD', source: 'maib' };
    expect(matchingFeeRules(ctx, feeRules).map((r) => r.id)).toEqual(['md-cash-fx-purchase-0.1']);
    expect(matchingFeeRules({ ...ctx, from: 'USD', to: 'MDL' }, feeRules)).toEqual([]);
    expect(matchingFeeRules({ ...ctx, channel: 'card' }, feeRules)).toEqual([]);
    expect(matchingFeeRules({ ...ctx, jurisdiction: 'PMR' }, feeRules)).toEqual([]);
  });

  it('кросс-обмен EUR→USD наличными в МД: применяется непроверенное правило 0,1%', () => {
    const ctx = { jurisdiction: 'MD' as const, channel: 'cash' as const, from: 'EUR', to: 'USD', source: 'maib' };
    const rules = matchingFeeRules(ctx, feeRules);
    expect(rules.map((r) => [r.id, r.verified])).toEqual([['md-cash-fx-cross-0.1-unverified', false]]);
  });

  it('шаг обмена: 10010 MDL → USD по 17.82 со сбором 0,1%', () => {
    const r = convertStep(10010, 1 / 17.82, [{ label: 'сбор 0,1%', fee: { percent: 0.1, mode: 'onTop' } }])!;
    expect(r.out).toBeCloseTo(10000 / 17.82, 9);
    expect(r.fees[0]!.amount).toBeCloseTo(10, 9);
  });
  it('шаг обмена: ограничения суммы', () => {
    expect(convertStep(50, 2, [], { minAmount: 100 })).toBeNull();
    expect(convertStep(500, 2, [], { maxAmount: 100 })).toBeNull();
    expect(convertStep(100, 2, [])).toEqual({ out: 200, fees: [] });
  });
});

const src = (id: string): SourceDef => ({
  id,
  name: id,
  jurisdiction: 'MD',
  kind: 'bank',
  website: 'https://x.md/',
  ratesUrl: 'https://x.md/',
  collect: 'auto',
  adapter: id,
  tables: { cash: { label: 'Numerar', channel: 'cash', use: 'offer' } },
});

function fileWith(offers: Offer[], runner: string, at: string, extra: Partial<RatesFile> = {}): RatesFile {
  return {
    ...emptyRates(new Date(at)),
    runs: [{ runner, startedAt: at, finishedAt: at }],
    sources: [{ id: 'a', status: 'ok', lastAttemptAt: at, lastSuccessAt: at, runner, offers: offers.length, suspicious: 0 }],
    offers,
    ...extra,
  };
}

const offersAt = (fetchedAt: string, buy: number) =>
  buildOffers({
    source: src('a'),
    quotes: [{ table: 'cash', base: 'USD', quote: 'MDL', buy, sell: buy + 0.2 }],
    fetchedAt,
    sourceUrl: 'https://x.md/',
    officials,
    plausibility,
  }).offers;

describe('mergeRates', () => {
  const opts = { now: new Date('2026-09-28T12:00:00Z'), retainOffersDays: 14, retainOfficialDays: 10 };

  it('для каждого предложения берётся самое свежее, независимо от порядка', () => {
    const pc = fileWith(offersAt('2026-09-28T10:00:00Z', 17.6), 'local', '2026-09-28T10:00:00Z');
    const gha = fileWith(offersAt('2026-09-28T08:00:00Z', 17.5), 'github-actions', '2026-09-28T08:00:00Z');
    for (const m of [mergeRates(pc, gha, opts), mergeRates(gha, pc, opts)]) {
      expect(m.offers).toHaveLength(2);
      expect(m.offers.find((o) => o.from === 'USD')!.rate).toBe(17.6);
      expect(m.runs).toHaveLength(2);
      expect(m.generatedAt).toBe('2026-09-28T10:00:00.000Z');
    }
  });

  it('статус хранится по месту сбора: неудача GitHub не перебивает успех ПК', async () => {
    const { sourceHealth } = await import('../../src/core/merge');
    const { effectiveAt } = await import('../../src/core/validity');
    // ПК собрал успешно (старое имя места сбора «local» читается как «pc»).
    const ok = fileWith(offersAt('2026-09-28T08:00:00Z', 17.6), 'local', '2026-09-28T08:00:00Z');
    const failed = fileWith([], 'github-actions', '2026-09-28T10:00:00Z', {
      sources: [
        { id: 'a', status: 'robots-blocked', message: 'robots.txt недоступен (HTTP 503)', lastAttemptAt: '2026-09-28T10:00:00Z', runner: 'github-actions', offers: 0, suspicious: 0 },
      ],
    });
    for (const m of [mergeRates(ok, failed, opts), mergeRates(failed, ok, opts)]) {
      expect(m.sources.map((x) => [x.runner, x.status, x.lastSuccessAt ?? null])).toEqual([
        ['github-actions', 'robots-blocked', null],
        ['pc', 'ok', '2026-09-28T08:00:00Z'],
      ]);
      const h = sourceHealth(m.sources, 'a')!;
      expect(h.primary).toMatchObject({ runner: 'pc', status: 'ok' });
      expect(h.others).toEqual([expect.objectContaining({ runner: 'github-actions', status: 'robots-blocked' })]);
      // Курсы с ПК остаются и действуют — неудача в другом месте сбора их не трогает.
      expect(effectiveAt(m.offers, opts.now)).toHaveLength(2);
      expect(m.runs.map((r) => r.runner)).toEqual(['pc', 'github-actions']);
    }
  });

  it('старый формат: успех ПК, записанный в статус GitHub, очищается', () => {
    const legacy = fileWith(offersAt('2026-09-28T08:00:00Z', 17.6), 'local', '2026-09-28T08:00:00Z', {
      runs: [
        { runner: 'local', startedAt: '2026-09-28T08:00:00Z', finishedAt: '2026-09-28T08:05:00Z' },
        { runner: 'github-actions', startedAt: '2026-09-28T10:00:00Z', finishedAt: '2026-09-28T10:05:00Z' },
      ],
      sources: [
        { id: 'a', status: 'robots-blocked', lastAttemptAt: '2026-09-28T10:01:00Z', lastSuccessAt: '2026-09-28T08:01:00Z', runner: 'github-actions', offers: 0, suspicious: 0 },
      ],
    });
    const m = mergeRates(legacy, emptyRates(new Date(0)), opts);
    expect(m.sources[0]!.lastSuccessAt).toBeUndefined();
  });

  it('старые предложения и официальные курсы удаляются по сроку хранения', () => {
    const old = fileWith(offersAt('2026-09-01T08:00:00Z', 17.6), 'local', '2026-09-01T08:00:00Z', {
      official: [{ ...officials[0]!, validFor: '2026-09-01' }],
    });
    const m = mergeRates(old, emptyRates(opts.now), opts);
    expect(m.offers).toEqual([]);
    expect(m.official).toEqual([]);
  });

  it('официальные курсы: по источнику и дате берётся последний полученный', () => {
    const a = fileWith([], 'local', '2026-09-28T08:00:00Z', { official: [{ ...officials[0]!, fetchedAt: '2026-09-28T08:00:00Z' }] });
    const b = fileWith([], 'local', '2026-09-28T09:00:00Z', {
      official: [{ ...officials[0]!, fetchedAt: '2026-09-28T09:00:00Z', rates: { USD: 17.75 } }],
    });
    expect(mergeRates(a, b, opts).official).toEqual([expect.objectContaining({ rates: { USD: 17.75 } })]);
  });

  it('applyRegistry убирает источники manual-only, выпавшие таблицы и сменившийся канал', () => {
    const f = fileWith(offersAt('2026-09-28T10:00:00Z', 17.6), 'local', '2026-09-28T10:00:00Z');
    expect(applyRegistry(f, [src('a')]).offers).toHaveLength(2);
    expect(applyRegistry(f, [{ ...src('a'), collect: 'manual-only', manualReason: 'x' }]).offers).toEqual([]);
    expect(applyRegistry(f, [{ ...src('a'), tables: {} }]).offers).toEqual([]);
    expect(
      applyRegistry(f, [{ ...src('a'), tables: { cash: { label: 'x', channel: 'unknown', use: 'offer' } } }]).offers,
    ).toEqual([]);
    expect(applyRegistry(f, []).sources).toEqual([]);
    // Уверенность в канале берётся из текущего конфига.
    const assumed = applyRegistry(f, [
      { ...src('a'), tables: { cash: { label: 'x', channel: 'cash', channelConfidence: 'assumed', use: 'offer' } } },
    ]);
    expect(assumed.offers.every((o) => o.channelConfidence === 'assumed')).toBe(true);
  });
});

describe('свежесть и узлы графа', () => {
  it('устаревание по fetchedAt', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    expect(freshness({ fetchedAt: '2026-09-27T12:00:00Z' }, now, 36)).toMatchObject({ fetchedHoursAgo: 24, stale: false });
    expect(freshness({ fetchedAt: '2026-09-26T12:00:00Z' }, now, 36).stale).toBe(true);
  });

  it('наличные без счёта, карта/онлайн — на счёте банка', () => {
    const [cashOffer] = offersAt('2026-09-28T10:00:00Z', 17.6);
    expect(nodeKey(offerFromNode(cashOffer!))).toBe('USD:cash');
    const online = { ...cashOffer!, channel: 'online' as const };
    expect(nodeKey(offerToNode(online))).toBe('MDL:online@a');
  });
});

describe('ручные курсы', () => {
  const data = manualDataSchema.parse({
    schemaVersion: 1,
    exportedAt: '2026-09-28T12:00:00Z',
    points: [{ id: 'p1', name: 'Обменник на рынке', jurisdiction: 'PMR' }],
    quotes: [
      { id: 'q1', point: 'p1', base: 'USD', quote: 'RUP', buy: 16.0, sell: 16.4, channel: 'cash', enteredAt: '2026-09-28T08:00:00Z' },
      { id: 'q2', point: 'p1', base: 'USD', quote: 'RUP', buy: 16.2, sell: 16.45, channel: 'cash', enteredAt: '2026-09-28T11:00:00Z' },
      { id: 'q3', point: 'p1', base: 'MDL', quote: 'RUP', buy: 9.0, sell: 9.6, channel: 'cash', enteredAt: '2026-09-28T11:00:00Z' },
    ],
  });

  it('ручные курсы — origin=manual, fetchedAt=время ввода, действует последний ввод', () => {
    const offers = manualOffers(data, officials, plausibility);
    const usd = offers.filter((o) => o.published.base === 'USD');
    expect(usd).toHaveLength(2);
    expect(usd.every((o) => o.origin === 'manual' && o.fetchedAt === '2026-09-28T11:00:00Z')).toBe(true);
    expect(usd.find((o) => o.from === 'USD')!.rate).toBe(16.2);
    expect(usd[0]!.source).toBe('manual:p1');
  });

  it('опечатка при вводе ловится проверкой правдоподобности', () => {
    // MDL/RUP 9.0 вместо 0.90 — в 10 раз больше официального 0.9075.
    const mdl = manualOffers(data, officials, plausibility).filter((o) => o.published.base === 'MDL');
    expect(mdl.every((o) => o.status === 'suspicious')).toBe(true);
  });

  it('импорт без покупки и продажи отклоняется схемой', () => {
    const bad = { ...data, quotes: [{ id: 'x', point: 'p1', base: 'USD', quote: 'RUP', channel: 'cash', enteredAt: '2026-09-28T08:00:00Z' }] };
    expect(manualDataSchema.safeParse(bad).success).toBe(false);
  });
});

describe('версии курса: действующий и будущий', () => {
  const opts = { now: new Date('2026-09-28T17:00:00Z'), retainOffersDays: 14, retainOfficialDays: 10 };
  const card = (validFrom: string, fetchedAt: string, buy: number) =>
    offersAt(fetchedAt, buy).map((o) => ({ ...o, validFrom }));

  it('курс «с завтра» не затирает сегодняшний; оба хранятся', async () => {
    const { effectiveAt, upcomingAfter } = await import('../../src/core/validity');
    const today = fileWith(card('2026-09-28', '2026-09-28T08:00:00Z', 17.5), 'local', '2026-09-28T08:00:00Z');
    const tomorrow = fileWith(card('2026-09-29', '2026-09-28T16:30:00Z', 17.48), 'local', '2026-09-28T16:30:00Z');
    const m = mergeRates(today, tomorrow, opts);
    expect(m.offers).toHaveLength(4);
    const now = effectiveAt(m.offers, opts.now);
    expect(now.find((o) => o.from === 'USD')!.rate).toBe(17.5);
    expect(upcomingAfter(m.offers, opts.now).map((o) => o.validFrom)).toEqual(['2026-09-29', '2026-09-29']);
    // На 29.09 (полночь по Кишинёву = 21:00 UTC 28.09) действует новый.
    expect(effectiveAt(m.offers, new Date('2026-09-28T21:00:00Z')).find((o) => o.from === 'USD')!.rate).toBe(17.48);
  });

  it('когда будущий курс вступил в силу, старый удаляется', () => {
    const today = fileWith(card('2026-09-28', '2026-09-28T08:00:00Z', 17.5), 'local', '2026-09-28T08:00:00Z');
    const tomorrow = fileWith(card('2026-09-29', '2026-09-28T16:30:00Z', 17.48), 'local', '2026-09-28T16:30:00Z');
    const m = mergeRates(today, tomorrow, { ...opts, now: new Date('2026-09-29T08:00:00Z') });
    expect(m.offers.every((o) => o.validFrom === '2026-09-29')).toBe(true);
  });

  it('без validFrom — по-прежнему побеждает более позднее получение', () => {
    const a = fileWith(offersAt('2026-09-28T08:00:00Z', 17.5), 'local', '2026-09-28T08:00:00Z');
    const b = fileWith(offersAt('2026-09-28T09:00:00Z', 17.6), 'local', '2026-09-28T09:00:00Z');
    const m = mergeRates(a, b, opts);
    expect(m.offers).toHaveLength(2);
    expect(m.offers.find((o) => o.from === 'USD')!.rate).toBe(17.6);
  });

  it('несколько записей за день (Victoriabank): остаётся последняя вступившая в силу', () => {
    const early = fileWith(card('2026-09-28T06:00:00.000Z', '2026-09-28T07:00:00Z', 17.5), 'local', '2026-09-28T07:00:00Z');
    const late = fileWith(card('2026-09-28T13:13:00.000Z', '2026-09-28T14:00:00Z', 17.58), 'local', '2026-09-28T14:00:00Z');
    const m = mergeRates(early, late, opts);
    expect(m.offers).toHaveLength(2);
    expect(m.offers.find((o) => o.from === 'USD')!.rate).toBe(17.58);
  });
});
