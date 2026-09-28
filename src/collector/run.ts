import { emptyRates } from '../core/merge';
import { buildOffers, type DroppedQuote } from '../core/offers';
import type {
  Branch,
  OfficialRates,
  Offer,
  RatesFile,
  Settings,
  SourceDef,
  SourceStatus,
  SourceStatusCode,
} from '../core/types';
import type { Adapter, AdapterOutput } from './adapter';
import { HttpError, ProtectedError, RobotsDisallowedError, type HttpClient } from './http';

export interface RunOptions {
  sources: readonly SourceDef[];
  settings: Settings;
  adapters: Readonly<Record<string, Adapter>>;
  http: HttpClient;
  runner: string;
  /** Предыдущий rates.json: его официальные курсы используются для проверок, если свежие не получены. */
  previous?: RatesFile;
  only?: readonly string[];
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SourceRunReport {
  id: string;
  status: SourceStatusCode;
  message?: string;
  offers: number;
  suspicious: number;
  reference: number;
  dropped: DroppedQuote[];
  durationMs: number;
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`таймаут ${Math.round(ms / 1000)} с`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function classifyError(e: unknown, source: SourceDef): { status: SourceStatusCode; message: string } {
  if (e instanceof ProtectedError) {
    return {
      status: 'protected',
      message: `Защита от ботов (${e.info.kind}): только вручную — ${source.ratesUrl}`,
    };
  }
  if (e instanceof RobotsDisallowedError) return { status: 'robots-blocked', message: e.message };
  if (e instanceof HttpError || e instanceof TimeoutError) return { status: 'error', message: e.message };
  return { status: 'error', message: `Ошибка адаптера: ${(e as Error)?.message ?? String(e)}` };
}

/**
 * Один проход сбора. Возвращает rates.json только этого запуска (без объединения со старым).
 * Ошибка любого источника изолирована: остальные собираются, у источника — статус и сообщение.
 * Официальные источники собираются первыми: их курсы нужны для проверок правдоподобности.
 */
export async function runCollection(opts: RunOptions): Promise<{ file: RatesFile; report: SourceRunReport[] }> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const startedAt = now().toISOString();
  const file = emptyRates(now());
  const report: SourceRunReport[] = [];

  const selected = opts.sources.filter((s) => !opts.only || opts.only.includes(s.id));
  const ordered = [
    ...selected.filter((s) => s.kind === 'official'),
    ...selected.filter((s) => s.kind !== 'official'),
  ];
  const officials: OfficialRates[] = [...(opts.previous?.official ?? [])];

  for (const source of ordered) {
    const attemptAt = now().toISOString();
    const status: SourceStatus = {
      id: source.id,
      status: 'error',
      lastAttemptAt: attemptAt,
      runner: opts.runner,
      offers: 0,
      suspicious: 0,
    };
    const rep: SourceRunReport = { id: source.id, status: 'error', offers: 0, suspicious: 0, reference: 0, dropped: [], durationMs: 0 };
    const t0 = now().getTime();
    log(`→ ${source.id}${source.collect === 'manual-only' ? ' (только вручную — не собирается)' : ''}`);

    if (source.collect === 'manual-only') {
      status.status = 'manual-only';
      status.message = source.manualReason ?? 'только вручную';
    } else {
      const adapter = source.adapter ? opts.adapters[source.adapter] : undefined;
      if (!adapter) {
        status.status = 'not-implemented';
        status.message = `Адаптер «${source.adapter ?? '—'}» не реализован`;
      } else {
        try {
          const out: AdapterOutput = await withTimeout(
            adapter({ source, http: opts.http, now, log: (m) => log(`  [${source.id}] ${m}`) }),
            opts.settings.sourceTimeoutMs,
          );
          const offers: Offer[] = [];
          for (const off of out.official ?? []) {
            const rec: OfficialRates = {
              source: source.id,
              base: off.base,
              validFor: off.validFor,
              fetchedAt: off.fetchedAt,
              sourceUrl: off.sourceUrl,
              rates: off.rates,
            };
            file.official.push(rec);
            officials.push(rec);
          }
          for (const batch of out.batches ?? []) {
            const built = buildOffers({
              source,
              quotes: batch.quotes,
              fetchedAt: batch.fetchedAt,
              sourceUrl: batch.sourceUrl,
              officials,
              plausibility: opts.settings.plausibility,
            });
            offers.push(...built.offers);
            rep.dropped.push(...built.dropped);
          }
          if (out.branches?.length) file.branches[source.id] = out.branches as Branch[];
          file.offers.push(...offers);

          const got = source.kind === 'official' ? (out.official?.length ?? 0) : offers.length;
          status.offers = offers.length;
          status.suspicious = offers.filter((o) => o.status === 'suspicious').length;
          rep.reference = offers.filter((o) => o.status === 'reference').length;
          if (got === 0) {
            status.status = 'error';
            status.message =
              'Курсы не найдены: возможно, изменилась вёрстка или API' +
              (out.warnings?.length ? ` (${out.warnings.join('; ')})` : '');
          } else {
            status.status = out.warnings?.length ? 'partial' : 'ok';
            if (out.warnings?.length) status.message = out.warnings.join('; ');
            status.lastSuccessAt = now().toISOString();
          }
        } catch (e) {
          const c = classifyError(e, source);
          status.status = c.status;
          status.message = c.message;
        }
      }
    }
    rep.durationMs = now().getTime() - t0;
    rep.status = status.status;
    rep.offers = status.offers;
    rep.suspicious = status.suspicious;
    if (status.message) rep.message = status.message;
    file.sources.push(status);
    report.push(rep);
  }

  const finishedAt = now().toISOString();
  file.runs.push({ runner: opts.runner, startedAt, finishedAt });
  file.generatedAt = finishedAt;
  return { file, report };
}
