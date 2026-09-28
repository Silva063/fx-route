import { parseRate } from '../../core/numbers';
import { parseDateLoose } from '../../core/time';
import type { RawQuote } from '../../core/types';
import type { Adapter } from '../adapter';
import { load, norm, tableRows } from './html';

/**
 * Агропромбанк: всё из HTML страницы курсов (в JSON у APB Online нет кросс-пар USD/MDL и т.п.).
 * #cr-table — «Текущие коммерческие курсы», #ib-table — «APB Online». Даты — #cr-date, #ib-date.
 * Остальные таблицы (для комиссий, кредитов, официальные) не читаются.
 */
export const agroprombankAdapter: Adapter = async (ctx) => {
  const res = await ctx.http.getText(ctx.source.ratesUrl);
  const $ = load(res.text);
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];
  const tables: [string, string, string][] = [
    ['commercial', '#cr-table', '#cr-date'],
    ['apb-online', '#ib-table', '#ib-date'],
  ];
  for (const [table, sel, dateSel] of tables) {
    const t = $(sel).find('table').first();
    if (!t.length) {
      warnings.push(`таблица ${sel} не найдена`);
      continue;
    }
    const validFrom = parseDateLoose(norm($(dateSel).text())) ?? undefined;
    let n = 0;
    for (const cells of tableRows($, t)) {
      // Ячейка пары: «USD/RUP Доллар США/Рубль ПМР»; затем покупка и продажа.
      const pairCell = cells.findIndex((c) => /^[A-Z]{3}\/[A-Z]{3}\b/.test(c));
      if (pairCell < 0) continue;
      const [base, quote] = cells[pairCell]!.slice(0, 7).split('/') as [string, string];
      const q: RawQuote = {
        table,
        base,
        quote,
        buy: parseRate(cells[pairCell + 1]),
        sell: parseRate(cells[pairCell + 2]),
      };
      if (validFrom) q.validFrom = validFrom;
      quotes.push(q);
      n++;
    }
    if (!n) warnings.push(`таблица ${sel} пуста`);
  }
  return {
    batches: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, quotes }],
    ...(warnings.length ? { warnings } : {}),
  };
};

interface PrisbankGroup {
  id: number;
  name: string;
  courses: { abbr: string; buy: number | null; sale: number | null; tarif?: number }[];
}

/**
 * Приднестровский Сбербанк: открытый JSON api.prisbank.com/courses.
 * Группы сопоставляются по id и проверяются по названию — при расхождении группа пропускается с предупреждением.
 */
export const prisbankAdapter: Adapter = async (ctx) => {
  const url = 'https://api.prisbank.com/courses';
  const { data, response } = await ctx.http.getJson<PrisbankGroup[]>(url);
  if (!Array.isArray(data)) throw new Error('Сбербанк ПМР: ответ API не массив групп');
  const groups: [string, number, RegExp][] = [
    ['cash', 2, /^Наличные курсы/i],
    ['commercial-individuals', 4, /^Коммерческий курс для физических лиц/i],
  ];
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];
  for (const [table, id, nameRe] of groups) {
    const g = data.find((x) => x.id === id);
    if (!g || !nameRe.test(g.name)) {
      warnings.push(`группа ${id} (${nameRe.source}) не найдена или переименована`);
      continue;
    }
    for (const c of g.courses) {
      if (!/^[A-Z]{3}$/.test(c.abbr) || c.abbr === 'RUP') continue;
      quotes.push({
        table,
        base: c.abbr,
        quote: 'RUP',
        nominal: c.tarif && c.tarif > 0 ? c.tarif : 1,
        buy: parseRate(c.buy),
        sell: parseRate(c.sale),
      });
    }
  }
  return {
    batches: [{ sourceUrl: response.url, fetchedAt: response.fetchedAt, quotes }],
    ...(warnings.length ? { warnings } : {}),
  };
};
