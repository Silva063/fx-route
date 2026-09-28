import { manualOffers } from '../../src/core/manual';
import type { ManualData } from '../../src/core/schema';
import type { Offer, RatesFile } from '../../src/core/types';
import type { PublicConfig } from './data';
import type { Prefs } from './db';

export interface AppState {
  config: PublicConfig;
  rates: RatesFile | null;
  ratesError?: string;
  prefs: Prefs;
  manual: ManualData;
  setPrefs: (p: Prefs) => void;
  setManual: (m: ManualData) => void;
  online: boolean;
}

/** Автоматические предложения + ручные (с проверками правдоподобности). */
export function allOffers(s: AppState): Offer[] {
  const auto = s.rates?.offers ?? [];
  const manual = manualOffers(s.manual, s.rates?.official ?? [], s.config.settings.plausibility);
  return [...auto, ...manual];
}

/** Название источника (включая ручные пункты вида manual:<id>). */
export function sourceName(s: AppState, id: string): string {
  if (id.startsWith('manual:')) {
    const p = s.manual.points.find((x) => `manual:${x.id}` === id);
    return p ? `${p.name} (вручную)` : 'Ручной пункт';
  }
  return s.config.sources.find((x) => x.id === id)?.name ?? id;
}

export function branchNames(s: AppState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [src, list] of Object.entries(s.rates?.branches ?? {})) for (const b of list) out[`${src}|${b.id}`] = b.name;
  return out;
}

/**
 * Город из названия отделения: «mun. Balti str. …», «or. Drochia …», «Sucursala nr.1 Chişinău - mun. Chişinău, …».
 * Если не распознан — «Другое».
 */
export function cityOf(name: string): string {
  const m = /\b(?:mun|or|s|com)\.\s*([A-ZĂÂÎȘȚŞŢ][\p{L}-]+(?:\s+(?:Noi|Vodă|Voda|Mare))?)/u.exec(name);
  if (!m) return 'Другое';
  return m[1]!
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^Chisinau$/i, 'Chișinău')
    .replace(/^Balti$/i, 'Bălți');
}

export function uid(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
