import { zonedLocalToIso } from './time';
import type { Offer } from './types';

/**
 * Момент, с которого курс действует (ISO UTC).
 * validFrom-дата («2026-09-29») — с полуночи по Кишинёву; дата-время — как есть;
 * без validFrom — с момента получения.
 */
export function effectiveFrom(o: Pick<Offer, 'validFrom' | 'fetchedAt'>): string {
  const v = o.validFrom;
  if (!v) return new Date(o.fetchedAt).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return zonedLocalToIso(`${v}T00:00`) ?? new Date(o.fetchedAt).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(o.fetchedAt).toISOString() : d.toISOString();
}

/** Ключ версии курса: одно предложение может иметь действующую и будущую версии. */
export const versionKey = (o: Pick<Offer, 'id' | 'validFrom'>) => `${o.id}@${o.validFrom ?? ''}`;

/**
 * Версии, действующие на момент `at`: для каждого предложения — последняя с effectiveFrom ≤ at.
 * При равенстве — полученная позже.
 */
export function effectiveAt(offers: readonly Offer[], at: Date): Offer[] {
  const iso = at.toISOString();
  const best = new Map<string, { o: Offer; from: string }>();
  for (const o of offers) {
    const from = effectiveFrom(o);
    if (from > iso) continue;
    const prev = best.get(o.id);
    if (!prev || from > prev.from || (from === prev.from && o.fetchedAt > prev.o.fetchedAt)) best.set(o.id, { o, from });
  }
  return [...best.values()].map((x) => x.o);
}

/** Версии, которые начнут действовать после `at`. */
export function upcomingAfter(offers: readonly Offer[], at: Date): Offer[] {
  const iso = at.toISOString();
  return offers.filter((o) => effectiveFrom(o) > iso);
}
