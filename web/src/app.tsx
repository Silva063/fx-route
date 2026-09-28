import { useEffect, useState } from 'preact/hooks';
import type { ManualData } from '../../src/core/schema';
import { loadData, type LoadedData } from './data';
import { loadManual, loadPrefs, saveManual, savePrefs, type Prefs } from './db';
import { ManualView } from './manual-view';
import { RouteView } from './route-view';
import { SettingsView } from './settings-view';
import { SourcesView } from './sources-view';
import type { AppState } from './state';

type Tab = 'route' | 'sources' | 'manual' | 'settings';
const TABS: [Tab, string, string][] = [
  ['route', 'Маршрут', '⇄'],
  ['sources', 'Источники', '◉'],
  ['manual', 'Мои курсы', '✎'],
  ['settings', 'Настройки', '⚙'],
];

export function App() {
  const [data, setData] = useState<LoadedData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [manual, setManualState] = useState<ManualData | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [tab, setTab] = useState<Tab>(() => {
    const t = location.hash.slice(1) as Tab;
    return TABS.some(([id]) => id === t) ? t : 'route';
  });

  useEffect(() => {
    loadData().then(setData, (e) => setFatal((e as Error).message));
    loadPrefs().then(setPrefsState);
    loadManual().then(setManualState);
    const onHash = () => {
      const t = location.hash.slice(1) as Tab;
      setTab(TABS.some(([id]) => id === t) ? t : 'route');
    };
    addEventListener('hashchange', onHash);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => (removeEventListener('online', on), removeEventListener('offline', off), removeEventListener('hashchange', onHash));
  }, []);

  useEffect(() => {
    history.replaceState(null, '', tab === 'route' ? location.pathname : `#${tab}`);
    scrollTo(0, 0);
  }, [tab]);

  if (fatal) {
    return (
      <main class="page">
        <div class="card error">
          <h2>Не удалось загрузить приложение</h2>
          <p>{fatal}</p>
          <p>Проверьте соединение и обновите страницу.</p>
        </div>
      </main>
    );
  }
  if (!data || !prefs || !manual) return <main class="page"><p class="muted center">Загрузка…</p></main>;

  const state: AppState = {
    config: data.config,
    rates: data.rates,
    ...(data.ratesError ? { ratesError: data.ratesError } : {}),
    prefs,
    manual,
    online,
    setPrefs: (p) => (setPrefsState(p), void savePrefs(p)),
    setManual: (m) => (setManualState(m), void saveManual(m)),
  };

  return (
    <>
      <main class="page">
        {tab === 'route' && <RouteView s={state} goTo={setTab} />}
        {tab === 'sources' && <SourcesView s={state} />}
        {tab === 'manual' && <ManualView s={state} />}
        {tab === 'settings' && <SettingsView s={state} />}
      </main>
      <nav class="tabbar" aria-label="Разделы">
        {TABS.map(([id, label, icon]) => (
          <button key={id} class={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <span class="tab-icon" aria-hidden="true">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
