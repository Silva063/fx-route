import { convertStep, grossForNet, matchingFeeRules } from './fees';
import { freshness } from './freshness';
import { node, nodeKey } from './graph';
import { isRoutable } from './offers';
import type {
  Channel,
  Currency,
  Fee,
  FeeRule,
  GraphNode,
  Jurisdiction,
  Offer,
  Settings,
  Transition,
} from './types';
import { effectiveAt, effectiveFrom, upcomingAfter } from './validity';

// ---------------- Входные и выходные типы ----------------

export interface RouteQuery {
  amount: number;
  /** Откуда: валюта, канал и (для card/online) счёт — id банка. */
  from: GraphNode;
  to: { currency: Currency; channels: Channel[] };
  /** Каналы, через которые можно проходить. */
  allowedChannels: Channel[];
  /** «Мои счета»: id банков, где у меня есть карта/онлайн-банк. Через чужие счета маршруты не строятся. */
  myAccounts: string[];
  /** mine — курсы отделений только из «моих отделений»; all — все отделения. */
  branchMode: 'mine' | 'all';
  /** Ключи «мои отделения»: `${source}|${branch}`. */
  myBranches: string[];
  /** На какой момент считать курсы (по умолчанию — сейчас). */
  at?: Date;
  /** Реальное «сейчас» — для возраста курсов. */
  now?: Date;
  excludeStale?: boolean;
  topN?: number;
}

export interface RouteContext {
  /** Все версии предложений: автоматические и ручные. */
  offers: readonly Offer[];
  sources: Readonly<Record<string, { name: string; jurisdiction: Jurisdiction }>>;
  branchNames?: Readonly<Record<string, string>>;
  feeRules: readonly FeeRule[];
  transitions: readonly Transition[];
  settings: Pick<Settings, 'staleAfterHours' | 'routing'>;
}

export type RouteFlag =
  | 'channel-assumed'
  | 'fee-unverified'
  | 'rounding-unverified'
  | 'minor-rounding-unverified'
  | 'transition-unverified'
  | 'stale'
  | 'manual';

export const FLAG_LABELS: Record<RouteFlag, string> = {
  'channel-assumed': 'канал не подтверждён',
  'fee-unverified': 'правило комиссии не проверено',
  'rounding-unverified': 'правило округления наличных не проверено',
  'minor-rounding-unverified': 'округление до копеек не проверено',
  'transition-unverified': 'условия перехода не проверены',
  stale: 'курс устарел',
  manual: 'курс введён вручную',
};

export interface StepFee {
  label: string;
  amount: number;
  currency: Currency;
  verified: boolean;
}

export interface RouteStep {
  kind: 'exchange' | 'transition';
  from: GraphNode;
  to: GraphNode;
  amountIn: number;
  amountOut: number;
  rate: number;
  fees: StepFee[];
  /** Остаток от округления наличных — возвращается в валюте входа этого шага. */
  leftover?: { amount: number; currency: Currency };
  source?: string;
  sourceName?: string;
  branch?: string;
  branchName?: string;
  /** Ещё отделения того же банка с тем же курсом и условиями. */
  alsoAtBranches?: { branch: string; name?: string }[];
  /** Другие банки/отделения, дающие на этом шаге ровно тот же итог маршрута. */
  alternatives?: { source: string; sourceName: string; branch?: string; branchName?: string; flags: RouteFlag[] }[];
  offer?: Offer;
  transition?: Transition;
  fetchedAt?: string;
  validFrom?: string;
  ageHours?: number;
  flags: RouteFlag[];
}

export interface Route {
  steps: RouteStep[];
  amountOut: number;
  currency: Currency;
  leftovers: { amount: number; currency: Currency }[];
  flags: RouteFlag[];
}

export interface RouteResult {
  at: string;
  routes: Route[];
  /** Курсы, которые начнут действовать позже `at` (по направлениям запроса и найденных маршрутов). */
  upcoming: Offer[];
  excluded: {
    notRoutable: number;
    channelNotAllowed: number;
    notMyAccount: number;
    notMyBranch: number;
    stale: number;
  };
}

