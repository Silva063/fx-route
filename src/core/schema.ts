// Схемы валидации. Используются сборщиком (конфиги, rates.json) и PWA (rates.json, импорт ручных данных).
import { z } from 'zod';
import { CHANNELS, JURISDICTIONS, RATES_SCHEMA_VERSION, SOURCE_STATUSES } from './types';

const currency = z.string().regex(/^[A-Z]{3}$/, 'код валюты из трёх заглавных букв');
const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ожидается дата ISO');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD');
const channel = z.enum(CHANNELS);
const jurisdiction = z.enum(JURISDICTIONS);

export const feeSchema = z.object({
  percent: z.number().min(0).max(100).optional(),
  fixed: z.number().min(0).optional(),
  minFee: z.number().min(0).optional(),
  maxFee: z.number().min(0).optional(),
  mode: z.enum(['deduct', 'onTop']).optional(),
});

const issueSchema = z.object({
  code: z.enum([
    'buy-not-below-sell',
    'spread-too-wide',
    'deviates-from-official',
    'no-official-reference',
    'official-other-date',
    'channel-unknown',
    'channel-assumed',
    'reference-table',
  ]),
  blocking: z.boolean(),
  message: z.string(),
});

export const offerSchema = z.object({
  id: z.string(),
  source: z.string(),
  branch: z.string().optional(),
  table: z.string(),
  from: currency,
  to: currency,
  rate: z.number().positive(),
  published: z.object({
    base: currency,
    quote: currency,
    price: z.number().positive(),
    nominal: z.number().positive(),
    side: z.enum(['buy', 'sell']),
  }),
  channel,
  channelConfidence: z.enum(['confirmed', 'assumed']),
  minAmount: z.number().min(0).optional(),
  maxAmount: z.number().positive().optional(),
  fee: feeSchema.optional(),
  validFrom: z.string().optional(),
  fetchedAt: isoDateTime,
  origin: z.enum(['auto', 'manual']),
  sourceUrl: z.string(),
  status: z.enum(['ok', 'suspicious', 'reference']),
  issues: z.array(issueSchema).optional(),
});

export const officialRatesSchema = z.object({
  source: z.string(),
  base: currency,
  validFor: isoDate,
  fetchedAt: isoDateTime,
  sourceUrl: z.string(),
  rates: z.record(z.string(), z.number().positive()),
});

export const branchSchema = z.object({ id: z.string(), name: z.string(), address: z.string().optional() });

export const ratesFileSchema = z.object({
  schemaVersion: z.literal(RATES_SCHEMA_VERSION),
  generatedAt: isoDateTime,
  runs: z.array(z.object({ runner: z.string(), startedAt: isoDateTime, finishedAt: isoDateTime })),
  sources: z.array(
    z.object({
      id: z.string(),
      status: z.enum(SOURCE_STATUSES),
      message: z.string().optional(),
      lastAttemptAt: isoDateTime,
      lastSuccessAt: isoDateTime.optional(),
      runner: z.string(),
      offers: z.number().int().min(0),
      suspicious: z.number().int().min(0),
    }),
  ),
  branches: z.record(z.string(), z.array(branchSchema)),
  official: z.array(officialRatesSchema),
  offers: z.array(offerSchema),
});

const tableSchema = z.object({
  label: z.string(),
  channel,
  channelConfidence: z.enum(['confirmed', 'assumed']).optional(),
  use: z.enum(['offer', 'reference']),
});

export const sourceDefSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    jurisdiction,
    kind: z.enum(['bank', 'official', 'exchange-point']),
    website: z.string().url(),
    ratesUrl: z.string().url(),
    collect: z.enum(['auto', 'manual-only']),
    manualReason: z.string().optional(),
    adapter: z.string().optional(),
    tables: z.record(z.string(), tableSchema).optional(),
    excludedTables: z.record(z.string(), z.string()).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  })
  .refine((s) => s.collect !== 'auto' || !!s.adapter, { message: 'для collect=auto нужен adapter' })
  .refine((s) => s.collect !== 'manual-only' || !!s.manualReason, {
    message: 'для manual-only нужна причина manualReason',
  });

export const sourcesConfigSchema = z
  .object({ sources: z.array(sourceDefSchema) })
  .refine((c) => new Set(c.sources.map((s) => s.id)).size === c.sources.length, {
    message: 'id источников должны быть уникальны',
  });

