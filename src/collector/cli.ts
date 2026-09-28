import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyRegistry, emptyRates, mergeRates } from '../core/merge';
import { FLAG_LABELS, findRoutes } from '../core/routes';
import { ratesFileSchema } from '../core/schema';
import type { Channel } from '../core/types';
import type { RatesFile } from '../core/types';
import { adapters } from './adapters/index';
import { loadConfig, type ProjectConfig } from './config';
import { RecordingHttp } from './fixtures';
import { PoliteHttp } from './http';
import { runCollection } from './run';

const USAGE = `Использование:
  npm run collect -- [--only id1,id2] [--out data/rates.json] [--runner имя] [--config config]
  npm run merge -- <a.json> <b.json> [--out data/rates.json] [--config config]
  npm run capture -- [--only id1,id2]   (перезаписать фикстуры адаптеров в test/fixtures/sources)
  npm run route -- <сумма> <из> <в> [--from-channel cash] [--to-channels cash,card] [--accounts maib,micb]
                   [--branches all|mine] [--my-branches fincombank|123,...] [--at 2026-09-29T09:00] [--exclude-stale]`;

async function readRates(path: string): Promise<RatesFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const parsed = ratesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // Не перезаписываем повреждённый файл молча: пусть человек посмотрит.
    throw new Error(`${path} не соответствует схеме rates.json:\n${parsed.error.message}`);
  }
  return parsed.data as RatesFile;
}

