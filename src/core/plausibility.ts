import { officialCross } from './official';
import type { Issue, Jurisdiction, OfficialRates, PlausibilitySettings, RawQuote } from './types';

/**
 * Порог с учётом переопределений. Порядок поиска ключа:
 * "PMR:USD/MDL" → "PMR:USD" → "USD/MDL" → "USD" → значение по умолчанию.
 */
export function limitFor(
  jurisdiction: Jurisdiction,
  base: string,
  quote: string,
  dflt: number,
  overrides: Record<string, number> | undefined,
): number {
  const j = jurisdiction;
  return (
    overrides?.[`${j}:${base}/${quote}`] ??
    overrides?.[`${j}:${base}`] ??
    overrides?.[`${base}/${quote}`] ??
    overrides?.[base] ??
    dflt
  );
}

const fmt = (n: number) => Number(n.toPrecision(5)).toString();

/**
 * Проверки правдоподобности котировки. Проблема с blocking=true переводит
 * предложения в статус suspicious: они видны в интерфейсе, но в маршрут не идут.
 */
export function checkQuote(
  q: RawQuote,
  ctx: {
    jurisdiction: Jurisdiction;
    officials: readonly OfficialRates[];
    /** Дата, на которую сравниваем с официальным курсом (YYYY-MM-DD). */
    refDate: string;
    settings: PlausibilitySettings;
  },
): Issue[] {
  const issues: Issue[] = [];
  const { settings } = ctx;
  const nominal = q.nominal ?? 1;
  const buy = q.buy ?? null;
  const sell = q.sell ?? null;
  const pair = `${q.base}/${q.quote}`;

  if (buy !== null && sell !== null) {
    if (!(buy < sell)) {
      issues.push({
        code: 'buy-not-below-sell',
        blocking: true,
        message: `${pair}: покупка ${buy} не меньше продажи ${sell}`,
      });
    } else {
      const spread = ((sell - buy) / ((sell + buy) / 2)) * 100;
      const max = limitFor(ctx.jurisdiction, q.base, q.quote, settings.maxSpreadPercent, settings.maxSpreadOverrides);
      if (spread > max) {
        issues.push({
          code: 'spread-too-wide',
          blocking: true,
          message: `${pair}: спред ${fmt(spread)}% больше порога ${max}%`,
        });
      }
    }
  }

  const official = officialCross(
    q.base,
    q.quote,
    ctx.officials,
    ctx.refDate,
    settings.officialByJurisdiction[ctx.jurisdiction],
  );
  if (!official) {
    issues.push({
      code: 'no-official-reference',
      blocking: false,
      message: `${pair}: нет официального курса для сравнения`,
    });
    return issues;
  }
  if (!official.exactDate) {
    issues.push({
      code: 'official-other-date',
      blocking: false,
      message: `${pair}: сравнение с официальным курсом ${official.source} на ${official.validFor}`,
    });
  }
  const maxDev = limitFor(
    ctx.jurisdiction,
    q.base,
    q.quote,
    settings.maxOfficialDeviationPercent,
    settings.maxOfficialDeviationOverrides,
  );
  for (const [side, price] of [
    ['покупка', buy],
    ['продажа', sell],
  ] as const) {
    if (price === null) continue;
    const perUnit = price / nominal;
    const dev = (Math.abs(perUnit - official.value) / official.value) * 100;
    if (dev > maxDev) {
      issues.push({
        code: 'deviates-from-official',
        blocking: true,
        message: `${pair}: ${side} ${fmt(perUnit)} отличается от официального ${fmt(official.value)} (${official.source}) на ${fmt(dev)}%, порог ${maxDev}%`,
      });
    }
  }
  return issues;
}
