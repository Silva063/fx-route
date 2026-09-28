import { useState } from 'preact/hooks';
import { runnerName, sourceHealth } from '../../src/core/merge';
import { effectiveAt } from '../../src/core/validity';
import type { ManualQuote } from '../../src/core/schema';
import type { SourceStatusCode } from '../../src/core/types';
import type { PublicSource } from './data';
import { fmtAge, fmtDateTime, fmtRate, fmtValidFrom, hoursAgo } from './format';
import { QuoteForm } from './quote-form';
import { DataAge } from './route-view';
import type { AppState } from './state';

export const STATUS_NAMES: Record<SourceStatusCode, string> = {
  ok: 'работает',
  partial: 'частично',
  error: 'ошибка сбора',
  protected: 'защита — только вручную',
  'robots-blocked': 'запрещено robots.txt',
  'manual-only': 'только вручную',
  'not-implemented': 'адаптер не готов',
};

/** Быстрый ввод — для manual-only и когда ни одно место сбора сейчас не получает курсы из-за защиты/robots. */
const needsManual = (st: SourceStatusCode | undefined, src: PublicSource, anyWorking: boolean) =>
  src.collect === 'manual-only' || (!anyWorking && (st === 'protected' || st === 'robots-blocked'));

export function SourcesView({ s }: { s: AppState }) {
  const banks = s.config.sources.filter((x) => x.kind !== 'official');
  const byShore = (j: 'PMR' | 'MD') => banks.filter((b) => b.jurisdiction === j);
  return (
    <>
      <h1>Источники</h1>
      <DataAge s={s} />
      <Official s={s} />
      <h2>Банки ПМР</h2>
      {byShore('PMR').map((src) => <SourceCard key={src.id} src={src} s={s} />)}
      <h2>Банки Молдовы</h2>
      {byShore('MD').map((src) => <SourceCard key={src.id} src={src} s={s} />)}
    </>
  );
}

function Official({ s }: { s: AppState }) {
  const list = s.rates?.official ?? [];
  const latest = ['bnm', 'prb']
    .map((id) => list.filter((o) => o.source === id).sort((a, b) => b.validFor.localeCompare(a.validFor))[0])
    .filter((x) => !!x);
  if (!latest.length) return null;
  return (
    <section class="card">
      <h2 class="h3">Официальные курсы — справочно</h2>
      <p class="muted small">Ориентир, а не предложение обмена: по этим курсам банки не меняют.</p>
      {latest.map((o) => (
        <div key={o.source} class="official">
          <strong>{o.source === 'bnm' ? 'Нацбанк Молдовы' : 'ПРБ'}</strong>, на {fmtValidFrom(o.validFor)}:{' '}
          {['USD', 'EUR', 'RUB', 'MDL', 'UAH']
            .filter((c) => o.rates[c] !== undefined)
            .map((c) => `${c} ${fmtRate(o.rates[c]!)} ${o.base}`)
            .join(' · ')}
        </div>
      ))}
    </section>
  );
}

