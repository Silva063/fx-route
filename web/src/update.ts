import { useEffect, useState } from 'preact/hooks';
import { registerSW } from 'virtual:pwa-register';

/**
 * Обновление приложения. Service worker в режиме «по запросу» (prompt): новая версия скачивается
 * в фоне и ждёт; приложение показывает плашку «Доступна новая версия — обновить».
 * Проверка — при каждом запуске, при возвращении во вкладку/приложение и раз в 30 минут.
 */

export interface UpdateState {
  /** Новая версия скачана и ждёт — можно обновить. */
  needRefresh: boolean;
  checking: boolean;
  lastCheck?: string;
  error?: string;
  /** Service worker не поддерживается или не зарегистрирован (например, в режиме разработки). */
  unsupported: boolean;
}

const CHECK_EVERY_MS = 30 * 60 * 1000;

let state: UpdateState = { needRefresh: false, checking: false, unsupported: !('serviceWorker' in navigator) };
const listeners = new Set<(s: UpdateState) => void>();
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
};

let registration: ServiceWorkerRegistration | undefined;
let updateSW: ((reload?: boolean) => Promise<void>) | undefined;

export function initUpdates() {
  if (state.unsupported) return;
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => set({ needRefresh: true }),
    onRegisteredSW: (_url, r) => {
      if (!r) return;
      registration = r;
      void checkForUpdate();
      setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkForUpdate();
      });
    },
    onRegisterError: (e) => set({ unsupported: true, error: String(e) }),
  });
}

/** Спросить сервер, нет ли новой версии (sw.js сравнивается побайтно, мимо HTTP-кеша). */
export async function checkForUpdate(): Promise<void> {
  if (!registration || state.checking || !navigator.onLine) return;
  set({ checking: true, error: undefined });
  try {
    await registration.update();
    // Уже скачанная, но не активированная версия (например, с прошлого запуска).
    if (registration.waiting) set({ needRefresh: true });
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    set({ checking: false, lastCheck: new Date().toISOString() });
  }
}

/** Активировать новую версию; страница перезагрузится сама, когда новый service worker возьмёт управление. */
export function applyUpdate() {
  if (updateSW) void updateSW(true);
  else location.reload();
}

export function useUpdateState(): UpdateState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** Версия сборки (подставляется Vite при сборке). */
export const BUILD = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  builtAt: __APP_BUILT_AT__,
  repo: __APP_REPO__,
};
