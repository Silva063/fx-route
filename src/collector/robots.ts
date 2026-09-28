/**
 * Минимальный разбор robots.txt (RFC 9309): группы user-agent, Allow/Disallow
 * с `*` и `$`, правило самого длинного совпадения, плюс нестандартный Crawl-delay.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

export interface Robots {
  isAllowed(path: string): boolean;
  /** Crawl-delay в секундах для нашей группы, если указан. */
  crawlDelay?: number;
  /** Причина полного запрета, если robots.txt недоступен (5xx/сеть). */
  unreachable?: string;
}

export const ALLOW_ALL: Robots = { isAllowed: () => true };

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // Пустой Disallow означает «всё разрешено» — правило не добавляем.
      if (value !== '') current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** productToken — первое слово нашего User-Agent до «/», например «fx-route-collector». */
export function parseRobots(text: string, productToken: string): Robots {
  const groups = parseGroups(text);
  const token = productToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: patternToRegex(r.pattern) }));
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);

  const robots: Robots = {
    isAllowed(path: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        const len = r.pattern.length;
        // Самое длинное совпадение; при равенстве Allow важнее.
        if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
      }
      return best ? best.allow : true;
    },
  };
  if (delays.length) robots.crawlDelay = Math.max(...delays);
  return robots;
}
