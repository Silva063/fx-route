import { useState } from 'preact/hooks';
import type { ManualQuote } from '../../src/core/schema';
import type { SourceStatusCode } from '../../src/core/types';
import type { PublicSource } from './data';
import { fmtAge, fmtDateTime, fmtRate, fmtValidFrom } from './format';
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

const needsManual = (st: SourceStatusCode | undefined, src: PublicSource) =>
  src.collect === 'manual-only' || st === 'protected' || st === 'robots-blocked';

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
  const st = s.rates?.sources.find((x) => x.id === src.id);
  const status = st?.status ?? (src.collect === 'manual-only' ? 'manual-only' : undefined);
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
        <span class={`status status-${status ?? 'none'}`}>{status ? STATUS_NAMES[status] : 'нет данных'}</span>
      </div>
      {st?.lastSuccessAt ? (
        <div class="small">
          Последний успешный сбор: <strong>{fmtDateTime(st.lastSuccessAt)}</strong> ({fmtAge(st.lastSuccessAt)})
          {st.offers > 0 && <span class="muted"> · предложений {st.offers}{st.suspicious ? `, подозрительных ${st.suspicious}` : ''}</span>}
        </div>
      ) : (
        status !== 'manual-only' && <div class="small muted">Успешных сборов не было.</div>
      )}
      {st && st.status !== 'ok' && st.status !== 'partial' && st.status !== 'manual-only' && (
        <div class="small muted">Последняя попытка: {fmtDateTime(st.lastAttemptAt)} ({st.runner === 'github-actions' ? 'GitHub Actions' : 'ПК'})</div>
      )}
      {(st?.message || src.manualReason) && <div class="small">{st?.message ?? src.manualReason}</div>}
      <a class="small" href={src.ratesUrl} target="_blank" rel="noopener noreferrer">Курсы на сайте банка ↗</a>

      {needsManual(status, src) && (
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
