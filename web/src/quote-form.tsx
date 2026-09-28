import { useState } from 'preact/hooks';
import { parseRate } from '../../src/core/numbers';
import type { ManualQuote } from '../../src/core/schema';
import type { Channel, Jurisdiction } from '../../src/core/types';
import { CHANNEL_NAMES, CURRENCY_ORDER } from './format';
import { uid } from './state';

const CHANNELS: Channel[] = ['cash', 'card', 'online'];

/**
 * Ввод курса как на табло банка: «банк покупает / продаёт BASE за QUOTE».
 * Пустое поле — нет данных (курс не подставляется). Время ввода = сейчас.
 */
export function QuoteForm({
  point,
  jurisdiction,
  initial,
  onSave,
  onCancel,
}: {
  point: string;
  jurisdiction: Jurisdiction;
  initial?: ManualQuote;
  onSave: (q: ManualQuote) => void;
  onCancel?: () => void;
}) {
  const [base, setBase] = useState(initial?.base ?? 'USD');
  const [quote, setQuote] = useState(initial?.quote ?? (jurisdiction === 'PMR' ? 'RUP' : 'MDL'));
  const [nominal, setNominal] = useState(String(initial?.nominal ?? 1));
  const [buy, setBuy] = useState(initial?.buy != null ? String(initial.buy) : '');
  const [sell, setSell] = useState(initial?.sell != null ? String(initial.sell) : '');
  const [channel, setChannel] = useState<Channel>(initial?.channel ?? 'cash');
  const [error, setError] = useState('');

  const save = (e: Event) => {
    e.preventDefault();
    const b = buy.trim() ? parseRate(buy.replace(',', '.')) : null;
    const s = sell.trim() ? parseRate(sell.replace(',', '.')) : null;
    const n = parseRate(nominal.replace(',', '.'));
    if (base === quote) return setError('Валюты должны различаться.');
    if ((buy.trim() && b === null) || (sell.trim() && s === null)) return setError('Курс — положительное число, например 17.62.');
    if (b === null && s === null) return setError('Нужна покупка или продажа.');
    if (n === null) return setError('Номинал — положительное число.');
    setError('');
    onSave({
      id: initial?.id ?? uid(),
      point,
      base,
      quote,
      nominal: n,
      buy: b,
      sell: s,
      channel,
      enteredAt: new Date().toISOString(),
    });
  };

  const cur = (v: string, set: (x: string) => void, label: string) => (
    <label class="field">
      <span>{label}</span>
      <select value={v} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
        {CURRENCY_ORDER.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  );

  return (
    <form class="quote-form" onSubmit={save}>
      <div class="row3">
        {cur(base, setBase, 'Валюта')}
        {cur(quote, setQuote, 'за')}
        <label class="field">
          <span>номинал</span>
          <input inputMode="numeric" value={nominal} onInput={(e) => setNominal((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="row2">
        <label class="field">
          <span>Банк покупает</span>
          <input inputMode="decimal" placeholder="нет данных" value={buy} onInput={(e) => setBuy((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Банк продаёт</span>
          <input inputMode="decimal" placeholder="нет данных" value={sell} onInput={(e) => setSell((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="field">
        <span>Канал</span>
        <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value as Channel)}>
          {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_NAMES[c]}</option>)}
        </select>
      </label>
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="actions">
        <button type="submit" class="primary">Сохранить курс</button>
        {onCancel && <button type="button" onClick={onCancel}>Отмена</button>}
      </div>
    </form>
  );
}
