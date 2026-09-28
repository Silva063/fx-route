import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type ProjectConfig } from '../../src/collector/config';
import { findRoutes, type Route, type RouteContext, type RouteQuery } from '../../src/core/routes';
import { ratesFileSchema } from '../../src/core/schema';
import type { Channel, RatesFile } from '../../src/core/types';
import { ROOT } from '../helpers';

/**
 * Отсечение «K лучших различных курсов на пару узлов» не должно менять результат:
 * на реальном rates.json (сбор 28.09.2026) топ маршрутов с отсечением совпадает с полным перебором.
 */

let cfg: ProjectConfig;
let rates: RatesFile;
let now: Date;

beforeAll(async () => {
  cfg = await loadConfig(join(ROOT, 'config'));
  rates = ratesFileSchema.parse(JSON.parse(readFileSync(join(ROOT, 'test/fixtures/rates-2026-09-28.json'), 'utf8'))) as RatesFile;
  now = new Date(rates.generatedAt);
});

const ctx = (perPairLimit: number): RouteContext => ({
  offers: rates.offers,
  sources: Object.fromEntries(cfg.sources.map((s) => [s.id, { name: s.name, jurisdiction: s.jurisdiction }])),
  feeRules: cfg.fees,
  transitions: cfg.transitions,
  settings: { ...cfg.settings, routing: { ...cfg.settings.routing, perPairLimit } },
});

/** Итог маршрута без названий банков: суммы, остатки, цепочка узлов. */
const outcome = (r: Route) =>
  [
    r.amountOut.toFixed(2),
    r.leftovers.map((l) => `${l.amount.toFixed(2)} ${l.currency}`).sort().join(','),
    r.steps.map((s) => `${s.from.currency}:${s.from.channel}>${s.to.currency}:${s.to.channel}`).join(' '),
  ].join(' | ');

const pairs: [string, string][] = [
  ['RUP', 'MDL'],
  ['MDL', 'RUP'],
  ['RUP', 'USD'],
  ['USD', 'RUP'],
  ['RUP', 'EUR'],
  ['EUR', 'MDL'],
  ['USD', 'MDL'],
  ['MDL', 'EUR'],
];

describe('отсечение по паре = полный перебор (реальные курсы 28.09.2026)', () => {
  const allAccounts = () => cfg.sources.map((s) => s.id);
  const cases: { name: string; q: () => Omit<RouteQuery, 'amount' | 'from' | 'to'>; from: Channel; to: Channel[] }[] = [
    { name: 'наличные, все отделения', from: 'cash', to: ['cash'], q: () => ({ allowedChannels: ['cash'], myAccounts: [], branchMode: 'all', myBranches: [] }) },
    {
      name: 'все каналы и все счета',
      from: 'cash',
      to: ['cash', 'card', 'online'],
      q: () => ({ allowedChannels: ['cash', 'card', 'online'], myAccounts: allAccounts(), branchMode: 'all', myBranches: [] }),
    },
    {
      name: 'только мои отделения (два), карта maib',
      from: 'cash',
      to: ['cash', 'card'],
      q: () => ({
        allowedChannels: ['cash', 'card'],
        myAccounts: ['maib'],
        branchMode: 'mine',
        myBranches: ['fincombank|11041234', 'eurocreditbank|28'],
      }),
    },
  ];

  for (const c of cases) {
    for (const topN of [5, 15]) {
      it(`${c.name}, топ-${topN}`, { timeout: 120_000 }, () => {
        let compared = 0;
        for (const [from, to] of pairs) {
          for (const amount of [100, 10_000, 1_000_000]) {
            for (const at of [undefined, new Date(now.getTime() + 20 * 3_600_000)]) {
              const q: RouteQuery = { ...c.q(), amount, from: { currency: from, channel: c.from }, to: { currency: to, channels: c.to }, now, topN, ...(at ? { at } : {}) };
              const pruned = findRoutes(q, ctx(cfg.settings.routing.perPairLimit)).routes.map(outcome);
              const full = findRoutes(q, ctx(1_000_000)).routes.map(outcome);
              expect(pruned, `${from}→${to} ${amount} ${at ? 'завтра' : 'сейчас'}`).toEqual(full);
              compared += full.length;
            }
          }
        }
        expect(compared).toBeGreaterThan(50); // сравнение не пустое
      });
    }
  }
});
