import type { Channel, Currency } from '../../src/core/types';

export const CURRENCY_NAMES: Record<string, string> = {
  RUP: 'рубль ПМР',
  MDL: 'лей',
  USD: 'доллар США',
  EUR: 'евро',
  RUB: 'российский рубль',
  UAH: 'гривна',
  RON: 'румынский лей',
  GBP: 'фунт',
  CHF: 'франк',
};

/** Порядок валют в выпадающих списках. */
export const CURRENCY_ORDER = ['RUP', 'MDL', 'USD', 'EUR', 'RUB', 'UAH', 'RON', 'GBP', 'CHF'];

export const CHANNEL_NAMES: Record<Channel, string> = {
  cash: 'наличные',
  card: 'карта',
  online: 'онлайн',
  unknown: 'канал неизвестен',
};

export const currencyLabel = (c: Currency) => (CURRENCY_NAMES[c] ? `${c} — ${CURRENCY_NAMES[c]}` : c);

const nf = (max: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: max, minimumFractionDigits: 0 });
const money = nf(2);
const rate = nf(6);

export const fmtMoney = (n: number) => money.format(n);
export const fmtRate = (n: number) => rate.format(n);

const dt = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Chisinau',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const d = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Chisinau', day: '2-digit', month: '2-digit', year: 'numeric' });

export const fmtDateTime = (iso: string) => dt.format(new Date(iso));

/** validFrom: дата («2026-09-29») или дата-время. */
export function fmtValidFrom(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? d.format(new Date(`${v}T12:00:00Z`)) : fmtDateTime(v);
}

/** «5 мин назад», «3 ч назад», «2 дн назад». */
export function fmtAge(iso: string, now = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export const hoursAgo = (iso: string, now = new Date()) => (now.getTime() - new Date(iso).getTime()) / 3_600_000;
