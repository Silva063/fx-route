import { hoursBetween } from './time';
import type { Offer } from './types';

export interface Freshness {
  /** Возраст по времени получения, часы. */
  fetchedHoursAgo: number;
  /** Возраст по времени действия из источника, часы (если источник его дал). */
  validHoursAgo?: number;
  stale: boolean;
}

/**
 * Устаревание считается по fetchedAt — когда курс последний раз подтверждён сбором.
 * validFrom показывается отдельно: банк мог не менять курс с пятницы, и это нормально.
 */
export function freshness(o: Pick<Offer, 'fetchedAt' | 'validFrom'>, now: Date, staleAfterHours: number): Freshness {
  const fetchedHoursAgo = hoursBetween(o.fetchedAt, now);
  const f: Freshness = { fetchedHoursAgo, stale: fetchedHoursAgo > staleAfterHours };
  if (o.validFrom) f.validHoursAgo = hoursBetween(o.validFrom, now);
  return f;
}
