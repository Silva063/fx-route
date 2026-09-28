import { buildOffers } from './offers';
import type { ManualData } from './schema';
import { CHANNELS } from './types';
import type { OfficialRates, Offer, PlausibilitySettings, TableDef } from './types';

/** Префикс id ручных пунктов, чтобы они не пересекались с автоматическими источниками. */
export const MANUAL_PREFIX = 'manual:';

const manualTables: Record<string, TableDef> = Object.fromEntries(
  CHANNELS.map((c) => [`manual-${c}`, { label: `Ручной ввод (${c})`, channel: c, use: 'offer' as const }]),
);

/**
 * Ручные курсы пунктов обмена → предложения. Проходят те же проверки правдоподобности,
 * что и автоматические (ловят опечатки при вводе), и помечены origin=manual.
 * fetchedAt = момент ввода.
 */
export function manualOffers(
  data: ManualData,
  officials: readonly OfficialRates[],
  plausibility: PlausibilitySettings,
): Offer[] {
  const out: Offer[] = [];
  for (const p of data.points) {
    for (const q of data.quotes.filter((x) => x.point === p.id)) {
      const { offers } = buildOffers({
        source: { id: MANUAL_PREFIX + p.id, jurisdiction: p.jurisdiction, tables: manualTables },
        quotes: [
          {
            table: `manual-${q.channel}`,
            base: q.base,
            quote: q.quote,
            nominal: q.nominal ?? 1,
            buy: q.buy ?? null,
            sell: q.sell ?? null,
          },
        ],
        fetchedAt: q.enteredAt,
        sourceUrl: '',
        officials,
        plausibility,
        origin: 'manual',
      });
      out.push(...offers);
    }
  }
  // Повторный ввод той же пары в том же пункте: действует самый поздний.
  const latest = new Map<string, Offer>();
  for (const o of out) {
    const prev = latest.get(o.id);
    if (!prev || o.fetchedAt > prev.fetchedAt) latest.set(o.id, o);
  }
  return [...latest.values()];
}