export const feeRuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  match: z.object({
    jurisdiction: z.array(jurisdiction).optional(),
    channel: z.array(channel).optional(),
    from: z.array(currency).optional(),
    fromNot: z.array(currency).optional(),
    to: z.array(currency).optional(),
    toNot: z.array(currency).optional(),
    source: z.array(z.string()).optional(),
  }),
  fee: feeSchema,
  verified: z.boolean(),
  note: z.string().optional(),
  legalBasis: z.string().optional(),
  sourceUrls: z.array(z.string()).optional(),
});
export const feesConfigSchema = z.object({ rules: z.array(feeRuleSchema) });

export const transitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  currency: z.union([currency, z.literal('*')]),
  from: z.object({ channel, account: z.string().optional() }),
  to: z.object({ channel, account: z.string().optional() }),
  fee: feeSchema.optional(),
  minAmount: z.number().min(0).optional(),
  maxAmount: z.number().positive().optional(),
  note: z.string().optional(),
  sourceUrl: z.string().optional(),
  verifiedAt: isoDate.optional(),
});
export const transitionsConfigSchema = z.object({ transitions: z.array(transitionSchema) });

export const settingsSchema = z.object({
  staleAfterHours: z.number().positive(),
  retainOffersDays: z.number().positive(),
  retainOfficialDays: z.number().positive(),
  http: z.object({
    userAgent: z.string().min(1),
    minDelayMs: z.number().min(0),
    timeoutMs: z.number().positive(),
    retries: z.number().int().min(0).max(3),
    maxRedirects: z.number().int().min(0).max(10),
  }),
  sourceTimeoutMs: z.number().positive(),
  plausibility: z.object({
    maxSpreadPercent: z.number().positive(),
    maxSpreadOverrides: z.record(z.string(), z.number().positive()).optional(),
    maxOfficialDeviationPercent: z.number().positive(),
    maxOfficialDeviationOverrides: z.record(z.string(), z.number().positive()).optional(),
    officialByJurisdiction: z.object({ MD: z.string(), PMR: z.string() }),
  }),
  routing: z.object({
    topN: z.number().int().min(1).max(50),
    maxExchanges: z.number().int().min(1).max(4),
    maxSteps: z.number().int().min(1).max(8),
    perPairLimit: z.number().int().min(1).max(50),
    cashRounding: z.object({
      enabled: z.boolean(),
      verified: z.boolean(),
      defaultUnit: z.number().positive(),
      units: z.record(z.string(), z.number().positive()).optional(),
      note: z.string().optional(),
    }),
    minorUnits: z.object({
      enabled: z.boolean(),
      verified: z.boolean(),
      defaultDecimals: z.number().int().min(0).max(4),
      decimals: z.record(z.string(), z.number().int().min(0).max(4)).optional(),
      note: z.string().optional(),
    }),
  }),
});

// ---------- Ручные данные PWA (экспорт/импорт JSON) ----------

export const manualPointSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  jurisdiction,
  address: z.string().optional(),
  note: z.string().optional(),
  /** Если пункт — ручной ввод для источника из реестра (manual-only или защита): его id. */
  sourceId: z.string().optional(),
});

export const manualQuoteSchema = z
  .object({
    id: z.string(),
    point: z.string(),
    base: currency,
    quote: currency,
    nominal: z.number().positive().optional(),
    buy: z.number().positive().nullable().optional(),
    sell: z.number().positive().nullable().optional(),
    channel,
    /** Когда курс введён пользователем. Служит fetchedAt для ручных курсов. */
    enteredAt: isoDateTime,
    note: z.string().optional(),
  })
  .refine((q) => q.buy != null || q.sell != null, { message: 'нужна покупка или продажа' });

export const manualDataSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: isoDateTime,
  points: z.array(manualPointSchema),
  quotes: z.array(manualQuoteSchema),
  /** Выбранные «мои отделения»: ключи вида source|branch. */
  myBranches: z.array(z.string()).default([]),
});

export type ManualData = z.infer<typeof manualDataSchema>;
export type ManualPoint = z.infer<typeof manualPointSchema>;
export type ManualQuote = z.infer<typeof manualQuoteSchema>;
