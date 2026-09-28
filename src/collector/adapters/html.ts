import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Cheerio } from 'cheerio';
import { parseRate } from '../../core/numbers';
import type { RawQuote } from '../../core/types';

export { load };
export type { CheerioAPI, Cheerio, AnyNode };

export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Строки таблицы как массивы текстов ячеек (th и td). */
export function tableRows($: CheerioAPI, table: Cheerio<AnyNode>): string[][] {
  return table
    .find('tr')
    .toArray()
    .map((tr) =>
      $(tr)
        .children('th,td')
        .toArray()
        .map((c) => norm($(c).text())),
    );
}

/**
 * Код валюты из текста ячейки: «USD», «Dolar S.U.A. (USD)», «USD Доллар США».
 * Берётся код в скобках, иначе первое слово из трёх заглавных латинских букв.
 */
export function currencyCode(text: string): string | null {
  const inParens = /\(([A-Z]{3})\)/.exec(text);
  if (inParens) return inParens[1]!;
  const word = /(?:^|[^A-Za-z])([A-Z]{3})(?![A-Za-z])/.exec(text);
  return word ? word[1]! : null;
}

export interface RowColumns {
  code: number;
  buy: number;
  sell: number;
  nominal?: number;
}

/**
 * Строки таблицы → котировки к валюте quote. Строки без кода валюты (заголовки) пропускаются.
 * Числа без данных («-», «0.0000») дают null: курс не подставляется.
 */
export function rowsToQuotes(
  rows: string[][],
  opts: { table: string; quote: string; columns: RowColumns; branch?: string; validFrom?: string },
): RawQuote[] {
  const out: RawQuote[] = [];
  for (const cells of rows) {
    const code = currencyCode(cells[opts.columns.code] ?? '');
    if (!code || code === opts.quote) continue;
    const nominal = opts.columns.nominal !== undefined ? parseRate(cells[opts.columns.nominal]) : 1;
    const q: RawQuote = {
      table: opts.table,
      base: code,
      quote: opts.quote,
      nominal: nominal ?? 1,
      buy: parseRate(cells[opts.columns.buy]),
      sell: parseRate(cells[opts.columns.sell]),
    };
    if (opts.branch) q.branch = opts.branch;
    if (opts.validFrom) q.validFrom = opts.validFrom;
    if (q.buy !== null || q.sell !== null) out.push(q);
  }
  return out;
}

/** Короткий стабильный id отделения из текста: «Sucursala nr.3» → «sucursala-nr-3». */
export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
