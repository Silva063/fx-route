import { RATES_SCHEMA_VERSION } from './types';
import { effectiveAt, upcomingAfter, versionKey } from './validity';
import type { Branch, OfficialRates, Offer, RatesFile, RunInfo, SourceDef, SourceStatus } from './types';

export function emptyRates(now: Date): RatesFile {
  return {
    schemaVersion: RATES_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    runs: [],
    sources: [],
    branches: {},
    official: [],
    offers: [],
  };
}

export interface MergeOptions {
  now: Date;
  retainOffersDays: number;
  retainOfficialDays: number;
  maxRuns?: number;
}

/** Место сбора: старое 'local' — это ПК. */
export const normalizeRunner = (r: string) => (r === 'local' ? 'pc' : r);

export const RUNNER_NAMES: Record<string, string> = { pc: 'ПК', 'github-actions': 'GitHub Actions' };
export const runnerName = (r: string) => RUNNER_NAMES[normalizeRunner(r)] ?? r;

export interface SourceHealth {
  /** Место сбора с самым свежим успешным сбором (или, если успехов нет, с последней попыткой). */
  primary: SourceStatus;
  /** Остальные места сбора. */
  others: SourceStatus[];
}

/** Сводка статуса источника по всем местам сбора — для интерфейса. */
export function sourceHealth(statuses: readonly SourceStatus[], id: string): SourceHealth | null {
  const list = statuses.filter((s) => s.id === id).map((s) => ({ ...s, runner: normalizeRunner(s.runner) }));
  if (!list.length) return null;
  const withSuccess = list.filter((s) => s.lastSuccessAt);
  const primary = (withSuccess.length ? withSuccess : list).reduce((a, b) =>
    (withSuccess.length ? (b.lastSuccessAt! > a.lastSuccessAt! ? b : a) : b.lastAttemptAt > a.lastAttemptAt ? b : a),
  );
  return { primary, others: list.filter((s) => s !== primary) };
}

const later = (x: string | undefined, y: string | undefined) => ((x ?? '') >= (y ?? '') ? x : y);

/**
 * Объединяет два rates.json (например, результат ПК и GitHub Actions, или старый файл и новый запуск).
 * Версия курса = предложение (источник+отделение+канал+направление) + validFrom; для каждой версии
 * берётся самая свежая по fetchedAt. Хранятся действующая на opts.now версия и все будущие:
 * курс «с завтрашнего дня» не затирает сегодняшний. Устаревшие версии удаляются.
 * Статус источника — по последней попытке; lastSuccessAt — максимальный из двух.
 * Операция симметрична: порядок аргументов важен только при полном равенстве времени.
 */