function SourceCard({ src, s }: { src: PublicSource; s: AppState }) {
  // Статус по всем местам сбора: основной — где был самый свежий успешный сбор.
  const health = sourceHealth(s.rates?.sources ?? [], src.id);
  const st = health?.primary;
  const status = src.collect === 'manual-only' ? 'manual-only' : st?.status;
  const anyWorking = !!health && [health.primary, ...health.others].some((x) => x.status === 'ok' || x.status === 'partial');
  const manualPointId = `src-${src.id}`;
  const manualQuotes = s.manual.quotes.filter((q) => q.point === manualPointId);
  const [adding, setAdding] = useState(false);

  const saveQuote = (q: ManualQuote) => {
    const m = s.manual;
    const points = m.points.some((p) => p.id === manualPointId)
      ? m.points
      : [...m.points, { id: manualPointId, name: src.name, jurisdiction: src.jurisdiction, sourceId: src.id }];
    s.setManual({ ...m, points, quotes: [...m.quotes, q] });
    setAdding(false);
  };

  return (
    <article class="card source">
      <div class="source-head">
        <h3>{src.name}</h3>
        <span class={`status status-${status ?? 'none'}`}>
          {status ? STATUS_NAMES[status] : 'нет данных'}
          {st && status !== 'manual-only' && ` (${runnerName(st.runner)}${st.lastSuccessAt ? `, ${fmtDateTime(st.lastSuccessAt)}` : ''})`}
        </span>
      </div>
      {st?.lastSuccessAt ? (
        <div class="small">
          Последний успешный сбор: <strong>{fmtDateTime(st.lastSuccessAt)}</strong> ({fmtAge(st.lastSuccessAt)}, {runnerName(st.runner)})
          {st.offers > 0 && <span class="muted"> · предложений {st.offers}{st.suspicious ? `, подозрительных ${st.suspicious}` : ''}</span>}
        </div>
      ) : (
        status !== 'manual-only' &&
        !(s.rates?.offers ?? []).some((o) => o.source === src.id) && <div class="small muted">Успешных сборов не было.</div>
      )}
      {st && st.status !== 'ok' && st.status !== 'partial' && st.status !== 'manual-only' && (
        <div class="small">
          {runnerName(st.runner)}, последняя попытка {fmtDateTime(st.lastAttemptAt)}: {STATUS_NAMES[st.status]}
          {st.message && <span class="muted"> — {st.message}</span>}
        </div>
      )}
      {health?.others.map((o) => (
        <div key={o.runner} class="small">
          {o.status === 'ok' || o.status === 'partial' ? (
            <span class="muted">Из {runnerName(o.runner)} тоже собирается: {fmtDateTime(o.lastSuccessAt ?? o.lastAttemptAt)}</span>
          ) : (
            <>
              <span class="runner-bad">Из {runnerName(o.runner)} недоступен</span>{' '}
              <span class="muted">
                ({STATUS_NAMES[o.status]}, попытка {fmtDateTime(o.lastAttemptAt)}
                {o.lastSuccessAt ? `, последний успех ${fmtDateTime(o.lastSuccessAt)}` : ''})
                {o.message ? ` — ${o.message}` : ''}
              </span>
            </>
          )}
        </div>
      ))}
      <OffersLine s={s} id={src.id} />
      {src.collect === 'manual-only' && src.manualReason && <div class="small">{src.manualReason}</div>}
      <a class="small" href={src.ratesUrl} target="_blank" rel="noopener noreferrer">Курсы на сайте банка ↗</a>

      {needsManual(status, src, anyWorking) && (
        <div class="manual-entry">
          {manualQuotes.length > 0 && (
            <ul class="list small">
              {manualQuotes.map((q) => (
                <li key={q.id}>
                  {q.base}/{q.quote}: покупка {q.buy ?? '—'}, продажа {q.sell ?? '—'} · введён {fmtAge(q.enteredAt)}
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <QuoteForm point={manualPointId} jurisdiction={src.jurisdiction} onSave={saveQuote} onCancel={() => setAdding(false)} />
          ) : (
            <button class="primary" onClick={() => setAdding(true)}>Ввести курс вручную</button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Что из источника реально участвует в расчёте — по самим курсам, независимо от статусов мест сбора:
 * курсы с ПК остаются в маршрутах, пока свежие, даже если из GitHub Actions источник недоступен.
 */
function OffersLine({ s, id }: { s: AppState; id: string }) {
  const now = new Date();
  const offers = effectiveAt((s.rates?.offers ?? []).filter((o) => o.source === id), now);
  if (!offers.length) return null;
  const last = offers.reduce((m, o) => (o.fetchedAt > m ? o.fetchedAt : m), '');
  const stale = hoursAgo(last, now) > s.config.settings.staleAfterHours;
  const usable = offers.filter((o) => o.status === 'ok').length;
  return (
    <div class={`small ${stale ? 'runner-bad' : ''}`}>
      Курсы в расчёте: {usable} из {offers.length}, получены {fmtDateTime(last)} ({fmtAge(last)})
      {stale && ' — устарели'}
    </div>
  );
}
