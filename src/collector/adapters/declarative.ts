import { z } from 'zod';
import { parseDateLoose } from '../../core/time';
import type { RawQuote } from '../../core/types';
import type { Adapter } from '../adapter';
import { load, norm, rowsToQuotes, tableRows, type AnyNode, type Cheerio, type CheerioAPI } from './html';

/**
 * Декларативный адаптер «html-tables»: простой источник описывается в config/sources.json,
 * без кода. Таблица находится одним из способов:
 *  - selector: CSS-селектор самой таблицы;
 *  - heading: регулярка по тексту ближайшего предшествующего соседа таблицы (заголовка);
 *  - tab: вкладки — заголовки и панели сопоставляются по порядку, нужная ищется по регулярке заголовка.
 * expect — регулярка, которой обязан соответствовать текст контейнера таблицы
 * (защита от того, что после смены вёрстки селектор попадёт не в ту таблицу).
 */

const locateSchema = z.union([
  z.object({ selector: z.string() }),
  z.object({ heading: z.string(), scope: z.string().optional() }),
  z.object({
    tab: z.object({
      scope: z.string(),
      titles: z.string(),
      panels: z.string(),
      title: z.string(),
    }),
  }),
]);

const dateSchema = z.object({
  /** CSS-селектор элемента с датой; текст передаётся в parseDateLoose. */
  selector: z.string(),
  /** Необязательная регулярка с одной группой: из текста берётся только она. */
  regex: z.string().optional(),
});

const tableSpecSchema = z.object({
  table: z.string(),
  locate: locateSchema,
  expect: z.string().optional(),
  /** Селектор предка таблицы, в тексте которого проверяется expect (по умолчанию — родитель таблицы). */
  container: z.string().optional(),
  columns: z.object({
    code: z.number().int().min(0),
    buy: z.number().int().min(0),
    sell: z.number().int().min(0),
    nominal: z.number().int().min(0).optional(),
  }),
  date: dateSchema.optional(),
});

export const htmlTablesParamsSchema = z.object({
  url: z.string().url(),
  quote: z.string().regex(/^[A-Z]{3}$/),
  date: dateSchema.optional(),
  tables: z.array(tableSpecSchema).min(1),
});
export type HtmlTablesParams = z.infer<typeof htmlTablesParamsSchema>;

function findTable(
  $: CheerioAPI,
  locate: z.infer<typeof locateSchema>,
): { table: Cheerio<AnyNode>; container: Cheerio<AnyNode> } | null {
  if ('selector' in locate) {
    const table = $(locate.selector).first();
    return table.length ? { table, container: table.parent() } : null;
  }
  if ('heading' in locate) {
    const re = new RegExp(locate.heading, 'i');
    const tables = (locate.scope ? $(locate.scope).find('table') : $('table')).toArray();
    for (const el of tables) {
      const t = $(el);
      const heading = norm(t.prevAll().first().text());
      if (re.test(heading)) return { table: t, container: t.parent() };
    }
    return null;
  }
  const scope = $(locate.tab.scope).first();
  const titles = scope.find(locate.tab.titles).toArray();
  const panels = scope.find(locate.tab.panels).toArray();
  const re = new RegExp(locate.tab.title, 'i');
  const idx = titles.findIndex((t) => re.test(norm($(t).text())));
  if (idx < 0 || !panels[idx]) return null;
  const panel = $(panels[idx]);
  const table = panel.find('table').first();
  return table.length ? { table, container: panel } : null;
}

function readDate($: CheerioAPI, spec: z.infer<typeof dateSchema> | undefined): string | undefined {
  if (!spec) return undefined;
  let text = norm($(spec.selector).first().text());
  if (spec.regex) text = new RegExp(spec.regex, 'i').exec(text)?.[1] ?? '';
  return parseDateLoose(text) ?? undefined;
}

export const htmlTablesAdapter: Adapter = async (ctx) => {
  const params = htmlTablesParamsSchema.parse(ctx.source.params);
  const res = await ctx.http.getText(params.url);
  const $ = load(res.text);
  const pageDate = readDate($, params.date);
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];

  for (const spec of params.tables) {
    const found = findTable($, spec.locate);
    if (!found) {
      warnings.push(`таблица «${spec.table}» не найдена`);
      continue;
    }
    const container = spec.container ? found.table.closest(spec.container) : found.container;
    if (spec.expect && !new RegExp(spec.expect, 'i').test(norm(container.text()))) {
      warnings.push(`таблица «${spec.table}»: подпись не совпала с ожидаемой (${spec.expect})`);
      continue;
    }
    const validFrom = readDate($, spec.date) ?? pageDate;
    const rows = rowsToQuotes(tableRows($, found.table), {
      table: spec.table,
      quote: params.quote,
      columns: spec.columns,
      ...(validFrom ? { validFrom } : {}),
    });
    if (rows.length === 0) warnings.push(`таблица «${spec.table}» пуста`);
    quotes.push(...rows);
  }
  return {
    batches: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, quotes }],
    ...(warnings.length ? { warnings } : {}),
  };
};
