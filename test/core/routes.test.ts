import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOffers } from '../../src/core/offers';
import { findRoutes, type RouteContext, type RouteQuery } from '../../src/core/routes';
import { feesConfigSchema } from '../../src/core/schema';
import type { FeeRule, Jurisdiction, Offer, RawQuote, TableDef, Transition } from '../../src/core/types';
import { officials, plausibility, ROOT, settings } from '../helpers';

const feeRules = feesConfigSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/fees.json'), 'utf8'))).rules as FeeRule[];
const NOW = new Date('2026-09-28T12:00:00Z');
const FETCHED = '2026-09-28T09:00:00.000Z';

const tables: Record<string, TableDef> = {
  cash: { label: 'Наличные', channel: 'cash', use: 'offer' },
  branches: { label: 'В отделениях', channel: 'cash', channelConfidence: 'assumed', use: 'offer' },
  card: { label: 'Карта', channel: 'card', use: 'offer' },
  online: { label: 'Онлайн', channel: 'online', use: 'offer' },
};

function offers(id: string, jurisdiction: Jurisdiction, quotes: RawQuote[], fetchedAt = FETCHED): Offer[] {
  return buildOffers({ source: { id, jurisdiction, tables }, quotes, fetchedAt, sourceUrl: `https://${id}/`, officials, plausibility }).offers;
}

const sources: RouteContext['sources'] = {
  pmrbank: { name: 'Банк ПМР', jurisdiction: 'PMR' },
  pmrexim: { name: 'Эксим ПМР', jurisdiction: 'PMR' },
  mdbank: { name: 'Банк МД', jurisdiction: 'MD' },
  mdcard: { name: 'Карточный банк МД', jurisdiction: 'MD' },
  fcb: { name: 'Банк с отделениями', jurisdiction: 'MD' },
};

const base = [
  ...offers('pmrbank', 'PMR', [
    { table: 'cash', base: 'MDL', quote: 'RUP', buy: 0.9, sell: 0.96 },
    { table: 'cash', base: 'USD', quote: 'RUP', buy: 16.3, sell: 16.35 },
  ]),
  ...offers('mdbank', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.62, sell: 17.82 }]),
];

const ctx = (offersList: Offer[], transitions: Transition[] = []): RouteContext => ({
  offers: offersList,
  sources,
  branchNames: { 'fcb|b1': 'Отделение 1', 'fcb|b2': 'Отделение 2', 'fcb|b3': 'Отделение 3' },
  feeRules,
  transitions,
  settings,
});

const query = (over: Partial<RouteQuery> = {}): RouteQuery => ({
  amount: 10000,
  from: { currency: 'RUP', channel: 'cash' },
  to: { currency: 'MDL', channels: ['cash'] },
  allowedChannels: ['cash', 'card', 'online'],
  myAccounts: [],
  branchMode: 'all',
  myBranches: [],
  now: NOW,
  ...over,
});

describe('findRoutes: наличные RUP → MDL', () => {
  const r = findRoutes(query(), ctx(base));

  it('через USD выгоднее, чем напрямую; суммы с округлением до целых', () => {
    expect(r.routes.map((x) => x.steps.map((s) => `${s.source}:${s.from.currency}>${s.to.currency}`).join(' '))).toEqual([
      'pmrbank:RUP>USD mdbank:USD>MDL',
      'pmrbank:RUP>MDL',
    ]);
    const [viaUsd, direct] = r.routes;
    // 10000 / 16.35 = 611.62 → выдано 611 USD, остаток 10000 − 611·16.35 = 10.15 RUP.
    expect(viaUsd!.steps[0]!.amountOut).toBe(611);
    expect(viaUsd!.steps[0]!.leftover!.currency).toBe('RUP');
    expect(viaUsd!.steps[0]!.leftover!.amount).toBeCloseTo(10.15, 6);
    // 611 · 17.62 = 10765.82 → 10765 MDL.
    expect(viaUsd!.amountOut).toBe(10765);
    // Остаток 611 − 10765/17.62 = 0.0465 USD округляется вниз до центов: 0.04 USD.
    expect(viaUsd!.leftovers.find((l) => l.currency === 'USD')!.amount).toBe(0.04);
    expect(viaUsd!.flags).toContain('minor-rounding-unverified');
    // 10000 / 0.96 = 10416.67 → 10416 MDL, остаток 0.64 RUP.
    expect(direct!.amountOut).toBe(10416);
    expect(direct!.leftovers[0]!.amount).toBe(0.64);
  });

  it('округление помечено «не проверено»; у шагов есть банк, курс, возраст', () => {
    expect(r.routes[0]!.flags).toContain('rounding-unverified');
    const s = r.routes[0]!.steps[1]!;
    expect(s).toMatchObject({ sourceName: 'Банк МД', rate: 17.62, fetchedAt: FETCHED, ageHours: 3 });
  });
});

