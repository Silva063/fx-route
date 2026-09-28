import { useMemo, useState } from 'preact/hooks';
import type { Channel } from '../../src/core/types';
import { CHANNEL_NAMES } from './format';
import { fmtAge, fmtDateTime } from './format';
import { cityOf, type AppState } from './state';
import { BUILD, checkForUpdate, applyUpdate, useUpdateState } from './update';

const CHANNELS: Channel[] = ['cash', 'card', 'online'];

export function SettingsView({ s }: { s: AppState }) {
  return (
    <>
      <h1>Настройки</h1>
      <Accounts s={s} />
      <Branches s={s} />
      <Other s={s} />
      <Rules s={s} />
      <About />
    </>
  );
}

function Accounts({ s }: { s: AppState }) {
  const p = s.prefs;
  const banks = s.config.sources.filter((x) => Object.values(x.tables).some((t) => t.channel === 'card' || t.channel === 'online'));
  const toggleAccount = (id: string, on: boolean) =>
    s.setPrefs({ ...p, myAccounts: on ? [...new Set([...p.myAccounts, id])] : p.myAccounts.filter((x) => x !== id) });
  const toggleChannel = (c: Channel, on: boolean) => {
    const next = on ? [...new Set([...p.allowedChannels, c])] : p.allowedChannels.filter((x) => x !== c);
    if (next.length) s.setPrefs({ ...p, allowedChannels: next });
  };
  return (
    <section class="card">
      <h2 class="h3">Мои счета и каналы</h2>
      <fieldset class="checks">
        <legend>Какими способами я готов менять</legend>
        {CHANNELS.map((c) => (
          <label key={c} class="check">
            <input type="checkbox" checked={p.allowedChannels.includes(c)} onChange={(e) => toggleChannel(c, (e.target as HTMLInputElement).checked)} />
            {CHANNEL_NAMES[c]}
          </label>
        ))}
      </fieldset>
      <fieldset class="checks column">
        <legend>Где у меня есть карта или онлайн-банк</legend>
        <p class="small muted">Через чужие счета маршруты не строятся. Наличные доступны в любом банке.</p>
        {banks.map((b) => {
          const chans = [...new Set(Object.values(b.tables).map((t) => t.channel).filter((c) => c === 'card' || c === 'online'))];
          return (
            <label key={b.id} class="check">
              <input type="checkbox" checked={p.myAccounts.includes(b.id)} onChange={(e) => toggleAccount(b.id, (e.target as HTMLInputElement).checked)} />
              {b.name} <span class="muted small">({chans.map((c) => CHANNEL_NAMES[c]).join(', ')})</span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}

function Branches({ s }: { s: AppState }) {
  const p = s.prefs;
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const all = useMemo(
    () =>
      Object.entries(s.rates?.branches ?? {}).flatMap(([src, list]) =>
        list.map((b) => ({
          key: `${src}|${b.id}`,
          source: s.config.sources.find((x) => x.id === src)?.name ?? src,
          name: b.name,
          city: cityOf(b.name),
        })),
      ),
    [s.rates],
  );
  const cities = [...new Set(all.map((b) => b.city))].sort((a, b) => (a === 'Другое' ? 1 : b === 'Другое' ? -1 : a.localeCompare(b, 'ro')));
  const q = query.trim().toLowerCase();
  const shown = all.filter((b) => (!city || b.city === city) && (!q || `${b.source} ${b.name}`.toLowerCase().includes(q)));
  const mine = new Set(p.myBranches);
  const set = (keys: string[], on: boolean) => {
    const next = new Set(mine);
    for (const k of keys) on ? next.add(k) : next.delete(k);
    s.setPrefs({ ...p, myBranches: [...next] });
  };

  return (
    <section class="card">
      <h2 class="h3">Мои отделения</h2>
      <p class="small muted">
        Некоторые банки публикуют курсы по отделениям. По умолчанию маршрут считается только по отмеченным.
        Выбрано: {mine.size} из {all.length}.
      </p>
      <fieldset class="checks">
        <legend>Учитывать курсы отделений</legend>
        <label class="check">
          <input type="radio" name="bm" checked={p.branchMode === 'mine'} onChange={() => s.setPrefs({ ...p, branchMode: 'mine' })} />
          только моих
        </label>
        <label class="check">
          <input type="radio" name="bm" checked={p.branchMode === 'all'} onChange={() => s.setPrefs({ ...p, branchMode: 'all' })} />
          всех
        </label>
      </fieldset>
      <div class="row2">
        <label class="field">
          <span>Поиск</span>
          <input type="search" placeholder="улица, банк…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Город</span>
          <select value={city} onChange={(e) => setCity((e.target as HTMLSelectElement).value)}>
            <option value="">все</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <div class="actions small">
        <button class="link" onClick={() => set(shown.map((b) => b.key), true)}>Отметить показанные ({shown.length})</button>
        <button class="link" onClick={() => set(shown.map((b) => b.key), false)}>Снять показанные</button>
      </div>
      <ul class="branch-list">
        {shown.map((b) => (
          <li key={b.key}>
            <label class="check">
              <input type="checkbox" checked={mine.has(b.key)} onChange={(e) => set([b.key], (e.target as HTMLInputElement).checked)} />
              <span>
                {b.name}
                <span class="muted small"> · {b.source}</span>
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li class="muted">Ничего не найдено.</li>}
      </ul>
    </section>
  );
}

function Other({ s }: { s: AppState }) {
  const p = s.prefs;
  return (
    <section class="card">
      <h2 class="h3">Устаревшие курсы</h2>
      <label class="check">
        <input type="checkbox" checked={p.excludeStale} onChange={(e) => s.setPrefs({ ...p, excludeStale: (e.target as HTMLInputElement).checked })} />
        Не использовать курсы старше {s.config.settings.staleAfterHours} ч (иначе — с пометкой «курс устарел»)
      </label>
    </section>
  );
}

function Rules({ s }: { s: AppState }) {
  const r = s.config.settings.routing;
  const unverifiedFees = s.config.fees.filter((f) => !f.verified);
  return (
    <section class="card">
      <h2 class="h3">Правила расчёта</h2>
      <ul class="list small">
        {s.config.fees.map((f) => (
          <li key={f.id}>
            {f.label}
            {!f.verified && <span class="flag flag-fee-unverified inline">не проверено</span>}
            {f.note && <div class="muted">{f.note}</div>}
          </li>
        ))}
        {r.cashRounding.enabled && (
          <li>
            Наличные выдаются целыми единицами, сдача — в исходной валюте.
            {!r.cashRounding.verified && <span class="flag flag-rounding-unverified inline">не проверено</span>}
          </li>
        )}
        {r.minorUnits.enabled && (
          <li>
            Безналичные суммы и сдача округляются вниз до {r.minorUnits.defaultDecimals} знаков (копейки/бани).
            {!r.minorUnits.verified && <span class="flag flag-minor-rounding-unverified inline">не проверено</span>}
          </li>
        )}
        {s.config.transitions.length === 0 && (
          <li>Переходы между каналами (снятие, пополнение, переводы) не заданы — маршрут не меняет канал без обмена.</li>
        )}
      </ul>
      {unverifiedFees.length > 0 && <p class="small muted">Непроверенные правила применяются как осторожная оценка.</p>}
    </section>
  );
}

function About() {
  const u = useUpdateState();
  const commitUrl = BUILD.repo && /^[0-9a-f]{7}$/.test(BUILD.commit) ? `https://github.com/${BUILD.repo}/commit/${BUILD.commit}` : '';
  return (
    <section class="card">
      <h2 class="h3">О приложении</h2>
      <ul class="list small">
        <li>
          Версия <strong>{BUILD.version}</strong>, коммит{' '}
          {commitUrl ? <a href={commitUrl} target="_blank" rel="noopener noreferrer"><code>{BUILD.commit}</code></a> : <code>{BUILD.commit}</code>}
        </li>
        <li>Сборка: {fmtDateTime(BUILD.builtAt)} ({fmtAge(BUILD.builtAt)})</li>
        <li>
          {u.unsupported
            ? 'Обновления: service worker недоступен в этом браузере.'
            : u.needRefresh
              ? 'Доступна новая версия.'
              : u.checking
                ? 'Проверяю обновления…'
                : u.lastCheck
                  ? `Установлена последняя версия (проверено ${fmtDateTime(u.lastCheck)}).`
                  : 'Обновления ещё не проверялись.'}
          {u.error && <div class="error-text">Не удалось проверить: {u.error}</div>}
        </li>
      </ul>
      <div class="actions">
        {u.needRefresh ? (
          <button class="primary" onClick={applyUpdate}>Обновить</button>
        ) : (
          <button onClick={() => void checkForUpdate()} disabled={u.checking || u.unsupported}>Проверить обновления</button>
        )}
      </div>
    </section>
  );
}