export function mergeRates(a: RatesFile, b: RatesFile, opts: MergeOptions): RatesFile {
  const versions = new Map<string, Offer>();
  for (const o of [...a.offers, ...b.offers]) {
    const key = versionKey(o);
    const prev = versions.get(key);
    if (!prev || o.fetchedAt >= prev.fetchedAt) versions.set(key, o);
  }
  const all = [...versions.values()];
  const kept = [...effectiveAt(all, opts.now), ...upcomingAfter(all, opts.now)];

  // Статусы — по паре «источник + место сбора»: неудача в GitHub Actions не перебивает успех на ПК.
  const sources = new Map<string, SourceStatus>();
  for (const raw of [...a.sources, ...b.sources]) {
    const s = { ...raw, runner: normalizeRunner(raw.runner) };
    const key = `${s.id}|${s.runner}`;
    const prev = sources.get(key);
    if (!prev) {
      sources.set(key, s);
      continue;
    }
    const newer = s.lastAttemptAt >= prev.lastAttemptAt ? s : prev;
    const lastSuccessAt = later(prev.lastSuccessAt, s.lastSuccessAt);
    sources.set(key, { ...newer, ...(lastSuccessAt ? { lastSuccessAt } : {}) });
  }

  // Список отделений — из файла, где источник успешно собирался позже.
  const branches: Record<string, Branch[]> = {};
  const successAt = (f: RatesFile, id: string) =>
    f.sources.filter((s) => s.id === id).reduce((m, s) => (s.lastSuccessAt && s.lastSuccessAt > m ? s.lastSuccessAt : m), '');
  for (const id of new Set([...Object.keys(a.branches), ...Object.keys(b.branches)])) {
    const fromA = a.branches[id];
    const fromB = b.branches[id];
    branches[id] = (!fromA ? fromB : !fromB ? fromA : successAt(b, id) >= successAt(a, id) ? fromB : fromA)!;
  }

  const official = new Map<string, OfficialRates>();
  for (const r of [...a.official, ...b.official]) {
    const key = `${r.source}|${r.validFor}`;
    const prev = official.get(key);
    if (!prev || r.fetchedAt >= prev.fetchedAt) official.set(key, r);
  }

  const runsMap = new Map<string, RunInfo>();
  for (const raw of [...a.runs, ...b.runs]) {
    const r = { ...raw, runner: normalizeRunner(raw.runner) };
    runsMap.set(`${r.runner}|${r.startedAt}`, r);
  }

  // Старые файлы хранили один статус на источник: успех ПК мог попасть в запись GitHub Actions.
  // Успех раньше первого известного запуска этого места сбора ему принадлежать не может — убираем.
  const firstRun = new Map<string, string>();
  for (const r of runsMap.values()) {
    const prev = firstRun.get(r.runner);
    if (!prev || r.startedAt < prev) firstRun.set(r.runner, r.startedAt);
  }
  for (const [key, s] of sources) {
    const first = firstRun.get(s.runner);
    if (s.lastSuccessAt && first && s.lastSuccessAt < first) {
      const { lastSuccessAt: _drop, ...rest } = s;
      sources.set(key, rest);
    }
  }

  const offersCutoff =new Date(opts.now.getTime() - opts.retainOffersDays * 86_400_000).toISOString();
  const officialCutoff = new Date(opts.now.getTime() - opts.retainOfficialDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return {
    schemaVersion: RATES_SCHEMA_VERSION,
    // Время формирования — самого свежего из объединяемых файлов, а не момента слияния:
    // интерфейс показывает его как «курсы собраны», а повторное слияние ничего не меняет.
    generatedAt: later(a.generatedAt, b.generatedAt)!,
    runs: [...runsMap.values()]
      .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
      .slice(-(opts.maxRuns ?? 50)),
    sources: [...sources.values()].sort((x, y) => x.id.localeCompare(y.id) || x.runner.localeCompare(y.runner)),
    branches,
    official: [...official.values()]
      .filter((r) => r.validFor >= officialCutoff)
      .sort((x, y) => x.source.localeCompare(y.source) || x.validFor.localeCompare(y.validFor)),
    offers: kept
      .filter((o) => o.fetchedAt >= offersCutoff)
      .sort((x, y) => x.id.localeCompare(y.id) || (x.validFrom ?? '').localeCompare(y.validFrom ?? '')),
  };
}

/**
 * Приводит файл в соответствие с реестром источников: убирает предложения источников,
 * которых больше нет или которые переведены в manual-only, и таблиц, выпавших из белого списка.
 */
export function applyRegistry(file: RatesFile, registry: readonly SourceDef[]): RatesFile {
  const byId = new Map(registry.map((s) => [s.id, s]));
  return {
    ...file,
    offers: file.offers
      .filter((o) => {
        const src = byId.get(o.source);
        const table = src?.tables?.[o.table];
        return !!src && src.collect === 'auto' && !!table && table.channel === o.channel;
      })
      // Уверенность в канале — всегда по текущему конфигу (владелец мог подтвердить канал).
      .map((o) => {
        const table = byId.get(o.source)!.tables![o.table]!;
        const channelConfidence = table.channel === 'unknown' ? 'assumed' : (table.channelConfidence ?? 'confirmed');
        return o.channelConfidence === channelConfidence ? o : { ...o, channelConfidence };
      }),
    sources: file.sources.filter((s) => byId.has(s.id)),
  };
}
