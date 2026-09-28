import { useState } from 'preact/hooks';
import { manualOffers } from '../../src/core/manual';
import { manualDataSchema, type ManualData, type ManualPoint, type ManualQuote } from '../../src/core/schema';
import type { Jurisdiction } from '../../src/core/types';
import { CHANNEL_NAMES, fmtAge, fmtDateTime } from './format';
import { QuoteForm } from './quote-form';
import { uid, type AppState } from './state';

export function ManualView({ s }: { s: AppState }) {
  const [editingPoint, setEditingPoint] = useState<ManualPoint | 'new' | null>(null);
  const m = s.manual;
  const offers = manualOffers(m, s.rates?.official ?? [], s.config.settings.plausibility);

  const savePoint = (p: ManualPoint) => {
    const exists = m.points.some((x) => x.id === p.id);
    s.setManual({ ...m, points: exists ? m.points.map((x) => (x.id === p.id ? p : x)) : [...m.points, p] });
    setEditingPoint(null);
  };
  const deletePoint = (p: ManualPoint) => {
    if (!confirm(`Удалить «${p.name}» и все его курсы?`)) return;
    s.setManual({ ...m, points: m.points.filter((x) => x.id !== p.id), quotes: m.quotes.filter((q) => q.point !== p.id) });
  };

  return (
    <>
      <h1>Мои курсы</h1>
      <p class="muted">
        Пункты обмена и курсы, которые вы вводите сами. Они участвуют в расчёте наравне с банковскими, с пометкой
        «введён вручную». Хранятся только на этом устройстве.
      </p>

      {m.points.map((p) => (
        <PointCard key={p.id} p={p} s={s} offers={offers} onEdit={() => setEditingPoint(p)} onDelete={() => deletePoint(p)} />
      ))}
      {m.points.length === 0 && <div class="card muted">Пока нет ни одного пункта.</div>}

      {editingPoint ? (
        <PointForm initial={editingPoint === 'new' ? undefined : editingPoint} onSave={savePoint} onCancel={() => setEditingPoint(null)} />
      ) : (
        <button class="primary block" onClick={() => setEditingPoint('new')}>Добавить пункт обмена</button>
      )}

      <ImportExport s={s} />
    </>
  );
}