async function writeAtomic(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function finalize(cfg: ProjectConfig, a: RatesFile, b: RatesFile): RatesFile {
  const merged = mergeRates(a, b, {
    now: new Date(),
    retainOffersDays: cfg.settings.retainOffersDays,
    retainOfficialDays: cfg.settings.retainOfficialDays,
  });
  return applyRegistry(merged, cfg.sources);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      out: { type: 'string', default: 'data/rates.json' },
      runner: { type: 'string' },
      config: { type: 'string', default: 'config' },
      rates: { type: 'string', default: 'data/rates.json' },
      'from-channel': { type: 'string', default: 'cash' },
      'from-account': { type: 'string' },
      'to-channels': { type: 'string', default: 'cash' },
      channels: { type: 'string', default: 'cash,card,online' },
      accounts: { type: 'string', default: '' },
      branches: { type: 'string', default: 'all' },
      'my-branches': { type: 'string', default: '' },
      at: { type: 'string' },
      'exclude-stale': { type: 'boolean', default: false },
      top: { type: 'string' },
    },
  });
  const cfg = await loadConfig(resolve(values.config!));
  const out = resolve(values.out!);

  if (command === 'collect') {
    const runner = values.runner ?? (process.env.GITHUB_ACTIONS ? 'github-actions' : 'local');
    const previous = await readRates(out);
    const http = new PoliteHttp(cfg.settings.http, { log: (m) => console.log(`  http: ${m}`) });
    const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
    if (only) {
      const unknown = only.filter((id) => !cfg.sources.some((s) => s.id === id));
      if (unknown.length) throw new Error(`Неизвестные источники: ${unknown.join(', ')}`);
    }
    const { file, report } = await runCollection({
      sources: cfg.sources,
      settings: cfg.settings,
      adapters,
      http,
      runner,
      ...(previous ? { previous } : {}),
      ...(only ? { only } : {}),
      log: (m) => console.log(m),
    });
    await writeAtomic(out, finalize(cfg, previous ?? emptyRates(new Date(0)), file));

    console.log('\nИтог:');
    for (const r of report) {
      const counts = r.offers ? ` предложений ${r.offers}, подозрительных ${r.suspicious}, справочных ${r.reference}` : '';
      console.log(`  ${r.status.padEnd(15)} ${r.id.padEnd(18)}${counts}${r.message ? ` — ${r.message}` : ''}`);
    }
    console.log(`\nЗаписано: ${out}`);
    return;
  }

  if (command === 'capture') {
    const http = new PoliteHttp(cfg.settings.http, { log: (m) => console.log(`  http: ${m}`) });
    const only = values.only?.split(',').map((x) => x.trim()).filter(Boolean);
    for (const source of cfg.sources) {
      if (source.collect !== 'auto' || !source.adapter || (only && !only.includes(source.id))) continue;
      const adapter = adapters[source.adapter];
      if (!adapter) continue;
      const now = new Date();
      const rec = new RecordingHttp(http, resolve('test/fixtures/sources', source.id), source.id, now.toISOString());
      try {
        const out = await adapter({ source, http: rec, now: () => now, log: (m) => console.log(`  [${source.id}] ${m}`) });
        const byTable = new Map<string, number>();
        for (const b of out.batches ?? []) for (const q of b.quotes) byTable.set(q.table, (byTable.get(q.table) ?? 0) + 1);
        const tables = [...byTable].map(([t, n]) => `${t}=${n}`).join(' ');
        const official = out.official?.map((o) => `${o.validFor}: ${Object.keys(o.rates).length} валют`).join(', ');
        console.log(`OK   ${source.id.padEnd(16)} ${tables}${official ?? ''}${out.warnings?.length ? `  ПРЕДУПРЕЖДЕНИЯ: ${out.warnings.join('; ')}` : ''}`);
      } catch (e) {
        console.log(`FAIL ${source.id.padEnd(16)} ${(e as Error).name}: ${(e as Error).message}`);
      } finally {
        rec.save();
      }
    }
    return;
  }

  if (command === 'route') {
    const [amountS, fromCur, toCur] = positionals;
    if (!amountS || !fromCur || !toCur) throw new Error(USAGE);
    const rates = await readRates(resolve(values.rates!));
    if (!rates) throw new Error(`Нет файла курсов ${values.rates}. Сначала npm run collect.`);
    const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const branchNames: Record<string, string> = {};
    for (const [src, bs] of Object.entries(rates.branches)) for (const b of bs) branchNames[`${src}|${b.id}`] = b.name;
    const now = new Date();
    const result = findRoutes(
      {
        amount: Number(amountS),
        from: {
          currency: fromCur.toUpperCase(),
          channel: values['from-channel'] as Channel,
          ...(values['from-account'] ? { account: values['from-account'] } : {}),
        },
        to: { currency: toCur.toUpperCase(), channels: list(values['to-channels']) as Channel[] },
        allowedChannels: list(values.channels) as Channel[],
        myAccounts: list(values.accounts),
        branchMode: values.branches === 'mine' ? 'mine' : 'all',
        myBranches: list(values['my-branches']),
        now,
        ...(values.at ? { at: new Date(values.at) } : {}),
        excludeStale: values['exclude-stale']!,
        ...(values.top ? { topN: Number(values.top) } : {}),
      },
      {
        offers: rates.offers,
        sources: Object.fromEntries(cfg.sources.map((s) => [s.id, { name: s.name, jurisdiction: s.jurisdiction }])),
        branchNames,
        feeRules: cfg.fees,
        transitions: cfg.transitions,
        settings: cfg.settings,
      },
    );
    const f = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 4 });
    console.log(`Курсы на ${result.at}. Исключено: ${JSON.stringify(result.excluded)}\n`);
    if (!result.routes.length) console.log('Маршрутов не найдено.');
    result.routes.forEach((r, i) => {
      const left = r.leftovers.map((l) => `${f(l.amount)} ${l.currency}`).join(', ');
      console.log(`${i + 1}. ${f(r.amountOut)} ${r.currency}${left ? `  (+ остаток ${left})` : ''}`);
      for (const s of r.steps) {
        const where = s.kind === 'exchange'
          ? `${s.sourceName}${s.branchName ? `, ${s.branchName}` : s.branch ? `, отделение ${s.branch}` : ''}${s.alsoAtBranches?.length ? ` (+ ещё ${s.alsoAtBranches.length} отд.)` : ''}`
          : s.transition!.label;
        const pub = s.offer ? ` курс ${s.offer.published.price} ${s.offer.published.quote} за ${s.offer.published.nominal} ${s.offer.published.base} (${s.offer.published.side === 'buy' ? 'покупка' : 'продажа'} банка)` : '';
        const fees = s.fees.map((x) => `${x.label}: ${f(x.amount)} ${x.currency}${x.verified ? '' : ' [не проверено]'}`).join('; ');
        const age = s.ageHours !== undefined ? `, получен ${f(Math.round(s.ageHours * 10) / 10)} ч назад` : '';
        console.log(`   ${f(s.amountIn)} ${s.from.currency} ${s.from.channel} → ${f(s.amountOut)} ${s.to.currency} ${s.to.channel} | ${where}${pub}${age}${s.validFrom ? `, действует с ${s.validFrom}` : ''}`);
        if (fees) console.log(`      комиссии: ${fees}`);
        if (s.leftover) console.log(`      остаток: ${f(s.leftover.amount)} ${s.leftover.currency}`);
        if (s.flags.length) console.log(`      пометки: ${s.flags.map((x) => FLAG_LABELS[x]).join(', ')}`);
        if (s.alternatives?.length) console.log(`      тот же итог: ${s.alternatives.map((a) => a.sourceName + (a.branchName ? ` (${a.branchName})` : '')).join('; ')}`);
      }
    });
    if (result.upcoming.length) {
      console.log('\nБудущие курсы:');
      for (const o of result.upcoming.slice(0, 10)) console.log(`   с ${o.validFrom}: ${o.source} ${o.channel} ${o.from}→${o.to} ${o.published.price} (${o.published.side})`);
    }
    return;
  }

  if (command === 'merge') {
    const [a, b] = positionals;
    if (!a || !b) throw new Error(USAGE);
    const fa = await readRates(resolve(a));
    const fb = await readRates(resolve(b));
    if (!fa || !fb) throw new Error(`Файл не найден: ${!fa ? a : b}`);
    await writeAtomic(out, finalize(cfg, fa, fb));
    console.log(`Объединено в ${out}`);
    return;
  }

  throw new Error(USAGE);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
