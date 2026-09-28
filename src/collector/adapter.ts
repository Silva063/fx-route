import type { Branch, RawQuote, SourceDef } from '../core/types';
import type { HttpClient } from './http';

/** Котировки, полученные одним ответом сервера (у них общие URL и время получения). */
export interface QuoteBatch {
  sourceUrl: string;
  fetchedAt: string;
  quotes: RawQuote[];
}

export interface OfficialBatch {
  sourceUrl: string;
  fetchedAt: string;
  /** Базовая валюта: в ней выражены курсы (MDL у BNM, RUP у ПРБ). */
  base: string;
  /** Дата действия (YYYY-MM-DD). */
  validFor: string;
  /** Курс за 1 единицу валюты (номинал уже учтён). */
  rates: Record<string, number>;
}

export interface AdapterOutput {
  batches?: QuoteBatch[];
  official?: OfficialBatch[];
  branches?: Branch[];
  /** Некритичные проблемы: например, одна из таблиц не найдена. Статус источника станет partial. */
  warnings?: string[];
}

export interface AdapterContext {
  source: SourceDef;
  http: HttpClient;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * Адаптер источника. Получает страницы через ctx.http (вежливый клиент),
 * возвращает котировки как опубликовано. Белый список таблиц, проверки правдоподобности
 * и превращение в предложения делает ядро — адаптер этим не занимается.
 * Адаптер не должен подставлять значения: нет числа — нет котировки (см. parseRate).
 */
export type Adapter = (ctx: AdapterContext) => Promise<AdapterOutput>;
