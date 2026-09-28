import type { Branch, RawQuote } from '../../core/types';
import { parseRate } from '../../core/numbers';
import { localDate, parseDateLoose, zonedLocalToIso } from '../../core/time';
import type { Adapter, QuoteBatch } from '../adapter';
import { load, norm, rowsToQuotes, slug, tableRows } from './html';

// ---------------- Victoriabank ----------------

interface VbResponse {
  rates: {
    currencyMarket: string;
    fromDate: string;
    currencies: { currency: string; currencyRates: { baseCurrency: string; nominal: number; buyRate: number; sellRate: number }[] }[];
  }[];
}

/**
 * Victoriabank: внутренний JSON /bff/api/currency-rates. marketType=11 — наличные, 14 — онлайн
 * (13 — внутренние расчёты, не обмен, не запрашивается). За день бывает несколько записей:
 * берётся последняя по fromDate (местное время Кишинёва). Отделение для наличных — из подписи
 * на странице «Cursurile valutare afișate sunt valabile pentru Sucursala nr.3».
 */
export const victoriabankAdapter: Adapter = async (ctx) => {
  const day = localDate(ctx.now());
  const markets: [string, number, RegExp][] = [
    ['cash', 11, /numerar/i],
    ['online', 14, /online/i],
  ];
  const batches: QuoteBatch[] = [];
  const warnings: string[] = [];
  const branches: Branch[] = [];

  let branch: Branch | undefined;
  try {
    const page = await ctx.http.getText('https://www.victoriabank.md/curs-valutar');
    const m = /valabile pentru\s+(Sucursala\s+nr\.?\s*\d+)/i.exec(norm(load(page.text)('body').text()));
    if (m) {
      branch = { id: slug(m[1]!), name: m[1]!.replace(/\s+/g, ' ') };
      branches.push(branch);
    } else warnings.push('на странице не найдено, для какого отделения действуют наличные курсы');
  } catch (e) {
    warnings.push(`страница курсов не получена: ${(e as Error).message}`);
  }

  for (const [table, marketType, nameRe] of markets) {
    const url = `https://www.victoriabank.md/bff/api/currency-rates?dateFrom=${day}&dateTo=${day}&marketType=${marketType}&lang=ro-RO`;
    const { data, response } = await ctx.http.getJson<VbResponse>(url);
    const entries = (data.rates ?? []).filter((r) => nameRe.test(r.currencyMarket));
    const nowIso = ctx.now().toISOString();
    const withIso = entries
      .map((r) => ({ r, iso: zonedLocalToIso(r.fromDate) }))
      .filter((x): x is { r: (typeof entries)[number]; iso: string } => !!x.iso && x.iso <= nowIso)
      .sort((a, b) => a.iso.localeCompare(b.iso));
    const latest = withIso.at(-1);
    if (!latest) {
      warnings.push(`marketType=${marketType}: нет курсов на ${day}`);
      continue;
    }
    const quotes: RawQuote[] = [];
    for (const c of latest.r.currencies) {
      for (const cr of c.currencyRates) {
        if (!/^[A-Z]{3}$/.test(c.currency) || cr.baseCurrency !== 'MDL') continue;
        const q: RawQuote = {
          table,
          base: c.currency,
          quote: 'MDL',
          nominal: cr.nominal > 0 ? cr.nominal : 1,
          buy: parseRate(cr.buyRate),
          sell: parseRate(cr.sellRate),
          validFrom: latest.iso,
        };
        if (table === 'cash' && branch) q.branch = branch.id;
        quotes.push(q);
      }
    }
    batches.push({ sourceUrl: response.url, fetchedAt: response.fetchedAt, quotes });
  }
  return { batches, ...(branches.length ? { branches } : {}), ...(warnings.length ? { warnings } : {}) };
};

// ---------------- Moldindconbank ----------------

/** MICB: блок «Curs valutar» на главной; вкладки data-exchangeTab=cash|card, ячейки .buy_XXX / .sell_XXX. */
export const micbAdapter: Adapter = async (ctx) => {
  const res = await ctx.http.getText(ctx.source.ratesUrl);
  const $ = load(res.text);
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];
  for (const [table, tab] of [
    ['cash', 'cash'],
    ['card', 'card'],
  ] as const) {
    const pane = $(`.tab-content[data-exchangeTab="${tab}"], .tab-content[data-exchangetab="${tab}"]`).first();
    const codes = pane
      .find('[class*="buy_"]')
      .toArray()
      .map((el) => /\bbuy_([A-Z]{3})\b/.exec($(el).attr('class') ?? '')?.[1])
      .filter((c): c is string => !!c);
    if (!codes.length) {
      warnings.push(`вкладка ${tab} не найдена или пуста`);
      continue;
    }
    for (const code of codes) {
      quotes.push({
        table,
        base: code,
        quote: 'MDL',
        buy: parseRate(norm(pane.find(`.buy_${code}`).first().text())),
        sell: parseRate(norm(pane.find(`.sell_${code}`).first().text())),
      });
    }
  }
  return { batches: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, quotes }], ...(warnings.length ? { warnings } : {}) };
};

