import { openDB, type IDBPDatabase } from 'idb';
import type { ManualData } from '../../src/core/schema';
import type { Channel } from '../../src/core/types';

/**
 * Локальное хранилище в IndexedDB: настройки пользователя и ручные курсы.
 * Оба хранятся целиком одним документом — так проще экспорт/импорт.
 */

export interface Prefs {
  /** «Мои счета»: банки, где у меня есть карта или онлайн-банк. */
  myAccounts: string[];
  allowedChannels: Channel[];
  branchMode: 'mine' | 'all';
  myBranches: string[];
  excludeStale: boolean;
  lastQuery: {
    amount: number;
    from: string;
    fromChannel: Channel;
    fromAccount?: string;
    to: string;
    toChannels: Channel[];
  };
}

export const DEFAULT_PREFS: Prefs = {
  myAccounts: [],
  allowedChannels: ['cash', 'card', 'online'],
  branchMode: 'mine',
  myBranches: [],
  excludeStale: false,
  lastQuery: { amount: 10000, from: 'RUP', fromChannel: 'cash', to: 'MDL', toChannels: ['cash'] },
};

export const emptyManual = (): ManualData => ({
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  points: [],
  quotes: [],
  myBranches: [],
});

let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB('fx-route', 1, { upgrade: (d) => void d.createObjectStore('kv') }));

async function get<T>(key: string, fallback: T): Promise<T> {
  try {
    return ((await (await db()).get('kv', key)) as T | undefined) ?? fallback;
  } catch {
    // IndexedDB недоступна (приватный режим и т.п.) — работаем без сохранения.
    return fallback;
  }
}

async function put(key: string, value: unknown): Promise<void> {
  try {
    await (await db()).put('kv', value, key);
  } catch {
    /* см. get */
  }
}

export const loadPrefs = async (): Promise<Prefs> => ({ ...DEFAULT_PREFS, ...(await get<Partial<Prefs>>('prefs', {})) });
export const savePrefs = (p: Prefs) => put('prefs', p);
export const loadManual = () => get<ManualData>('manual', emptyManual());
export const saveManual = (m: ManualData) => put('manual', m);
