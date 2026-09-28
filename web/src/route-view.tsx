import { useMemo, useState } from 'preact/hooks';
import { FLAG_LABELS, findRoutes, type Route, type RouteFlag, type RouteStep } from '../../src/core/routes';
import { localDate, zonedLocalToIso } from '../../src/core/time';
import type { Channel, Offer } from '../../src/core/types';
import {
  CHANNEL_NAMES,
  CURRENCY_ORDER,
  currencyLabel,
  fmtAge,
  fmtDateTime,
  fmtMoney,
  fmtRate,
  fmtValidFrom,
  hoursAgo,
} from './format';
import { allOffers, branchNames, sourceName, type AppState } from './state';

const CHANNELS: Channel[] = ['cash', 'card', 'online'];

export function DataAge({ s }: { s: AppState }) {
  const r = s.rates;
  if (!r) {
    return (
      <div class="banner bad" role="status">
        <strong>Нет данных о курсах.</strong> {s.ratesError ?? ''} Курсы не подставляются — можно ввести их вручную во вкладке «Мои курсы».
      </div>
    );
  }
  const stale = hoursAgo(r.generatedAt) > s.config.settings.staleAfterHours;
  return (
    <div class={`banner ${stale ? 'warn' : ''}`} role="status">
      Курсы собраны <strong>{fmtDateTime(r.generatedAt)}</strong> ({fmtAge(r.generatedAt)})
      {!s.online && <span class="chip">офлайн — сохранённая копия</span>}
      {stale && <div>Данные старше {s.config.settings.staleAfterHours} ч — проверьте курсы в банке.</div>}
    </div>
  );
}

