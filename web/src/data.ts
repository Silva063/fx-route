import { emptyRates, mergeRates } from '../../src/core/merge';
import { ratesFileSchema } from '../../src/core/schema';
import type { FeeRule, RatesFile, Settings, SourceDef, TableDef, Transition } from '../../src/core/types';

/** Публичная часть конфигов (web/public/data/config.json, готовит scripts/prepare-web-data.ts). */
export interface PublicSource {
  id: string;
  name: string;
  jurisdiction: SourceDef['jurisdiction'];
  kind: SourceDef['kind'];
  website: string;
  ratesUrl: string;
  collect: SourceDef['collect'];
  manualReason?: string;
  tables: Record<string, TableDef>;
  note?: string;
}

export interface PublicConfig {
  sources: PublicSource[];
  fees: FeeRule[];
  transitions: Transition[];
  settings: Pick<Settings, 'staleAfterHours' | 'plausibility' | 'routing'>;
}

export interface LoadedData {
  config: PublicConfig;
  /** null — курсов нет (не опубликованы или не загрузились). Курсы не подставляются. */
  rates: RatesFile | null;
  ratesError?: string;
}

/**
 * Откуда брать курсы. На GitHub Pages — из ветки `data` через raw.githubusercontent.com
 * (VITE_RATES_URL задаёт pages.yml): курсы обновляются без пересборки сайта. CDN кеширует
 * файл до 5 минут. Локально (npm run dev/preview) — data/rates.json рядом с приложением.
 */
export const RATES_URL: string = import.meta.env.VITE_RATES_URL || 'data/rates.json';

async function getJson(url: string): Promise<unknown> {
  // Только «простой» запрос без своих заголовков: raw.githubusercontent.com отвечает 403 на CORS-preflight.
  // cache: 'no-cache' — браузер переспрашивает сервер; без сети ответ отдаёт service worker из своего кеша.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function loadData(): Promise<LoadedData> {
  const config = (await getJson('data/config.json')) as PublicConfig;
  try {
    const parsed = ratesFileSchema.safeParse(await getJson(RATES_URL));
    if (!parsed.success) return { config, rates: null, ratesError: 'Файл курсов повреждён' };
    // Та же нормализация, что при публикации: статусы по местам сбора, старое 'local' → 'pc',
    // очистка успехов, приписанных не тому месту сбора (файлы старого формата). Сроки хранения
    // здесь не применяются — это делает сборщик.
    const rates = mergeRates(parsed.data as RatesFile, emptyRates(new Date(0)), {
      now: new Date(),
      retainOffersDays: 3650,
      retainOfficialDays: 3650,
    });
    return { config, rates };
  } catch (e) {
    return { config, rates: null, ratesError: (e as Error).message };
  }
}