describe('findRoutes: комиссии и пометки', () => {
  it('сбор 0,1% при покупке валюты за леи наличными в МД', () => {
    const r = findRoutes(query({ amount: 10010, from: { currency: 'MDL', channel: 'cash' }, to: { currency: 'USD', channels: ['cash'] } }), ctx(base));
    const s = r.routes[0]!.steps[0]!;
    // 10010 MDL: на обмен идёт ≈ 561 USD · 17.82 = 9997.02, сбор 0,1% ≈ 10.00, остаток ≈ 2.98 MDL.
    expect(s.amountOut).toBe(561);
    expect(s.fees[0]).toMatchObject({ currency: 'MDL', verified: true });
    expect(s.fees[0]!.amount).toBeCloseTo(9997.02 * 0.001, 6);
    // 10010 − 9997.02·1.001 = 2.98298 → 2.98 MDL (до бани, вниз).
    expect(s.leftover!.amount).toBe(2.98);
    expect(s.flags).not.toContain('fee-unverified');
  });

  it('кросс-обмен наличных в МД — непроверенное правило 0,1%', () => {
    const cross = offers('mdbank', 'MD', [{ table: 'cash', base: 'EUR', quote: 'USD', buy: 1.12, sell: 1.18 }]);
    const r = findRoutes(query({ amount: 1000, from: { currency: 'EUR', channel: 'cash' }, to: { currency: 'USD', channels: ['cash'] } }), ctx(cross));
    const s = r.routes[0]!.steps[0]!;
    expect(s.flags).toContain('fee-unverified');
    expect(s.fees).toEqual([expect.objectContaining({ verified: false, currency: 'EUR' })]);
  });

  it('предположенный канал помечается «канал не подтверждён»', () => {
    const assumed = offers('pmrexim', 'PMR', [{ table: 'branches', base: 'MDL', quote: 'RUP', buy: 0.9, sell: 0.95 }]);
    const r = findRoutes(query(), ctx([...base, ...assumed]));
    const direct = r.routes.find((x) => x.steps.length === 1 && x.steps[0]!.source === 'pmrexim')!;
    expect(direct.flags).toContain('channel-assumed');
  });
});

describe('findRoutes: мои счета, мои отделения, устаревшие курсы', () => {
  const card = offers('mdcard', 'MD', [{ table: 'card', base: 'USD', quote: 'MDL', buy: 17.9, sell: 18.0 }]);
  const withdraw: Transition = {
    id: 'mdcard-deposit',
    label: 'Внесение наличных на карту',
    currency: 'USD',
    from: { channel: 'cash' },
    to: { channel: 'card', account: 'mdcard' },
    fee: { percent: 1 },
  };
  const toCard: Transition = {
    id: 'mdcard-withdraw',
    label: 'Снятие с карты',
    currency: 'MDL',
    from: { channel: 'card', account: 'mdcard' },
    to: { channel: 'cash' },
  };

  it('карта чужого банка не используется; с «моей» картой — используется, с переходами', () => {
    const q = query({ amount: 1000, from: { currency: 'USD', channel: 'cash' } });
    const without = findRoutes(q, ctx([...base, ...card], [withdraw, toCard]));
    expect(without.routes.every((r) => r.steps.every((s) => s.source !== 'mdcard'))).toBe(true);
    expect(without.excluded.notMyAccount).toBe(2);

    const withCard = findRoutes({ ...q, myAccounts: ['mdcard'] }, ctx([...base, ...card], [withdraw, toCard]));
    const viaCard = withCard.routes.find((r) => r.steps.some((s) => s.source === 'mdcard'))!;
    expect(viaCard.steps.map((s) => s.kind)).toEqual(['transition', 'exchange', 'transition']);
    // 1000 USD − 1% = 990 USD на карте → 990 · 17.9 = 17721 MDL на карте (карта не округляется) → снятие.
    expect(viaCard.amountOut).toBeCloseTo(17721, 6);
    expect(viaCard.flags).toContain('transition-unverified');
  });

  it('отделения: по умолчанию только «мои», одинаковые курсы схлопываются', () => {
    const fcb = offers('fcb', 'MD', [
      { table: 'cash', base: 'USD', quote: 'MDL', buy: 17.7, sell: 17.9, branch: 'b1' },
      { table: 'cash', base: 'USD', quote: 'MDL', buy: 17.7, sell: 17.9, branch: 'b2' },
      { table: 'cash', base: 'USD', quote: 'MDL', buy: 17.65, sell: 17.9, branch: 'b3' },
    ]);
    const q = query({ amount: 100, from: { currency: 'USD', channel: 'cash' } });
    const mineOnly = findRoutes({ ...q, branchMode: 'mine', myBranches: ['fcb|b3'] }, ctx([...base, ...fcb]));
    expect(mineOnly.excluded.notMyBranch).toBe(4);
    expect(mineOnly.routes[0]!.steps[0]).toMatchObject({ source: 'fcb', branch: 'b3', branchName: 'Отделение 3' });

    const all = findRoutes(q, ctx([...base, ...fcb]));
    const best = all.routes[0]!.steps[0]!;
    expect(best.rate).toBe(17.7);
    expect([best.branch, ...best.alsoAtBranches!.map((b) => b.branch)].sort()).toEqual(['b1', 'b2']);
    // Одинаковые отделения — один маршрут, а не два.
    expect(all.routes.filter((r) => r.steps[0]!.source === 'fcb' && r.steps[0]!.rate === 17.7)).toHaveLength(1);
  });

  it('устаревшие курсы помечаются; по опции исключаются', () => {
    const old = offers('mdbank', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.62, sell: 17.82 }], '2026-09-25T09:00:00.000Z');
    const q = query({ amount: 100, from: { currency: 'USD', channel: 'cash' } });
    expect(findRoutes(q, ctx(old)).routes[0]!.flags).toContain('stale');
    const r = findRoutes({ ...q, excludeStale: true }, ctx(old));
    expect(r.routes).toEqual([]);
    expect(r.excluded.stale).toBe(2);
  });

  it('справочные и подозрительные курсы в маршрут не идут', () => {
    const bad = offers('mdbank', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 1.762, sell: 1.782 }]);
    const r = findRoutes(query({ amount: 100, from: { currency: 'USD', channel: 'cash' } }), ctx(bad));
    expect(r.routes).toEqual([]);
    expect(r.excluded.notRoutable).toBe(2);
  });
});

