import { parseRate } from '../../core/numbers';
import { dmyToIso, localDate, parseDateLoose } from '../../core/time';
import type { Adapter, OfficialBatch } from '../adapter';
import { load, norm, tableRows } from './html';

/** Нацбанк Молдовы: XML официальных курсов на сегодняшнюю дату (по Кишинёву). */
export const bnmAdapter: Adapter = async (ctx) => {
  const today = localDate(ctx.now());
  const [y, m, d] = today.split('-');
  const url = `https://www.bnm.md/ro/official_exchange_rates?get_xml=1&date=${d}.${m}.${y}`;
  const res = await ctx.http.getText(url);
  const $ = load(res.text, { xml: true });
  const validFor = dmyToIso($('ValCurs').attr('Date') ?? '');
  if (!validFor) throw new Error('BNM: в XML нет даты ValCurs/@Date');
  const rates: Record<string, number> = {};
  $('Valute').each((_, el) => {
    const v = $(el);
    const code = v.find('CharCode').text().trim();
    const nominal = parseRate(v.find('Nominal').text()) ?? 1;
    const value = parseRate(v.find('Value').text());
    if (/^[A-Z]{3}$/.test(code) && value !== null) rates[code] = value / nominal;
  });
  const batch: OfficialBatch = { sourceUrl: res.url, fetchedAt: res.fetchedAt, base: 'MDL', validFor, rates };
  return Object.keys(rates).length ? { official: [batch] } : {};
};

/** Приднестровский республиканский банк: таблица официальных курсов (публикуется на следующий день). */
export const prbAdapter: Adapter = async (ctx) => {
  const res = await ctx.http.getText(ctx.source.ratesUrl);
  const $ = load(res.text);
  // Страница свёрстана вложенными таблицами: берём ту, у которой в собственной первой строке
  // есть ячейки ровно «Букв. код» и «Единиц» (внешние таблицы вёрстки содержат этот текст глубже).
  const headerOf = (t: ReturnType<typeof $>) =>
    t.find('tr').first().children('th,td').toArray().map((c) => norm($(c).text()));
  const table = $('table')
    .toArray()
    .map((t) => $(t))
    .find((t) => {
      const h = headerOf(t);
      return h.some((c) => /^Букв\.\s*код$/.test(c)) && h.some((c) => /^Единиц$/.test(c));
    });
  if (!table) return {};
  const header = headerOf(table);
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const codeCol = col(/Букв\.\s*код/);
  const unitCol = col(/Единиц/);
  const rateCol = col(/^Курс$/);
  if (codeCol < 0 || unitCol < 0 || rateCol < 0) throw new Error('ПРБ: не найдены столбцы таблицы курсов');

  // «Курс валют c 29.09.2026» — дата действия.
  const dateText = /Курс валют\s*c\s*(\d{2}\.\d{2}\.\d{4})/.exec(norm($('body').text()))?.[1];
  const validFor = dateText ? parseDateLoose(dateText) : null;
  if (!validFor) throw new Error('ПРБ: не найдена дата «Курс валют c ДД.ММ.ГГГГ»');

  const rates: Record<string, number> = {};
  for (const cells of tableRows($, table).slice(1)) {
    const code = cells[codeCol] ?? '';
    const unit = parseRate(cells[unitCol]) ?? 1;
    const value = parseRate(cells[rateCol]);
    if (/^[A-Z]{3}$/.test(code) && value !== null) rates[code] = value / unit;
  }
  if (!Object.keys(rates).length) return {};
  return { official: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, base: 'RUP', validFor, rates }] };
};
