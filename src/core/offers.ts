import { checkQuote } from './plausibility';
import { localDate } from './time';
import type {
  Channel,
  Currency,
  Issue,
  OfficialRates,
  Offer,
  OfferStatus,
  Origin,
  PlausibilitySettings,
  RawQuote,
  SourceDef,
} from './types';

export function offerId(o: {
  source: string;
  branch?: string | undefined;
  channel: Channel;
  from: Currency;
  to: Currency;
}): string {
  return `${o.source}|${o.branch ?? '-'}|${o.channel}|${o.from}>${o.to}`;
}

export interface DroppedQuote {
  table: string;
  pair: string;
  reason: string;
}

export interface BuildOffersInput {
  source: Pick<SourceDef, 'id' | 'jurisdiction' | 'tables'>;
  quotes: readonly RawQuote[];
  fetchedAt: string;
  sourceUrl: string;
  officials: readonly OfficialRates[];
  plausibility: PlausibilitySettings;
  origin?: Origin;
}

/**
 * Котировки источника → направленные предложения.
 * - котировки из таблиц вне белого списка отбрасываются;
 * - канал unknown или таблица use=reference → статус reference;
 * - блокирующие проблемы правдоподобности → статус suspicious.
 */
export function buildOffers(input: BuildOffersInput): { offers: Offer[]; dropped: DroppedQuote[] } {
  const offers: Offer[] = [];
  const dropped: DroppedQuote[] = [];
  const seen = new Set<string>();
  const origin = input.origin ?? 'auto';

  for (const q of input.quotes) {
    const pair = `${q.base}/${q.quote}`;
    const table = input.source.tables?.[q.table];
    if (!table) {
      dropped.push({ table: q.table, pair, reason: 'таблица не в белом списке' });
      continue;
    }
    if (q.base === q.quote) {
      dropped.push({ table: q.table, pair, reason: 'одинаковые валюты' });
      continue;
    }
    const nominal = q.nominal ?? 1;
    const buy = q.buy ?? null;
    const sell = q.sell ?? null;
    if (!(nominal > 0) || (buy === null && sell === null)) {
      dropped.push({ table: q.table, pair, reason: 'нет данных' });
      continue;
    }

    // Дата, на которую курс действует: из источника (дата или дата-время), иначе дата получения.
    const refDate = q.validFrom
      ? q.validFrom.length === 10
        ? q.validFrom
        : localDate(q.validFrom)
      : localDate(input.fetchedAt);
    const issues: Issue[] = checkQuote(q, {
      jurisdiction: input.source.jurisdiction,
      officials: input.officials,
      refDate,
      settings: input.plausibility,
    });
    if (table.channel === 'unknown') {
      issues.push({
        code: 'channel-unknown',
        blocking: false,
        message: `Канал таблицы «${table.label}» не подтверждён — курс справочный`,
      });
    }
    const channelConfidence = table.channel === 'unknown' ? 'assumed' : (table.channelConfidence ?? 'confirmed');
    if (table.channel !== 'unknown' && channelConfidence === 'assumed') {
      issues.push({
        code: 'channel-assumed',
        blocking: false,
        message: `Канал не подтверждён: таблица «${table.label}» считается каналом «${table.channel}» по предположению`,
      });
    }
    if (table.use === 'reference') {
      issues.push({
        code: 'reference-table',
        blocking: false,
        message: `Таблица «${table.label}» справочная`,
      });
    }
    const status: OfferStatus = issues.some((i) => i.blocking)
      ? 'suspicious'
      : table.channel === 'unknown' || table.use === 'reference'
        ? 'reference'
        : 'ok';

    const sides: { side: 'buy' | 'sell'; price: number; from: Currency; to: Currency; rate: number }[] = [];
    if (buy !== null) sides.push({ side: 'buy', price: buy, from: q.base, to: q.quote, rate: buy / nominal });
    if (sell !== null) sides.push({ side: 'sell', price: sell, from: q.quote, to: q.base, rate: nominal / sell });

    for (const s of sides) {
      const id = offerId({ source: input.source.id, branch: q.branch, channel: table.channel, from: s.from, to: s.to });
      if (seen.has(id)) {
        dropped.push({ table: q.table, pair, reason: `дубликат предложения ${id}` });
        continue;
      }
      seen.add(id);
      const offer: Offer = {
        id,
        source: input.source.id,
        table: q.table,
        from: s.from,
        to: s.to,
        rate: s.rate,
        published: { base: q.base, quote: q.quote, price: s.price, nominal, side: s.side },
        channel: table.channel,
        channelConfidence,
        fetchedAt: input.fetchedAt,
        origin,
        sourceUrl: input.sourceUrl,
        status,
      };
      if (q.branch) offer.branch = q.branch;
      if (q.validFrom) offer.validFrom = q.validFrom;
      if (issues.length) offer.issues = issues;
      offers.push(offer);
    }
  }
  return { offers, dropped };
}

/** Участвует ли предложение в маршрутах. */
export function isRoutable(o: Offer): boolean {
  return o.status === 'ok' && o.channel !== 'unknown';
}
