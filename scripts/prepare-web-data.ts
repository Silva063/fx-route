/**
 * Готовит данные для PWA в web/public/data:
 *  - config.json — публичная часть конфигов (источники, комиссии, переходы, настройки расчёта);
 *  - rates.json  — курсы (по умолчанию data/rates.json; путь можно передать аргументом).
 * Всё проверяется схемами ядра: битые данные не публикуются.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/collector/config';
import { ratesFileSchema } from '../src/core/schema';

const ratesPath = resolve(process.argv[2] ?? 'data/rates.json');
const outDir = resolve('web/public/data');
await mkdir(outDir, { recursive: true });

const cfg = await loadConfig(resolve('config'));
const publicConfig = {
  sources: cfg.sources.map((s) => ({
    id: s.id,
    name: s.name,
    jurisdiction: s.jurisdiction,
    kind: s.kind,
    website: s.website,
    ratesUrl: s.ratesUrl,
    collect: s.collect,
    ...(s.manualReason ? { manualReason: s.manualReason } : {}),
    tables: s.tables ?? {},
    ...(s.note ? { note: s.note } : {}),
  })),
  fees: cfg.fees,
  transitions: cfg.transitions,
  settings: {
    staleAfterHours: cfg.settings.staleAfterHours,
    plausibility: cfg.settings.plausibility,
    routing: cfg.settings.routing,
  },
};
await writeFile(resolve(outDir, 'config.json'), JSON.stringify(publicConfig) + '\n', 'utf8');

if (existsSync(ratesPath)) {
  const parsed = ratesFileSchema.safeParse(JSON.parse(await readFile(ratesPath, 'utf8')));
  if (!parsed.success) throw new Error(`${ratesPath} не соответствует схеме:\n${parsed.error.message}`);
  await copyFile(ratesPath, resolve(outDir, 'rates.json'));
  console.log(`rates.json: ${parsed.data.offers.length} предложений, сформирован ${parsed.data.generatedAt}`);
} else {
  console.warn(`Внимание: ${ratesPath} нет — приложение покажет «нет данных».`);
}
console.log(`config.json: ${publicConfig.sources.length} источников`);
