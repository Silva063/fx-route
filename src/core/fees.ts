import type { Channel, Currency, Fee, FeeRule, Jurisdiction } from './types';

export interface FeeContext {
  jurisdiction: Jurisdiction;
  channel: Channel;
  from: Currency;
  to: Currency;
  source: string;
}

/** Правила комиссий из конфига, применимые к шагу обмена. */
export function matchingFeeRules(ctx: FeeContext, rules: readonly FeeRule[]): FeeRule[] {
  return rules.filter((r) => {
    const m = r.match;
    if (m.jurisdiction && !m.jurisdiction.includes(ctx.jurisdiction)) return false;
    if (m.channel && !m.channel.includes(ctx.channel)) return false;
    if (m.from && !m.from.includes(ctx.from)) return false;
    if (m.fromNot && m.fromNot.includes(ctx.from)) return false;
    if (m.to && !m.to.includes(ctx.to)) return false;
    if (m.toNot && m.toNot.includes(ctx.to)) return false;
    if (m.source && !m.source.includes(ctx.source)) return false;
    return true;
  });
}

function clampFee(fee: number, f: Fee): number {
  let v = fee;
  if (f.minFee !== undefined) v = Math.max(v, f.minFee);
  if (f.maxFee !== undefined) v = Math.min(v, f.maxFee);
  return v;
}

/**
 * Применяет комиссию к сумме, которую клиент отдаёт.
 * Возвращает сумму, которая реально пойдёт в обмен/перевод, и размер комиссии.
 * null — суммы не хватает даже на комиссию.
 */
export function applyFee(amount: number, fee: Fee | undefined): { net: number; fee: number } | null {
  if (!fee) return amount > 0 ? { net: amount, fee: 0 } : null;
  const p = (fee.percent ?? 0) / 100;
  const fixed = fee.fixed ?? 0;
  let net: number;
  if ((fee.mode ?? 'deduct') === 'deduct') {
    net = amount - clampFee(amount * p + fixed, fee);
  } else {
    // Комиссия сверху: net + fee(net) = amount; fee(net) монотонна по net.
    net = (amount - fixed) / (1 + p);
    const raw = net * p + fixed;
    if (fee.minFee !== undefined && raw < fee.minFee) net = amount - fee.minFee;
    else if (fee.maxFee !== undefined && raw > fee.maxFee) net = amount - fee.maxFee;
  }
  if (!(net > 0)) return null;
  return { net, fee: amount - net };
}

/**
 * Обратная операция к applyFee: какую сумму отдать, чтобы после комиссии осталось net.
 * Нужна для округления наличных: сначала выбирается целая сумма выдачи, потом — сколько за неё отдать.
 */
export function grossForNet(net: number, fee: Fee | undefined): number {
  if (!fee) return net;
  const p = (fee.percent ?? 0) / 100;
  const fixed = fee.fixed ?? 0;
  if ((fee.mode ?? 'deduct') === 'onTop') return net + clampFee(net * p + fixed, fee);
  const g0 = (net + fixed) / (1 - p);
  const fee0 = g0 * p + fixed;
  if (fee.minFee !== undefined && fee0 < fee.minFee) return net + fee.minFee;
  if (fee.maxFee !== undefined && fee0 > fee.maxFee) return net + fee.maxFee;
  return g0;
}

export interface StepResult {
  /** Сколько получено в целевой валюте. */
  out: number;
  /** Удержанные комиссии в валюте входа, по порядку применения. */
  fees: { label: string; amount: number }[];
}

/**
 * Один шаг: комиссии (по порядку) удерживаются из входной суммы, остаток обменивается по rate.
 * Ограничения min/max проверяются по сумме, которую клиент отдаёт.
 */
export function convertStep(
  amountIn: number,
  rate: number,
  fees: readonly { label: string; fee: Fee }[],
  limits?: { minAmount?: number | undefined; maxAmount?: number | undefined },
): StepResult | null {
  if (limits?.minAmount !== undefined && amountIn < limits.minAmount) return null;
  if (limits?.maxAmount !== undefined && amountIn > limits.maxAmount) return null;
  let amount = amountIn;
  const applied: StepResult['fees'] = [];
  for (const f of fees) {
    const r = applyFee(amount, f.fee);
    if (!r) return null;
    if (r.fee > 0) applied.push({ label: f.label, amount: r.fee });
    amount = r.net;
  }
  return { out: amount * rate, fees: applied };
}