// ---------------- Граф ----------------

interface ExchangeEdge {
  kind: 'exchange';
  from: GraphNode;
  to: GraphNode;
  offer: Offer;
  /** Эквивалентные предложения других отделений (тот же банк, таблица, курс, условия). */
  twins: Offer[];
  stale: boolean;
}

interface TransitionEdge {
  kind: 'transition';
  from: GraphNode;
  to: GraphNode;
  transition: Transition;
}

type Edge = ExchangeEdge | TransitionEdge;

const EPS = 1e-9;

/**
 * Округление вниз до кратного unit, устойчивое к ошибкам плавающей точки:
 * 17720.999999999996 при unit=0.01 даёт 17721, а не 17720.99.
 */
export function floorTo(x: number, unit: number): number {
  const v = x / unit;
  const r = Math.round(v);
  const q = Math.abs(v - r) <= 1e-9 * Math.max(1, Math.abs(v)) ? r : Math.floor(v);
  return Number((q * unit).toFixed(10));
}

function minorUnit(currency: Currency, rule: RouteContext['settings']['routing']['minorUnits']): number {
  return 10 ** -(rule.decimals?.[currency] ?? rule.defaultDecimals);
}

function accountOk(n: GraphNode, mine: ReadonlySet<string>): boolean {
  return n.channel === 'cash' || (!!n.account && mine.has(n.account));
}

/**
 * Поиск лучших маршрутов обмена. Суммы нелинейны (комиссии с минимумом, фикс, округление наличных),
 * поэтому маршруты перебираются полностью (DFS) до maxExchanges обменов и maxSteps шагов,
 * без повторного захода в узел. Между парой узлов рассматриваются perPairLimit лучших различных курсов;
 * одинаковые курсы разных отделений одного банка схлопываются в одно ребро.
 */