describe('findRoutes: время действия курса', () => {
  const today = offers('mdcard', 'MD', [{ table: 'card', base: 'USD', quote: 'MDL', buy: 17.5, sell: 17.9, validFrom: '2026-09-28' }]);
  const tomorrow = offers('mdcard', 'MD', [{ table: 'card', base: 'USD', quote: 'MDL', buy: 17.48, sell: 17.96, validFrom: '2026-09-29' }], '2026-09-28T16:00:00.000Z');
  const q = query({
    amount: 100,
    from: { currency: 'USD', channel: 'card', account: 'mdcard' },
    to: { currency: 'MDL', channels: ['card'] },
  });

  it('по умолчанию — действующий сейчас курс; будущий показывается отдельно с датой', () => {
    const r = findRoutes(q, ctx([...today, ...tomorrow]));
    expect(r.routes[0]!.steps[0]!.rate).toBe(17.5);
    expect(r.upcoming.map((o) => [o.from, o.validFrom])).toEqual([['USD', '2026-09-29']]);
  });

  it('расчёт на дату: берётся курс, действующий в этот момент', () => {
    const r = findRoutes({ ...q, at: new Date('2026-09-29T08:00:00Z') }, ctx([...today, ...tomorrow]));
    expect(r.routes[0]!.steps[0]!.rate).toBe(17.48);
    expect(r.upcoming).toEqual([]);
  });
});

describe('findRoutes: ограничения перебора', () => {
  it('не больше maxExchanges обменов и без циклов', () => {
    const r = findRoutes(query({ topN: 50 }), ctx(base));
    for (const route of r.routes) {
      expect(route.steps.filter((s) => s.kind === 'exchange').length).toBeLessThanOrEqual(settings.routing.maxExchanges);
      const nodes = route.steps.map((s) => `${s.to.currency}:${s.to.channel}`);
      expect(new Set(nodes).size).toBe(nodes.length);
    }
  });
  it('нулевая сумма — нет маршрутов', () => {
    expect(findRoutes(query({ amount: 0 }), ctx(base)).routes).toEqual([]);
  });
});

describe('findRoutes: одинаковые исходы объединяются', () => {
  it('два банка с одним курсом — один маршрут, второй банк в альтернативах; основной — без пометок', () => {
    const twin = offers('pmrexim', 'PMR', [{ table: 'branches', base: 'USD', quote: 'RUP', buy: 16.3, sell: 16.35 }]);
    const r = findRoutes(query({ topN: 10 }), ctx([...base, ...twin]));
    const viaUsd = r.routes.filter((x) => x.steps.length === 2);
    expect(viaUsd).toHaveLength(1);
    const first = viaUsd[0]!.steps[0]!;
    expect(first.source).toBe('pmrbank'); // подтверждённый канал важнее
    expect(first.alternatives).toEqual([expect.objectContaining({ source: 'pmrexim', flags: expect.arrayContaining(['channel-assumed']) })]);
    // Разные итоги остаются разными маршрутами.
    expect(r.routes.map((x) => x.amountOut)).toEqual([...new Set(r.routes.map((x) => x.amountOut))]);
  });
});