function PointForm({ initial, onSave, onCancel }: { initial: ManualPoint | undefined; onSave: (p: ManualPoint) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [jurisdiction, setJ] = useState<Jurisdiction>(initial?.jurisdiction ?? 'PMR');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  return (
    <form
      class="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSave({
          ...(initial ?? {}),
          id: initial?.id ?? uid(),
          name: name.trim(),
          jurisdiction,
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }}
    >
      <h2 class="h3">{initial ? 'Изменить пункт' : 'Новый пункт обмена'}</h2>
      <label class="field">
        <span>Название</span>
        <input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>Берег</span>
        <select value={jurisdiction} onChange={(e) => setJ((e.target as HTMLSelectElement).value as Jurisdiction)}>
          <option value="PMR">ПМР</option>
          <option value="MD">Молдова</option>
        </select>
      </label>
      <label class="field">
        <span>Адрес</span>
        <input value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>Заметка</span>
        <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      </label>
      <div class="actions">
        <button type="submit" class="primary">Сохранить</button>
        <button type="button" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

function PointCard({
  p,
  s,
  offers,
  onEdit,
  onDelete,
}: {
  p: ManualPoint;
  s: AppState;
  offers: ReturnType<typeof manualOffers>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const m = s.manual;
  const quotes = m.quotes.filter((q) => q.point === p.id).sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));

  const upsert = (q: ManualQuote) => {
    const exists = m.quotes.some((x) => x.id === q.id);
    s.setManual({ ...m, quotes: exists ? m.quotes.map((x) => (x.id === q.id ? q : x)) : [...m.quotes, q] });
    setAdding(false);
    setEditing(null);
  };
  const remove = (q: ManualQuote) => s.setManual({ ...m, quotes: m.quotes.filter((x) => x.id !== q.id) });

  // Статус проверки правдоподобности для курса (ловит опечатки при вводе).
  const statusOf = (q: ManualQuote) =>
    offers.find(
      (o) => o.source === `manual:${p.id}` && o.published.base === q.base && o.published.quote === q.quote && o.channel === q.channel && o.fetchedAt === q.enteredAt,
    );

  return (
    <article class="card">
      <div class="source-head">
        <h3>{p.name}</h3>
        <span class="chip">{p.jurisdiction === 'PMR' ? 'ПМР' : 'Молдова'}</span>
      </div>
      {p.address && <div class="small muted">{p.address}</div>}
      {p.note && <div class="small">{p.note}</div>}
      <ul class="list">
        {quotes.map((q) => {
          const o = statusOf(q);
          return editing === q.id ? (
            <li key={q.id}><QuoteForm point={p.id} jurisdiction={p.jurisdiction} initial={q} onSave={upsert} onCancel={() => setEditing(null)} /></li>
          ) : (
            <li key={q.id}>
              <div>
                <strong>{q.base}/{q.quote}</strong>{q.nominal && q.nominal !== 1 ? ` за ${q.nominal}` : ''} · {CHANNEL_NAMES[q.channel]}: покупка {q.buy ?? 'нет данных'}, продажа {q.sell ?? 'нет данных'}
              </div>
              <div class="small muted">введён {fmtDateTime(q.enteredAt)} ({fmtAge(q.enteredAt)})</div>
              {o?.status === 'suspicious' && (
                <div class="small error-text">Подозрительный курс, в расчёт не идёт: {o.issues?.filter((i) => i.blocking).map((i) => i.message).join('; ')}</div>
              )}
              {!o && <div class="small muted">Заменён более поздним вводом этой же пары.</div>}
              <div class="actions small">
                <button class="link" onClick={() => setEditing(q.id)}>Изменить</button>
                <button class="link danger" onClick={() => remove(q)}>Удалить</button>
              </div>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <QuoteForm point={p.id} jurisdiction={p.jurisdiction} onSave={upsert} onCancel={() => setAdding(false)} />
      ) : (
        <div class="actions">
          <button class="primary" onClick={() => setAdding(true)}>Добавить курс</button>
          {!p.sourceId && <button onClick={onEdit}>Изменить пункт</button>}
          <button class="danger" onClick={onDelete}>Удалить пункт</button>
        </div>
      )}
    </article>
  );
}

function ImportExport({ s }: { s: AppState }) {
  const [msg, setMsg] = useState('');

  const doExport = () => {
    const data: ManualData = { ...s.manual, exportedAt: new Date().toISOString(), myBranches: s.prefs.myBranches };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `мои-курсы-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File) => {
    try {
      const parsed = manualDataSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setMsg(`Файл не подходит: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        return;
      }
      const d = parsed.data;
      if (!confirm(`Заменить ваши данные? В файле: пунктов ${d.points.length}, курсов ${d.quotes.length}.`)) return;
      s.setManual(d);
      if (d.myBranches.length) s.setPrefs({ ...s.prefs, myBranches: d.myBranches });
      setMsg(`Импортировано: пунктов ${d.points.length}, курсов ${d.quotes.length}.`);
    } catch (e) {
      setMsg(`Не удалось прочитать файл: ${(e as Error).message}`);
    }
  };

  return (
    <section class="card">
      <h2 class="h3">Резервная копия</h2>
      <p class="small muted">JSON с вашими пунктами, курсами и списком «мои отделения».</p>
      <div class="actions">
        <button onClick={doExport}>Экспорт в файл</button>
        <label class="button">
          Импорт из файла
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void doImport(f);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
      </div>
      {msg && <p class="small" role="status">{msg}</p>}
    </section>
  );
}
