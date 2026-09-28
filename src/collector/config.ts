import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  feesConfigSchema,
  settingsSchema,
  sourcesConfigSchema,
  transitionsConfigSchema,
} from '../core/schema';
import type { FeeRule, Settings, SourceDef, Transition } from '../core/types';
import { htmlTablesParamsSchema } from './adapters/declarative';

export interface ProjectConfig {
  sources: SourceDef[];
  fees: FeeRule[];
  transitions: Transition[];
  settings: Settings;
}

async function readJson<S extends z.ZodType>(dir: string, file: string, schema: S): Promise<z.infer<S>> {
  const path = join(dir, file);
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(корень)'}: ${i.message}`).join('\n');
    throw new Error(`Ошибка в ${path}:\n${details}`);
  }
  return parsed.data;
}

export async function loadConfig(dir: string): Promise<ProjectConfig> {
  const [sources, fees, transitions, settings] = await Promise.all([
    readJson(dir, 'sources.json', sourcesConfigSchema),
    readJson(dir, 'fees.json', feesConfigSchema),
    readJson(dir, 'transitions.json', transitionsConfigSchema),
    readJson(dir, 'settings.json', settingsSchema),
  ]);
  // Параметры декларативных источников проверяются сразу, а не в момент сбора.
  for (const s of sources.sources) {
    if (s.adapter !== 'html-tables') continue;
    const p = htmlTablesParamsSchema.safeParse(s.params);
    if (!p.success) {
      const details = p.error.issues.map((i) => `  params.${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Ошибка в параметрах источника ${s.id}:\n${details}`);
    }
  }
  return {
    sources: sources.sources as SourceDef[],
    fees: fees.rules as FeeRule[],
    transitions: transitions.transitions as Transition[],
    settings: settings as Settings,
  };
}