// ---------------- FinComBank ----------------

const FCB = 'https://fincombank.com';

/**
 * FinComBank: наличные по каждому отделению. Страница показывает таблицу выбранного по умолчанию
 * отделения; остальные — AJAX POST index.php?ajaxCall=Excanges/ajaxGetRatesByFilialDate (как делает сам сайт).
 * Карточные курсы — отдельная страница; дата — первая дата в архиве на ней.
 */
export const fincombankAdapter: Adapter = async (ctx) => {
  const batches: QuoteBatch[] = [];
  const warnings: string[] = [];
  const branches: Branch[] = [];

  const page = await ctx.http.getText(`${FCB}/ro/curs-valutar`);
  const $ = load(page.text);
  const options = $('select option')
    .toArray()
    .map((o) => ({ id: ($(o).attr('value') ?? '').trim(), name: norm($(o).text()), selected: $(o).is('[selected]') }))
    .filter((o) => /^\d+$/.test(o.id));
  const dateInput = ($('#filials_date').attr('value') ?? '').trim();
  const [y, m, d] = localDate(ctx.now()).split('-');
  const date = /^\d{2}\.\d{2}\.\d{4}$/.test(dateInput) ? dateInput : `${d}.${m}.${y}`;
  const cols = { code: 0, buy: 1, sell: 2 };

  const selected = options.find((o) => o.selected);
  const mainTable = $('table.cursTable').first();
  if (selected && mainTable.length) {
    branches.push({ id: selected.id, name: selected.name });
    const quotes = rowsToQuotes(tableRows($, mainTable), { table: 'cash-branch', quote: 'MDL', columns: cols, branch: selected.id });
    batches.push({ sourceUrl: page.url, fetchedAt: page.fetchedAt, quotes });
  } else warnings.push('таблица наличных курсов выбранного отделения не найдена');

  for (const o of options.filter((x) => !x.selected)) {
    try {
      const body = new URLSearchParams({
        fktype: o.id,
        date,
        htmlRates: 'htmlFilialsRates',
        htmlConvertor: 'htmlFililsCurrencies',
      }).toString();
      const { data, response } = await ctx.http.getJson<{ id?: string; html?: string }[]>(
        `${FCB}/index.php?ajaxCall=Excanges/ajaxGetRatesByFilialDate`,
        { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } },
      );
      const html = (Array.isArray(data) ? data : []).find((x) => x.id === 'htmlFilialsRates')?.html;
      if (html === undefined) {
        warnings.push(`отделение ${o.id}: в ответе нет блока курсов`);
        continue;
      }
      if (html.trim() === '') {
        // Отделение само не публикует курсы (так на 28.09.2026 у двух отделений в Дрокии) — нет данных.
        ctx.log(`отделение ${o.id} (${o.name}): курсы не опубликованы`);
        continue;
      }
      const f = load(`<table>${html}</table>`);
      const quotes = rowsToQuotes(tableRows(f, f('table').first()), { table: 'cash-branch', quote: 'MDL', columns: cols, branch: o.id });
      if (!quotes.length) {
        warnings.push(`отделение ${o.id}: курсы не распознаны`);
        continue;
      }
      branches.push({ id: o.id, name: o.name });
      batches.push({ sourceUrl: `${page.url}#filial-${o.id}`, fetchedAt: response.fetchedAt, quotes });
    } catch (e) {
      // Ошибка одного отделения не отменяет остальные.
      warnings.push(`отделение ${o.id}: ${(e as Error).message}`);
    }
  }

  try {
    const card = await ctx.http.getText(`${FCB}/ro/curs-valutar-pentru-carduri`);
    const c = load(card.text);
    const table = c('table.themes1').first();
    const validFrom = parseDateLoose(norm(c('#htmlExcangesGrid').first().text())) ?? undefined;
    const quotes = rowsToQuotes(tableRows(c, table), {
      table: 'card',
      quote: 'MDL',
      columns: cols,
      ...(validFrom ? { validFrom } : {}),
    });
    if (quotes.length) batches.push({ sourceUrl: card.url, fetchedAt: card.fetchedAt, quotes });
    else warnings.push('карточные курсы не найдены');
  } catch (e) {
    warnings.push(`карточные курсы: ${(e as Error).message}`);
  }

  return { batches, ...(branches.length ? { branches } : {}), ...(warnings.length ? { warnings } : {}) };
};

// ---------------- EuroCreditBank ----------------

/**
 * EuroCreditBank: главная страница.
 * Блок «Curs valutar»: вкладки Numerar (sector-1) и Carduri (sector-2) — последовательность
 * .currname / покупка / продажа / BNM. Блок «Curs valutar agentii»: курсы всех агентств
 * в атрибутах data-unit-<id отделения> ячеек .cvpurchase / .cvsell.
 */
