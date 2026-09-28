import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OfficialRates, PlausibilitySettings, Settings } from '../src/core/types';

export const ROOT = join(import.meta.dirname, '..');

export const settings: Settings = JSON.parse(readFileSync(join(ROOT, 'config/settings.json'), 'utf8'));
export const plausibility: PlausibilitySettings = settings.plausibility;

/** Реальные официальные курсы на 28.09.2026 из разведки (BNM и ПРБ). */
export const officials: OfficialRates[] = [
  {
    source: 'bnm',
    base: 'MDL',
    validFor: '2026-09-28',
    fetchedAt: '2026-09-28T09:00:00.000Z',
    sourceUrl: 'https://www.bnm.md/',
    rates: { USD: 17.7406, EUR: 20.2207, RUB: 0.2104, UAH: 0.3962, RON: 3.8349 },
  },
  {
    source: 'prb',
    base: 'RUP',
    validFor: '2026-09-28',
    fetchedAt: '2026-09-27T12:00:00.000Z',
    sourceUrl: 'https://www.cbpmr.net/',
    rates: { USD: 16.1, EUR: 18.3508, RUB: 0.1875, MDL: 0.9075, UAH: 0.358 },
  },
];
