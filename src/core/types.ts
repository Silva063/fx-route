// Модель данных. Этот модуль изоморфный: его используют и сборщик (Node), и PWA (браузер).
// Никаких импортов из node:* здесь быть не должно.

/**
 * Код валюты ISO 4217. Для рубля ПМР (кода ISO нет) используется 'RUP' —
 * так его обозначают сами банки ПМР (Агропромбанк, Приднестровский Сбербанк).
 */
export type Currency = string;

export const CHANNELS = ['cash', 'card', 'online', 'unknown'] as const;
/**
 * Канал обмена. 'unknown' — источник не говорит, к какому каналу относится курс.
 * Такие курсы показываются справочно и в маршрут не идут, пока канал не подтверждён.
 */
export type Channel = (typeof CHANNELS)[number];

/**
 * Уверенность в канале таблицы:
 * confirmed — источник прямо называет канал («Numerar», «Наличные курсы»);
 * assumed — канал предположен (например, «в отделениях» → наличные). Курс участвует в маршруте,
 * но в интерфейсе помечается «канал не подтверждён».
 */
export type ChannelConfidence = 'confirmed' | 'assumed';

export const JURISDICTIONS = ['MD', 'PMR'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export type Origin = 'auto' | 'manual';

/**
 * ok          — участвует в маршрутах;
 * suspicious  — не прошёл проверки правдоподобности, виден в интерфейсе, в маршрут не идёт;
 * reference   — справочный (канал unknown или таблица помечена как справочная), в маршрут не идёт.
 */
export type OfferStatus = 'ok' | 'suspicious' | 'reference';

/**
 * Комиссия шага. Все суммы — в валюте, которую клиент отдаёт на этом шаге.
 * mode:
 *  - 'deduct' (по умолчанию): комиссия удерживается из отдаваемой суммы;
 *  - 'onTop': комиссия платится сверх обмениваемой суммы (как сбор 0,1% в МД:
 *    из X лей на валюту уходит X / 1.001).
 */
export interface Fee {
  percent?: number;
  fixed?: number;
  minFee?: number;
  maxFee?: number;
  mode?: 'deduct' | 'onTop';
}

/** Котировка в том виде, в каком её публикует источник: банк покупает/продаёт base за quote. */
export interface RawQuote {
  /** Идентификатор таблицы/группы у источника. Сверяется с белым списком таблиц. */
  table: string;
  base: Currency;
  quote: Currency;
  /** За сколько единиц base указана цена (CNY за 10, HUF за 100). По умолчанию 1. */
  nominal?: number;
  /** Банк покупает base (клиент продаёт base). null/undefined — нет данных. */
  buy?: number | null;
  /** Банк продаёт base (клиент покупает base). */
  sell?: number | null;
  branch?: string;
  /** Момент, с которого курс действует, по данным источника (ISO дата или дата-время). */
  validFrom?: string;
}

export interface Branch {
  id: string;
  name: string;
  address?: string;
}

export interface PublishedQuote {
  base: Currency;
  quote: Currency;
  /** Цена за nominal единиц base, как опубликовано. */
  price: number;
  nominal: number;
  /** buy — банк покупает base; sell — банк продаёт base. */
  side: 'buy' | 'sell';
}

/** Направленное предложение обмена: отдаём `from`, получаем `to`. */
export interface Offer {
  /** Детерминированный ключ: source|branch|channel|from>to. По нему идёт объединение запусков. */
  id: string;
  source: string;
  branch?: string;
  table: string;
  from: Currency;
  to: Currency;
  /** Сколько единиц `to` дают за 1 единицу `from`. */
  rate: number;
  published: PublishedQuote;
  channel: Channel;
  channelConfidence: ChannelConfidence;
  minAmount?: number;
  maxAmount?: number;
  fee?: Fee;
  validFrom?: string;
  fetchedAt: string;
  origin: Origin;
  sourceUrl: string;
  status: OfferStatus;
  issues?: Issue[];
}

export interface Issue {
  code:
    | 'buy-not-below-sell'
    | 'spread-too-wide'
    | 'deviates-from-official'
    | 'no-official-reference'
    | 'official-other-date'
    | 'channel-unknown'
    | 'channel-assumed'
    | 'reference-table';
  /** Блокирует ли проблема участие в маршрутах. */
  blocking: boolean;
  message: string;
}

/** Официальный курс: сколько единиц `base` стоит 1 единица валюты. */
export interface OfficialRates {
  source: string;
  base: Currency;
  /** Дата действия курса (YYYY-MM-DD). У ПРБ публикуется заранее, на следующий день. */
  validFor: string;
  fetchedAt: string;
  sourceUrl: string;
  rates: Record<Currency, number>;
}

export const SOURCE_STATUSES = [
  'ok',
  'partial',
  'error',
  'protected',
  'robots-blocked',
  'manual-only',
  'not-implemented',
] as const;
export type SourceStatusCode = (typeof SOURCE_STATUSES)[number];

/**
 * Статус источника хранится отдельно для каждого места сбора (runner: 'pc' | 'github-actions'):
 * неудача в одном месте не перебивает успешный сбор в другом.
 */
export interface SourceStatus {
  id: string;
  status: SourceStatusCode;
  message?: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  /** Место сбора: 'pc' (ПК) или 'github-actions'. Старое значение 'local' читается как 'pc'. */
  runner: string;
  offers: number;
  suspicious: number;
}

export interface RunInfo {
  runner: string;
  startedAt: string;
  finishedAt: string;
}

export const RATES_SCHEMA_VERSION = 1;

/** Содержимое rates.json. */
export interface RatesFile {
  schemaVersion: typeof RATES_SCHEMA_VERSION;
  generatedAt: string;
  runs: RunInfo[];
  sources: SourceStatus[];
  branches: Record<string, Branch[]>;
  official: OfficialRates[];
  offers: Offer[];
}

// ---------- Конфигурация ----------

export interface TableDef {
  label: string;
  channel: Channel;
  /** По умолчанию confirmed. Для channel=unknown не используется. */
  channelConfidence?: ChannelConfidence;
  /** offer — предложение обмена; reference — только справочно. */
  use: 'offer' | 'reference';
}

export interface SourceDef {
  id: string;
  name: string;
  jurisdiction: Jurisdiction;
  kind: 'bank' | 'official' | 'exchange-point';
  website: string;
  ratesUrl: string;
  collect: 'auto' | 'manual-only';
  manualReason?: string;
  /** Имя адаптера в реестре адаптеров сборщика. */
  adapter?: string;
  /** Белый список таблиц. Котировки из таблиц вне списка отбрасываются. */
  tables?: Record<string, TableDef>;
  /** Сознательно исключённые таблицы: id → причина. Только документация. */
  excludedTables?: Record<string, string>;
  /** Параметры для адаптера (URL эндпоинтов и т.п.). */
  params?: Record<string, unknown>;
  note?: string;
}

export interface FeeRule {
  id: string;
  label: string;
  match: {
    jurisdiction?: Jurisdiction[];
    channel?: Channel[];
    from?: Currency[];
    fromNot?: Currency[];
    to?: Currency[];
    toNot?: Currency[];
    source?: string[];
  };
  fee: Fee;
  /** false — применимость правила не подтверждена (осторожная оценка). Интерфейс это показывает. */
  verified: boolean;
  note?: string;
  legalBasis?: string;
  sourceUrls?: string[];
}

/** Узел графа маршрутов. account — где лежат деньги: id банка для card/online, нет для наличных. */
export interface GraphNode {
  currency: Currency;
  channel: Channel;
  account?: string;
}

/** Переход между каналами/счетами без смены валюты (снятие, пополнение, перевод). Задаётся вручную. */
export interface Transition {
  id: string;
  label: string;
  /** '*' — любая валюта. */
  currency: Currency | '*';
  from: { channel: Channel; account?: string };
  to: { channel: Channel; account?: string };
  fee?: Fee;
  minAmount?: number;
  maxAmount?: number;
  note?: string;
  sourceUrl?: string;
  /** Когда условия проверены человеком (YYYY-MM-DD). */
  verifiedAt?: string;
}

export interface PlausibilitySettings {
  /** Максимальный спред (sell-buy)/mid, %. */
  maxSpreadPercent: number;
  /** Переопределения: "BASE/QUOTE", "BASE", с юрисдикцией — "PMR:BASE/QUOTE", "PMR:BASE". */
  maxSpreadOverrides?: Record<string, number>;
  /** Максимальное отклонение цены от официального кросс-курса, %. */
  maxOfficialDeviationPercent: number;
  maxOfficialDeviationOverrides?: Record<string, number>;
  /** Какой официальный источник предпочитать для кроссов, по юрисдикции источника. */
  officialByJurisdiction: Record<Jurisdiction, string>;
}

/**
 * Округление при выдаче наличных: банк выдаёт целые единицы (defaultUnit или units[валюта]),
 * остаток возвращается в исходной валюте. verified=false — правило не проверено, маршрут помечается.
 */
export interface CashRoundingRule {
  enabled: boolean;
  verified: boolean;
  defaultUnit: number;
  units?: Record<Currency, number>;
  note?: string;
}

/**
 * Округление до минимальной единицы валюты (копейки/бани/центы): суммы безналичных шагов
 * и остатки округляются вниз (в пользу банка) до decimals[валюта] ?? defaultDecimals знаков.
 * Остатки меньше минимальной единицы не возникают. verified=false — правило не проверено.
 */
export interface MinorUnitsRule {
  enabled: boolean;
  verified: boolean;
  defaultDecimals: number;
  decimals?: Record<Currency, number>;
  note?: string;
}

export interface RoutingSettings {
  topN: number;
  /** Максимум обменов в маршруте. */
  maxExchanges: number;
  /** Максимум шагов (обмены + переходы). */
  maxSteps: number;
  /** Сколько лучших различных курсов между парой узлов рассматривать (не меньше topN). */
  perPairLimit: number;
  cashRounding: CashRoundingRule;
  minorUnits: MinorUnitsRule;
}

export interface Settings {
  staleAfterHours: number;
  retainOffersDays: number;
  retainOfficialDays: number;
  http: {
    userAgent: string;
    minDelayMs: number;
    timeoutMs: number;
    retries: number;
    maxRedirects: number;
  };
  sourceTimeoutMs: number;
  plausibility: PlausibilitySettings;
  routing: RoutingSettings;
}