export const eurocreditbankAdapter: Adapter = async (ctx) => {
  const res = await ctx.http.getText(ctx.source.ratesUrl);
  const $ = load(res.text);
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];
  const branches: Branch[] = [];

  const informer = $('.fast-informer.exchange-type').first();
  const validFrom = parseDateLoose(norm(informer.find('.date').first().text())) ?? undefined;
  const tabs = informer
    .find('.informer-tabs .tab[data-id]')
    .toArray()
    .map((t) => ({ id: $(t).attr('data-id')!, title: norm($(t).text()) }));
  for (const [table, titleRe] of [
    ['cash', /^Numerar$/i],
    ['card', /^Carduri$/i],
  ] as const) {
    const tab = tabs.find((t) => titleRe.test(t.title));
    const sector = tab ? informer.find(`.sector-${tab.id}`).first() : null;
    if (!sector?.length) {
      warnings.push(`вкладка ${titleRe.source} не найдена`);
      continue;
    }
    sector.find('.currname').each((_, el) => {
      const code = norm($(el).text());
      const vals = $(el).nextAll('.currval').toArray().slice(0, 2).map((v) => parseRate(norm($(v).text())));
      if (!/^[A-Z]{3}$/.test(code)) return;
      quotes.push({ table, base: code, quote: 'MDL', buy: vals[0] ?? null, sell: vals[1] ?? null, ...(validFrom ? { validFrom } : {}) });
    });
  }

  const agencies = $('.fast-informer.branch-informer').first();
  const agencyDate = parseDateLoose(norm(agencies.find('.date').first().text())) ?? validFrom;
  const options = agencies
    .find('select.branch-select option')
    .toArray()
    .map((o) => ({ id: ($(o).attr('value') ?? '').trim(), name: norm($(o).text()) }))
    .filter((o) => /^\d+$/.test(o.id));
  if (!options.length) warnings.push('блок курсов по агентствам не найден');
  for (const o of options) {
    let n = 0;
    agencies.find('.currname').each((_, el) => {
      const code = norm($(el).text());
      if (!/^[A-Z]{3}$/.test(code)) return;
      const buy = parseRate($(el).nextAll('.cvpurchase').first().attr(`data-unit-${o.id}`));
      const sell = parseRate($(el).nextAll('.cvsell').first().attr(`data-unit-${o.id}`));
      if (buy === null && sell === null) return;
      quotes.push({ table: 'agencies', base: code, quote: 'MDL', buy, sell, branch: o.id, ...(agencyDate ? { validFrom: agencyDate } : {}) });
      n++;
    });
    if (n) branches.push({ id: o.id, name: o.name });
  }
  return {
    batches: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, quotes }],
    ...(branches.length ? { branches } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
};

// ---------------- Comerțbank ----------------

/**
 * Comerțbank: главная страница без www (с www — петля редиректов).
 * Блок «Curs valutar»: .vault.v_banka (вкладка COMERTBANK) и .vault.v_card (CARD);
 * столбцы .vault_cell: коды, покупка, продажа.
 */
export const comertbankAdapter: Adapter = async (ctx) => {
  const res = await ctx.http.getText(ctx.source.ratesUrl);
  const $ = load(res.text);
  const block = $('.exchange').first();
  const validFrom = parseDateLoose(norm(block.find('.exchange_date').first().text())) ?? undefined;
  const quotes: RawQuote[] = [];
  const warnings: string[] = [];
  for (const [table, sel] of [
    ['comertbank', '.vault.v_banka'],
    ['card', '.vault.v_card'],
  ] as const) {
    const cells = block.find(sel).first().find('.vault_cell').toArray().map((c) => $(c));
    const header = cells.map((c) => norm(c.find('.vault_name').text()));
    const buyCol = header.findIndex((h) => /Cumpărare/i.test(h));
    const sellCol = header.findIndex((h) => /Vânzare/i.test(h));
    if (cells.length < 3 || buyCol < 0 || sellCol < 0) {
      warnings.push(`блок ${sel} не найден`);
      continue;
    }
    const codes = cells[0]!.find('.vault_symbol').toArray().map((e) => norm($(e).text()));
    const buys = cells[buyCol]!.find('.vault_nr').toArray().map((e) => parseRate(norm($(e).text())));
    const sells = cells[sellCol]!.find('.vault_nr').toArray().map((e) => parseRate(norm($(e).text())));
    codes.forEach((code, i) => {
      if (!/^[A-Z]{3}$/.test(code)) return;
      quotes.push({ table, base: code, quote: 'MDL', buy: buys[i] ?? null, sell: sells[i] ?? null, ...(validFrom ? { validFrom } : {}) });
    });
  }
  return { batches: [{ sourceUrl: res.url, fetchedAt: res.fetchedAt, quotes }], ...(warnings.length ? { warnings } : {}) };
};