describe('findRoutes: порядок при равном итоге', () => {
  it('выше маршрут с большим остатком в исходной валюте', () => {
    // Оба банка дают 561 USD за 10000 MDL, но у первого курс продажи ниже — больше сдачи в MDL.
    const a = offers('mdbank', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.79 }]);
    const b = offers('fcb', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.8 }]);
    const r = findRoutes(query({ from: { currency: 'MDL', channel: 'cash' }, to: { currency: 'USD', channels: ['cash'] } }), ctx([...b, ...a]));
    expect(r.routes.map((x) => [x.amountOut, x.steps[0]!.source])).toEqual([
      [561, 'mdbank'],
      [561, 'fcb'],
    ]);
  });
});

describe('findRoutes: минимальная единица валюты', () => {
  const card = offers('mdcard', 'MD', [{ table: 'card', base: 'USD', quote: 'MDL', buy: 17.512, sell: 17.9694 }]);
  const q = query({
    amount: 100.37,
    from: { currency: 'USD', channel: 'card', account: 'mdcard' },
    to: { currency: 'MDL', channels: ['card'] },
  });

  it('безналичная сумма округляется вниз до бани, с пометкой «не проверено»', () => {
    const s = findRoutes(q, ctx(card)).routes[0]!.steps[0]!;
    // 100.37 · 17.512 = 1757.67944 → 1757.67 MDL.
    expect(s.amountOut).toBe(1757.67);
    expect(s.flags).toContain('minor-rounding-unverified');
  });

  it('если сумма уже в целых банях — без пометки', () => {
    const s = findRoutes({ ...q, amount: 100 }, ctx(card)).routes[0]!.steps[0]!;
    expect(s.amountOut).toBe(1751.2);
    expect(s.flags).not.toContain('minor-rounding-unverified');
  });

  it('остатков меньше минимальной единицы нет ни в одном маршруте', () => {
    const r = findRoutes(query({ topN: 50 }), ctx(base));
    for (const route of r.routes) for (const l of route.leftovers) expect(l.amount).toBeGreaterThanOrEqual(0.01);
  });

  it('floorTo устойчив к ошибкам плавающей точки', async () => {
    const { floorTo } = await import('../../src/core/routes');
    expect(floorTo(990 * 17.9, 0.01)).toBe(17721);
    expect(floorTo(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(floorTo(1757.67944, 0.01)).toBe(1757.67);
    expect(floorTo(10765.82, 1)).toBe(10765);
  });
});

describe('findRoutes: дата расчёта', () => {
  it('прошедшая дата не принимается — считается на «сейчас»', () => {
    const r = findRoutes(query({ at: new Date('2026-09-20T00:00:00Z') }), ctx(base));
    expect(r.at).toBe(NOW.toISOString());
    expect(r.routes.length).toBeGreaterThan(0);
  });
});

describe('findRoutes: отсечение по паре не теряет лучшие маршруты', () => {
  it('много банков с одинаковым курсом не вытесняют худший курс, дающий маршрут лучше показанных', () => {
    // На паре USD→MDL: 7 банков по 17.64 и один по 17.60. На паре RUP→USD: 16.35 и 16.5.
    const same = Array.from({ length: 7 }, (_, i) =>
      offers(`md${i}`, 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.64, sell: 17.9 }]),
    ).flat();
    const worse = offers('mdworse', 'MD', [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.6, sell: 17.9 }]);
    const pmr = [
      ...offers('pmrbank', 'PMR', [{ table: 'cash', base: 'USD', quote: 'RUP', buy: 16.3, sell: 16.35 }]),
      ...offers('pmrexim', 'PMR', [{ table: 'cash', base: 'USD', quote: 'RUP', buy: 16.2, sell: 16.5 }]),
    ];
    const r = findRoutes(query({ topN: 3 }), { ...ctx([...same, ...worse, ...pmr]), settings: { ...settings, routing: { ...settings.routing, perPairLimit: 1 } } });
    // 611 USD · 17.64 = 10778; 611 · 17.60 = 10753; 606 · 17.64 = 10689.
    expect(r.routes.map((x) => x.amountOut)).toEqual([10778, 10753, 10689]);
  });
});
