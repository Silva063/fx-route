import type { Currency, OfficialRates } from './types';

export interface OfficialLookup {
  /** Сколько единиц quote стоит 1 единица base по официальному курсу. */
  value: number;
  source: string;
  validFor: string;
  /** false — курса на нужную дату нет, взят ближайший доступный. */
  exactDate: boolean;
}

function unitsOfBase(set: OfficialRates, cur: Currency): number | undefined {
  if (cur === set.base) return 1;
  const v = set.rates[cur];
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/**
 * Официальный курс base→quote на дату refDate (YYYY-MM-DD).
 * Приоритет набора: 1) базовая валюта набора совпадает с quote (прямой курс: USD/MDL → BNM, MDL/RUP → ПРБ);
 * 2) предпочитаемый источник по юрисдикции; 3) любой, где есть обе валюты (кросс).
 * По дате: последний курс, действующий на refDate; если такого нет — ближайший по дате.
 */
export function officialCross(
  base: Currency,
  quote: Currency,
  officials: readonly OfficialRates[],
  refDate: string,
  preferSource?: string,
): OfficialLookup | null {
  if (base === quote) return null;
  const candidates = officials.filter(
    (s) => unitsOfBase(s, base) !== undefined && unitsOfBase(s, quote) !== undefined,
  );
  if (candidates.length === 0) return null;

  const priority = (s: OfficialRates) => (s.base === quote ? 2 : s.source === preferSource ? 1 : 0);
  const onOrBefore = candidates.filter((s) => s.validFor <= refDate);
  let best: OfficialRates;
  if (onOrBefore.length > 0) {
    best = onOrBefore.reduce((a, b) =>
      priority(b) > priority(a) || (priority(b) === priority(a) && b.validFor > a.validFor) ? b : a,
    );
  } else {
    // Есть только курсы на будущие даты (например, ПРБ публикует курс на завтра).
    best = candidates.reduce((a, b) =>
      priority(b) > priority(a) || (priority(b) === priority(a) && b.validFor < a.validFor) ? b : a,
    );
  }
  const value = unitsOfBase(best, base)! / unitsOfBase(best, quote)!;
  return { value, source: best.source, validFor: best.validFor, exactDate: best.validFor === refDate };
}