export function findRoutes(q: RouteQuery, ctx: RouteContext): RouteResult {
  const now = q.now ?? new Date();
  // Прошедшие даты не поддерживаются: старые версии курсов не хранятся.
  const at = q.at && q.at.getTime() > now.getTime() ? q.at : now;
  const routing = ctx.settings.routing;
  const topN = q.topN ?? routing.topN;
  const mine = new Set(q.myAccounts);
  if (q.from.channel !== 'cash' && q.from.account) mine.add(q.from.account);
  const allowed = new Set<Channel>([...q.allowedChannels, q.from.channel, ...q.to.channels]);
  const myBranches = new Set(q.myBranches);
  const excluded = { notRoutable: 0, channelNotAllowed: 0, notMyAccount: 0, notMyBranch: 0, stale: 0 };

  const usable = (o: Offer, count: boolean): { ok: boolean; stale: boolean } => {
    const bump = (k: keyof typeof excluded) => {
      if (count) excluded[k]++;
      return { ok: false, stale: false };
    };
    if (!isRoutable(o)) return bump('notRoutable');
    if (!allowed.has(o.channel)) return bump('channelNotAllowed');
    if (o.channel !== 'cash' && !mine.has(o.source)) return bump('notMyAccount');
    if (o.branch && q.branchMode === 'mine' && !myBranches.has(`${o.source}|${o.branch}`)) return bump('notMyBranch');
    const stale = freshness(o, now, ctx.settings.staleAfterHours).stale;
    if (stale && q.excludeStale) return bump('stale');
    return { ok: true, stale };
  };

  // 1. Рёбра обмена: действующие на `at` версии, отфильтрованные по настройкам.
  const groups = new Map<string, ExchangeEdge>();
  for (const o of effectiveAt(ctx.offers, at)) {
    const u = usable(o, true);
    if (!u.ok) continue;
    const twinKey = [o.source, o.table, o.channel, o.from, o.to, o.rate, JSON.stringify(o.fee ?? null), o.minAmount, o.maxAmount, u.stale].join('|');
    const g = groups.get(twinKey);
    if (g) g.twins.push(o);
    else groups.set(twinKey, { kind: 'exchange', from: node(o.from, o.channel, o.source), to: node(o.to, o.channel, o.source), offer: o, twins: [], stale: u.stale });
  }
  const byPair = new Map<string, ExchangeEdge[]>();
  for (const e of groups.values()) {
    const k = `${nodeKey(e.from)}>${nodeKey(e.to)}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e);
  }
  const out = new Map<string, Edge[]>();
  const addEdge = (e: Edge) => {
    const k = nodeKey(e.from);
    (out.get(k) ?? out.set(k, []).get(k)!).push(e);
  };
  // Между парой узлов — все предложения с K лучшими РАЗЛИЧНЫМИ курсами (K ≥ topN).
  // Считать по рёбрам нельзя: одинаковые курсы разных банков вытеснили бы худшие курсы,
  // через которые может идти маршрут лучше показанных (найдено на живых данных).
  const k = Math.max(routing.perPairLimit, topN);
  for (const list of byPair.values()) {
    const rates = [...new Set(list.map((e) => e.offer.rate))].sort((a, b) => b - a).slice(0, k);
    const cutoff = rates.at(-1)!;
    list.filter((e) => e.offer.rate >= cutoff).forEach(addEdge);
  }

  // 2. Переходы между каналами/счетами из конфига (валюта не меняется).
  const currencies = new Set<Currency>([q.from.currency, q.to.currency]);
  for (const e of groups.values()) {
    currencies.add(e.offer.from);
    currencies.add(e.offer.to);
  }
  for (const t of ctx.transitions) {
    for (const cur of t.currency === '*' ? currencies : [t.currency]) {
      const from: GraphNode = { currency: cur, channel: t.from.channel, ...(t.from.account ? { account: t.from.account } : {}) };
      const to: GraphNode = { currency: cur, channel: t.to.channel, ...(t.to.account ? { account: t.to.account } : {}) };
      if (!allowed.has(from.channel) || !allowed.has(to.channel)) continue;
      if (!accountOk(from, mine) || !accountOk(to, mine)) continue;
      addEdge({ kind: 'transition', from, to, transition: t });
    }
  }

  // 3. Перебор.
  const startKey = nodeKey(q.from);
  const isTarget = (n: GraphNode) =>
    n.currency === q.to.currency && q.to.channels.includes(n.channel) && accountOk(n, mine);
  const found: Route[] = [];
  const visited = new Set<string>([startKey]);
  const path: RouteStep[] = [];

  const dfs = (at: GraphNode, amount: number, exchanges: number) => {
    if (path.length > 0 && isTarget(at)) found.push(makeRoute(path, amount, q.to.currency));
    if (path.length >= routing.maxSteps) return;
    for (const e of out.get(nodeKey(at)) ?? []) {
      const nk = nodeKey(e.to);
      if (visited.has(nk)) continue;
      if (e.kind === 'exchange' && exchanges >= routing.maxExchanges) continue;
      const step = e.kind === 'exchange' ? exchangeStep(e, amount, ctx, now) : transitionStep(e, amount, ctx);
      if (!step) continue;
      visited.add(nk);
      path.push(step);
      dfs(e.to, step.amountOut, exchanges + (e.kind === 'exchange' ? 1 : 0));
      path.pop();
      visited.delete(nk);
    }
  };
  if (q.amount > 0) dfs(q.from, q.amount, 0);

  const routes = groupEquivalent(found, q.from.currency).slice(0, topN);

  // 4. Будущие курсы по направлениям запроса и найденных маршрутов.
  const pairs = new Set<string>([`${q.from.currency}>${q.to.currency}`]);
  for (const r of routes) for (const s of r.steps) if (s.kind === 'exchange') pairs.add(`${s.from.currency}>${s.to.currency}`);
  const upcoming = upcomingAfter(ctx.offers, at)
    .filter((o) => pairs.has(`${o.from}>${o.to}`) && usable(o, false).ok)
    .sort((a, b) => effectiveFrom(a).localeCompare(effectiveFrom(b)) || b.rate - a.rate);

  return { at: at.toISOString(), routes, upcoming, excluded };
}

/**
 * Маршруты с одинаковой цепочкой узлов и одинаковым итогом (включая остатки) — один маршрут:
 * основной вариант — с наименьшим числом пометок, остальные банки — альтернативы по шагам.
 */
function groupEquivalent(found: Route[], fromCurrency: Currency): Route[] {
  const sig = (r: Route) =>
    [
      r.steps.map((s) => `${nodeKey(s.from)}>${nodeKey(s.to)}`).join(' '),
      r.amountOut.toFixed(6),
      r.leftovers.map((l) => `${l.currency}:${l.amount.toFixed(6)}`).sort().join(','),
    ].join('|');
  const groups = new Map<string, Route[]>();
  for (const r of found) {
    const k = sig(r);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: Route[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.flags.length - b.flags.length);
    const primary = list[0]!;
    primary.steps.forEach((step, i) => {
      if (step.kind !== 'exchange') return;
      const seen = new Set([`${step.source}|${step.branch ?? ''}`]);
      const alts: NonNullable<RouteStep['alternatives']> = [];
      for (const r of list.slice(1)) {
        const s = r.steps[i]!;
        const key = `${s.source}|${s.branch ?? ''}`;
        if (s.kind !== 'exchange' || seen.has(key)) continue;
        seen.add(key);
        const alt: NonNullable<RouteStep['alternatives']>[number] = { source: s.source!, sourceName: s.sourceName!, flags: s.flags };
        if (s.branch) alt.branch = s.branch;
        if (s.branchName) alt.branchName = s.branchName;
        alts.push(alt);
      }
      if (alts.length) step.alternatives = alts;
    });
    out.push(primary);
  }
  // При равном итоге выше маршрут, где больше возвращается в исходной валюте, затем — с меньшим числом пометок.
  const back = (r: Route) => r.leftovers.find((l) => l.currency === fromCurrency)?.amount ?? 0;
  return out.sort((a, b) => b.amountOut - a.amountOut || back(b) - back(a) || a.flags.length - b.flags.length);
}

function makeRoute(steps: RouteStep[], amountOut: number, currency: Currency): Route {
  const leftovers = new Map<Currency, number>();
  for (const s of steps) if (s.leftover) leftovers.set(s.leftover.currency, (leftovers.get(s.leftover.currency) ?? 0) + s.leftover.amount);
  const flags = [...new Set(steps.flatMap((s) => s.flags))];
  return {
    steps: steps.map((s) => ({ ...s, flags: [...s.flags], fees: [...s.fees] })),
    amountOut,
    currency,
    leftovers: [...leftovers].map(([c, amount]) => ({ amount, currency: c })),
    flags,
  };
}

function exchangeStep(e: ExchangeEdge, amountIn: number, ctx: RouteContext, now: Date): RouteStep | null {
  const o = e.offer;
  const src = ctx.sources[o.source];
  const fees: { label: string; fee: Fee; verified: boolean }[] = [];
  if (o.fee) fees.push({ label: 'комиссия банка', fee: o.fee, verified: true });
  if (src) {
    for (const r of matchingFeeRules({ jurisdiction: src.jurisdiction, channel: o.channel, from: o.from, to: o.to, source: o.source }, ctx.feeRules)) {
      fees.push({ label: r.label, fee: r.fee, verified: r.verified });
    }
  }
  const limits = { minAmount: o.minAmount, maxAmount: o.maxAmount };
  let res = convertStep(amountIn, o.rate, fees, limits);
  if (!res) return null;

  let gross = amountIn;
  let leftover: RouteStep['leftover'];
  let cashRounded = false;
  let minorRounded = false;
  const rounding = ctx.settings.routing.cashRounding;
  const minor = ctx.settings.routing.minorUnits;
  if (o.channel === 'cash' && rounding.enabled) {
    const unit = rounding.units?.[o.to] ?? rounding.defaultUnit;
    const rounded = floorTo(res.out, unit);
    if (rounded <= 0) return null;
    if (rounded < res.out - EPS) {
      // Сколько отдать за целую сумму выдачи: обратный пересчёт через курс и комиссии.
      let need = rounded / o.rate;
      for (let i = fees.length - 1; i >= 0; i--) need = grossForNet(need, fees[i]!.fee);
      gross = Math.min(amountIn, need);
      const again = convertStep(gross, o.rate, fees, limits);
      if (!again) return null;
      res = { ...again, out: rounded };
      cashRounded = true;
      let rest = amountIn - gross;
      if (minor.enabled && rest > EPS) {
        // Остаток меньше минимальной единицы валюты не возвращается (в пользу банка).
        const r = floorTo(rest, minorUnit(o.from, minor));
        if (r < rest - EPS) minorRounded = true;
        rest = r;
      }
      if (rest > EPS) leftover = { amount: rest, currency: o.from };
    }
  } else if (o.channel !== 'cash' && minor.enabled) {
    const r = floorTo(res.out, minorUnit(o.to, minor));
    if (r <= 0) return null;
    if (r < res.out - EPS) {
      minorRounded = true;
      res = { ...res, out: r };
    }
  }

  const flags: RouteStep['flags'] = [];
  if (o.channelConfidence === 'assumed') flags.push('channel-assumed');
  const stepFees: StepFee[] = res.fees.map((f) => ({
    label: f.label,
    amount: f.amount,
    currency: o.from,
    verified: fees.find((x) => x.label === f.label)?.verified ?? true,
  }));
  if (stepFees.some((f) => !f.verified)) flags.push('fee-unverified');
  if (cashRounded && !rounding.verified) flags.push('rounding-unverified');
  if (minorRounded && !minor.verified) flags.push('minor-rounding-unverified');
  if (e.stale) flags.push('stale');
  if (o.origin === 'manual') flags.push('manual');

  const branchName = (b?: string) => (b ? ctx.branchNames?.[`${o.source}|${b}`] : undefined);
  const step: RouteStep = {
    kind: 'exchange',
    from: e.from,
    to: e.to,
    amountIn,
    amountOut: res.out,
    rate: o.rate,
    fees: stepFees,
    source: o.source,
    sourceName: src?.name ?? o.source,
    offer: o,
    fetchedAt: o.fetchedAt,
    ageHours: freshness(o, now, ctx.settings.staleAfterHours).fetchedHoursAgo,
    flags,
  };
  if (leftover) step.leftover = leftover;
  if (o.validFrom) step.validFrom = o.validFrom;
  if (o.branch) {
    step.branch = o.branch;
    const n = branchName(o.branch);
    if (n) step.branchName = n;
  }
  if (e.twins.length) {
    step.alsoAtBranches = e.twins
      .filter((t) => t.branch)
      .map((t) => {
        const n = branchName(t.branch);
        return n ? { branch: t.branch!, name: n } : { branch: t.branch! };
      });
  }
  return step;
}

function transitionStep(e: TransitionEdge, amountIn: number, ctx: RouteContext): RouteStep | null {
  const t = e.transition;
  const res = convertStep(amountIn, 1, t.fee ? [{ label: t.label, fee: t.fee }] : [], {
    minAmount: t.minAmount,
    maxAmount: t.maxAmount,
  });
  if (!res) return null;
  const verified = !!t.verifiedAt;
  const flags: RouteFlag[] = verified ? [] : ['transition-unverified'];
  const minor = ctx.settings.routing.minorUnits;
  if (minor.enabled) {
    const r = floorTo(res.out, minorUnit(e.to.currency, minor));
    if (r <= 0) return null;
    if (r < res.out - EPS) {
      res.out = r;
      if (!minor.verified) flags.push('minor-rounding-unverified');
    }
  }
  return {
    kind: 'transition',
    from: e.from,
    to: e.to,
    amountIn,
    amountOut: res.out,
    rate: 1,
    fees: res.fees.map((f) => ({ ...f, currency: e.from.currency, verified })),
    transition: t,
    flags,
  };
}