function currencies(s: AppState): string[] {
  const set = new Set<string>(CURRENCY_ORDER.slice(0, 4));
  for (const o of allOffers(s)) (set.add(o.from), set.add(o.to));
  return [...set].sort((a, b) => {
    const ia = CURRENCY_ORDER.indexOf(a);
    const ib = CURRENCY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/** Банки, у которых есть таблица данного канала (для выбора счёта «откуда»). */
function banksWithChannel(s: AppState, ch: Channel) {
  return s.config.sources.filter((x) => Object.values(x.tables).some((t) => t.channel === ch));
}

export function RouteView({ s, goTo }: { s: AppState; goTo: (t: 'settings' | 'manual') => void }) {
  const q = s.prefs.lastQuery;
  const setQ = (patch: Partial<typeof q>) => s.setPrefs({ ...s.prefs, lastQuery: { ...q, ...patch } });
  const [amountText, setAmountText] = useState(String(q.amount));
  const today = localDate(new Date());
  const [date, setDate] = useState('');
  const [showAll, setShowAll] = useState(false);

  const result = useMemo(() => {
    const now = new Date();
    const at = date && date > today ? new Date(zonedLocalToIso(`${date}T12:00`)!) : undefined;
    return findRoutes(
      {
        amount: q.amount,
        from: { currency: q.from, channel: q.fromChannel, ...(q.fromChannel !== 'cash' && q.fromAccount ? { account: q.fromAccount } : {}) },
        to: { currency: q.to, channels: q.toChannels },
        allowedChannels: s.prefs.allowedChannels,
        myAccounts: s.prefs.myAccounts,
        branchMode: s.prefs.branchMode,
        myBranches: s.prefs.myBranches,
        excludeStale: s.prefs.excludeStale,
        now,
        ...(at ? { at } : {}),
        topN: showAll ? 15 : s.config.settings.routing.topN,
      },
      {
        offers: allOffers(s),
        sources: Object.fromEntries([
          ...s.config.sources.map((x) => [x.id, { name: x.name, jurisdiction: x.jurisdiction }] as const),
          ...s.manual.points.map((p) => [`manual:${p.id}`, { name: `${p.name} (вручную)`, jurisdiction: p.jurisdiction }] as const),
        ]),
        branchNames: branchNames(s),
        feeRules: s.config.fees,
        transitions: s.config.transitions,
        settings: s.config.settings,
      },
    );
  }, [s.rates, s.manual, s.prefs, date, showAll]);

  const curs = currencies(s);
  const fromBanks = q.fromChannel === 'cash' ? [] : banksWithChannel(s, q.fromChannel);
  const needAccount = q.fromChannel !== 'cash' && !q.fromAccount;

  return (
    <>
      <h1>Выгодный обмен</h1>
      <DataAge s={s} />

      <form class="card query" onSubmit={(e) => e.preventDefault()} aria-label="Запрос маршрута">
        <label class="field">
          <span>Сумма</span>
          <input
            inputMode="decimal"
            value={amountText}
            onInput={(e) => {
              const t = (e.target as HTMLInputElement).value;
              setAmountText(t);
              const n = Number(t.replace(/\s/g, '').replace(',', '.'));
              if (Number.isFinite(n) && n > 0) setQ({ amount: n });
            }}
          />
        </label>

        <div class="row2">
          <label class="field">
            <span>Отдаю</span>
            <select value={q.from} onChange={(e) => setQ({ from: (e.target as HTMLSelectElement).value })}>
              {curs.map((c) => <option key={c} value={c}>{currencyLabel(c)}</option>)}
            </select>
          </label>
          <label class="field">
            <span>как</span>
            <select value={q.fromChannel} onChange={(e) => setQ({ fromChannel: (e.target as HTMLSelectElement).value as Channel })}>
              {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_NAMES[c]}</option>)}
            </select>
          </label>
        </div>
        {q.fromChannel !== 'cash' && (
          <label class="field">
            <span>Счёт в банке</span>
            <select value={q.fromAccount ?? ''} onChange={(e) => setQ({ fromAccount: (e.target as HTMLSelectElement).value || undefined })}>
              <option value="">— выберите банк —</option>
              {fromBanks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}

        <button
          type="button"
          class="swap"
          aria-label="Поменять местами"
          onClick={() => {
            setQ({ from: q.to, to: q.from, fromChannel: q.toChannels[0] ?? 'cash', toChannels: [q.fromChannel] });
          }}
        >
          ⇅
        </button>

        <label class="field">
          <span>Получаю</span>
          <select value={q.to} onChange={(e) => setQ({ to: (e.target as HTMLSelectElement).value })}>
            {curs.map((c) => <option key={c} value={c}>{currencyLabel(c)}</option>)}
          </select>
        </label>
        <fieldset class="checks">
          <legend>в виде</legend>
          {CHANNELS.map((c) => (
            <label key={c} class="check">
              <input
                type="checkbox"
                checked={q.toChannels.includes(c)}
                onChange={(e) => {
                  const on = (e.target as HTMLInputElement).checked;
                  const next = on ? [...q.toChannels, c] : q.toChannels.filter((x) => x !== c);
                  if (next.length) setQ({ toChannels: next });
                }}
              />
              {CHANNEL_NAMES[c]}
            </label>
          ))}
        </fieldset>

        <label class="field">
          <span>Курсы на дату</span>
          <input type="date" min={today} value={date || today} onChange={(e) => {
            const el = e.target as HTMLInputElement;
            // Прошедшие даты не принимаются: старые курсы не хранятся. Поле возвращается к сегодняшней дате.
            if (!el.value || el.value <= today) {
              el.value = today;
              setDate('');
            } else setDate(el.value);
          }} />
          <small class="muted">{date ? `Курсы, действующие ${fmtValidFrom(date)} в 12:00` : 'Курсы, действующие сейчас'}</small>
        </label>
      </form>

      {needAccount && <div class="banner warn">Выберите банк, на счёте которого лежат деньги.</div>}
      <Hints s={s} excluded={result.excluded} goTo={goTo} />

      <h2>Лучшие маршруты</h2>
      {result.routes.length === 0 && (
        <div class="card muted">
          Маршрутов не найдено. {s.rates ? 'Проверьте каналы и «мои счета» в настройках или добавьте курс вручную.' : 'Нет данных о курсах.'}
        </div>
      )}
      <ol class="routes">
        {result.routes.map((r, i) => <RouteCard key={i} r={r} rank={i + 1} s={s} />)}
      </ol>
      {result.routes.length >= s.config.settings.routing.topN && !showAll && (
        <button class="link" onClick={() => setShowAll(true)}>Показать больше маршрутов</button>
      )}

      {result.upcoming.length > 0 && <Upcoming offers={result.upcoming} s={s} />}
    </>
  );
}

function Hints({ s, excluded, goTo }: { s: AppState; excluded: ReturnType<typeof findRoutes>['excluded']; goTo: (t: 'settings') => void }) {
  const items: string[] = [];
  if (excluded.notMyBranch > 0) {
    items.push(
      s.prefs.myBranches.length === 0
        ? `Отделения не выбраны: курсы ${excluded.notMyBranch} предложений отделений не учитываются.`
        : `Не учтено ${excluded.notMyBranch} предложений отделений вне списка «мои отделения».`,
    );
  }
  if (excluded.notMyAccount > 0) items.push(`Не учтено ${excluded.notMyAccount} курсов карт и онлайн-банков: этих счетов нет в «мои счета».`);
  if (excluded.stale > 0) items.push(`Исключено ${excluded.stale} устаревших курсов.`);
  if (!items.length) return null;
  return (
    <div class="banner info">
      {items.map((t) => <div key={t}>{t}</div>)}
      <button class="link" onClick={() => goTo('settings')}>Настроить</button>
    </div>
  );
}

function Flags({ flags }: { flags: RouteFlag[] }) {
  if (!flags.length) return null;
  return (
    <ul class="flags" aria-label="Пометки">
      {flags.map((f) => <li key={f} class={`flag flag-${f}`}>{FLAG_LABELS[f]}</li>)}
    </ul>
  );
}

function RouteCard({ r, rank, s }: { r: Route; rank: number; s: AppState }) {
  return (
    <li class="card route">
      <div class="route-head">
        <span class="rank">{rank}</span>
        <div>
          <div class="total">{fmtMoney(r.amountOut)} <span class="cur">{r.currency}</span></div>
          {r.leftovers.length > 0 && (
            <div class="muted small">+ сдача {r.leftovers.map((l) => `${fmtMoney(l.amount)} ${l.currency}`).join(', ')}</div>
          )}
        </div>
      </div>
      <ol class="steps">
        {r.steps.map((st, i) => <Step key={i} st={st} s={s} />)}
      </ol>
    </li>
  );
}

function Step({ st, s }: { st: RouteStep; s: AppState }) {
  const o = st.offer;
  const where = st.kind === 'exchange' ? sourceName(s, st.source!) : st.transition!.label;
  return (
    <li class="step">
      <div class="step-amounts">
        {fmtMoney(st.amountIn)} {st.from.currency} <span class="muted">{CHANNEL_NAMES[st.from.channel]}</span>
        {' → '}
        <strong>{fmtMoney(st.amountOut)} {st.to.currency}</strong> <span class="muted">{CHANNEL_NAMES[st.to.channel]}</span>
      </div>
      <div class="step-where">
        {where}
        {st.branchName && <span>, {st.branchName}</span>}
        {!st.branchName && st.branch && <span>, отделение {st.branch}</span>}
        {st.alsoAtBranches && st.alsoAtBranches.length > 0 && <span class="muted"> (и ещё {st.alsoAtBranches.length} отд. с тем же курсом)</span>}
      </div>
      {o && (
        <div class="small">
          {o.published.side === 'buy' ? 'Покупка' : 'Продажа'} банка: {fmtRate(o.published.price)} {o.published.quote} за {o.published.nominal} {o.published.base}
          <span class="muted">
            {' · '}получен {fmtAge(o.fetchedAt)} ({fmtDateTime(o.fetchedAt)})
            {o.validFrom && ` · действует с ${fmtValidFrom(o.validFrom)}`}
          </span>
        </div>
      )}
      {st.fees.map((f) => (
        <div key={f.label} class="small">
          Комиссия: {fmtMoney(f.amount)} {f.currency} — {f.label}
          {!f.verified && <span class="flag flag-fee-unverified inline">не проверено</span>}
        </div>
      ))}
      {st.leftover && <div class="small">Сдача: {fmtMoney(st.leftover.amount)} {st.leftover.currency}</div>}
      <Flags flags={st.flags} />
      {st.alternatives && st.alternatives.length > 0 && (
        <div class="small muted">
          Тот же итог: {st.alternatives.map((a) => sourceName(s, a.source) + (a.branchName ? ` (${a.branchName})` : '')).join('; ')}
        </div>
      )}
    </li>
  );
}

function Upcoming({ offers, s }: { offers: Offer[]; s: AppState }) {
  return (
    <section>
      <h2>Будущие курсы</h2>
      <p class="muted small">Начнут действовать позже — в расчёт выше не входят. Чтобы учесть их, выберите дату.</p>
      <ul class="card list">
        {offers.slice(0, 12).map((o) => (
          <li key={o.id + o.validFrom}>
            <strong>с {fmtValidFrom(o.validFrom!)}</strong> · {sourceName(s, o.source)} · {CHANNEL_NAMES[o.channel]} · {o.from}→{o.to}:{' '}
            {o.published.side === 'buy' ? 'покупка' : 'продажа'} {fmtRate(o.published.price)} {o.published.quote}
          </li>
        ))}
      </ul>
    </section>
  );
}
