/** Часовой пояс обоих берегов (Молдова и ПМР). */
export const LOCAL_TZ = 'Europe/Chisinau';

/** Календарная дата (YYYY-MM-DD) момента ISO в часовом поясе Кишинёва/Тирасполя. */
export function localDate(iso: string | Date, timeZone = LOCAL_TZ): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // en-CA даёт формат YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "28.09.2026" → "2026-09-28". Возвращает null, если формат не распознан. */
export function dmyToIso(dmy: string): string | null {
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(dmy.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
}

export function hoursBetween(fromIso: string, to: Date): number {
  return (to.getTime() - new Date(fromIso).getTime()) / 3_600_000;
}

/** Смещение часового пояса (минуты, восток — плюс) в момент utcMs. */
function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * Местное время Кишинёва/Тирасполя без часового пояса ("2026-09-28T09:16:00") → ISO UTC.
 * Нужен, потому что сборщик работает и на ПК (местное время), и в GitHub Actions (UTC).
 */
export function zonedLocalToIso(local: string, timeZone = LOCAL_TZ): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0));
  const offset = tzOffsetMinutes(guess - tzOffsetMinutes(guess, timeZone) * 60_000, timeZone);
  return new Date(guess - offset * 60_000).toISOString();
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

/**
 * Дата из текста страницы → YYYY-MM-DD. Понимает «28.09.2026», «28/09/2026»,
 * «2026.09.28», «29 September 2026». Возвращает null, если даты нет или она невалидна.
 */
export function parseDateLoose(text: string): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, mo: number, d: number) => {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      ? `${y}-${pad(mo)}-${pad(d)}`
      : null;
  };
  let m = /\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/.exec(text);
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/.exec(text);
  if (m) return ok(+m[3]!, +m[2]!, +m[1]!);
  m = /\b(\d{1,2})\s*([A-Za-z]+)\s*(\d{4})\b/.exec(text);
  if (m && MONTHS[m[2]!.toLowerCase()]) return ok(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!);
  return null;
}
