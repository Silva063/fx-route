/**
 * Публикация курсов в ветку `data` репозитория. PWA читает их оттуда во время работы
 * (raw.githubusercontent.com), поэтому сайт при обновлении курсов не пересобирается.
 *
 *   npm run publish-data [-- --remote origin --branch data --file data/rates.json --repo .]
 *
 * 1. Забирает опубликованный rates.json из <remote>/<branch> и объединяет с локальным
 *    (mergeRates: для каждого курса — самая свежая версия; так результаты ПК и GitHub Actions
 *    не затирают друг друга). Результат записывается и в локальный файл.
 * 2. Кладёт его в ветку одним коммитом через git plumbing — рабочая папка и текущая ветка
 *    не трогаются, конфликтов с кодом не бывает.
 * 3. Пушит с --force-with-lease (история курсов не нужна — ветка не растёт). Если кто-то
 *    опубликовал раньше нас, всё повторяется с шага 1.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/collector/config';
import { applyRegistry, mergeRates } from '../src/core/merge';
import { ratesFileSchema } from '../src/core/schema';
import type { RatesFile } from '../src/core/types';

const { values } = parseArgs({
  options: {
    remote: { type: 'string', default: 'origin' },
    branch: { type: 'string', default: 'data' },
    file: { type: 'string', default: 'data/rates.json' },
    repo: { type: 'string', default: '.' },
    config: { type: 'string', default: 'config' },
  },
});
const repo = resolve(values.repo!);
const file = resolve(values.file!);
const { remote, branch } = values as { remote: string; branch: string };
const ref = `refs/remotes/${remote}/${branch}`;

function git(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      input: opts.input,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')}: ${err.stderr?.trim() || err.message}`);
  }
}

function parseRates(text: string, where: string): RatesFile {
  const p = ratesFileSchema.safeParse(JSON.parse(text));
  if (!p.success) throw new Error(`${where} не соответствует схеме rates.json:\n${p.error.message}`);
  return p.data as RatesFile;
}

const cfg = await loadConfig(resolve(values.config!));

for (let attempt = 1; attempt <= 3; attempt++) {
  git(['fetch', '--quiet', remote, `+refs/heads/${branch}:${ref}`], { allowFail: true });
  const remoteCommit = git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true });

  let merged = parseRates(readFileSync(file, 'utf8'), file);
  if (remoteCommit) {
    const remoteText = git(['show', `${remoteCommit}:rates.json`], { allowFail: true });
    if (remoteText) {
      const opts = { now: new Date(), retainOffersDays: cfg.settings.retainOffersDays, retainOfficialDays: cfg.settings.retainOfficialDays };
      merged = applyRegistry(mergeRates(parseRates(remoteText, `${remote}/${branch}:rates.json`), merged, opts), cfg.sources);
    }
  }
  const text = JSON.stringify(merged, null, 2) + '\n';
  writeFileSync(file, text, 'utf8');

  const blob = git(['hash-object', '-w', '--stdin'], { input: text });
  const index = join(git(['rev-parse', '--git-dir']), 'fx-data-index');
  const env = { GIT_INDEX_FILE: resolve(repo, index) };
  git(['read-tree', '--empty'], { env });
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},rates.json`], { env });
  const tree = git(['write-tree'], { env });
  if (remoteCommit && git(['rev-parse', `${remoteCommit}^{tree}`]) === tree) {
    console.log('Опубликованные курсы уже совпадают с локальными — публиковать нечего.');
    process.exit(0);
  }
  const runner = merged.runs.at(-1)?.runner ?? 'unknown';
  const commit = git(['commit-tree', tree, '-m', `Курсы: ${merged.generatedAt} (${runner})`]);
  const lease = `--force-with-lease=refs/heads/${branch}:${remoteCommit || ''}`;
  const pushed = git(['push', '--quiet', lease, remote, `${commit}:refs/heads/${branch}`], { allowFail: true });
  if (git(['ls-remote', remote, `refs/heads/${branch}`]).startsWith(commit)) {
    console.log(`Опубликовано в ${remote}/${branch}: ${merged.offers.length} предложений, ${merged.generatedAt}`);
    process.exit(0);
  }
  console.log(`Попытка ${attempt}: ветку ${branch} обновили параллельно — объединяю заново.${pushed ? ` (${pushed})` : ''}`);
}
throw new Error(`Не удалось опубликовать курсы в ${remote}/${branch} за 3 попытки.`);
