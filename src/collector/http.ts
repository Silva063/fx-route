import { detectChallenge, type ChallengeInfo } from './challenge';
import { ALLOW_ALL, parseRobots, type Robots } from './robots';
import type { Settings } from '../core/types';

export class ProtectedError extends Error {
  constructor(
    public readonly info: ChallengeInfo,
    public readonly url: string,
  ) {
    super(`Защита от ботов (${info.kind}): ${info.evidence} — ${url}`);
    this.name = 'ProtectedError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(
    public readonly url: string,
    reason?: string,
  ) {
    super(reason ? `robots.txt недоступен (${reason}), запрос не выполнен: ${url}` : `robots.txt запрещает ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Headers;
  text: string;
  fetchedAt: string;
}

export interface HttpClient {
  request(url: string, req?: HttpRequest): Promise<HttpResponse>;
  getText(url: string, req?: HttpRequest): Promise<HttpResponse>;
  getJson<T = unknown>(url: string, req?: HttpRequest): Promise<{ data: T; response: HttpResponse }>;
}

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Вежливый HTTP-клиент сборщика:
 * - соблюдает robots.txt (Disallow и Crawl-delay) для каждого хоста;
 * - выдерживает паузу между запросами к одному хосту: max(minDelayMs, Crawl-delay);
 * - запросы к одному хосту идут строго последовательно;
 * - честный User-Agent из настроек, без маскировки под браузер;
 * - распознаёт challenge-страницы и бросает ProtectedError, ничего не обходя.
 */
export class PoliteHttp implements HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastAt = new Map<string, number>();
  private readonly robotsCache = new Map<string, Promise<Robots>>();
  readonly productToken: string;

  constructor(
    private readonly settings: Settings['http'],
    deps: HttpDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.productToken = settings.userAgent.split(/[/\s]/)[0] ?? settings.userAgent;
  }

  /** Выполняет fn в очереди хоста с соблюдением паузы. */
  private schedule<T>(host: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(host) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(async () => {
        const last = this.lastAt.get(host);
        if (last !== undefined) {
          const wait = last + delayMs - this.now();
          if (wait > 0) await this.sleep(wait);
        }
        try {
          return await fn();
        } finally {
          this.lastAt.set(host, this.now());
        }
      });
    this.queues.set(host, run);
    return run;
  }

  private rawFetch(url: string, req: HttpRequest, cookie: string): Promise<Response> {
    return this.fetchImpl(url, {
      method: req.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': this.settings.userAgent,
        Accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,ro;q=0.9,en;q=0.8',
        ...(cookie ? { Cookie: cookie } : {}),
        ...req.headers,
      },
      ...(req.body !== undefined ? { body: req.body } : {}),
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });
  }

  private robotsFor(origin: string): Promise<Robots> {
    let p = this.robotsCache.get(origin);
    if (!p) {
      p = this.loadRobots(origin);
      this.robotsCache.set(origin, p);
    }
    return p;
  }

  private async loadRobots(origin: string): Promise<Robots> {
    const host = new URL(origin).host;
    let url = `${origin}/robots.txt`;
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const res = await this.schedule(host, this.settings.minDelayMs, () => this.rawFetch(url, {}, ''));
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.arrayBuffer().catch(() => {});
          url = new URL(loc, url).toString();
          continue;
        }
        const text = await res.text();
        // RFC 9309: 4xx — ограничений нет; 5xx — сервер недоступен, считаем всё запрещённым.
        if (res.status >= 500) {
          this.log(`robots.txt ${origin}: статус ${res.status}, считаем всё запрещённым`);
          return { isAllowed: () => false, unreachable: `HTTP ${res.status}` };
        }
        if (res.status >= 400) return ALLOW_ALL;
        if (/^\s*</.test(text)) return ALLOW_ALL; // вместо robots.txt пришла HTML-страница
        const robots = parseRobots(text, this.productToken);
        if (robots.crawlDelay) this.log(`robots.txt ${origin}: Crawl-delay ${robots.crawlDelay} c`);
        return robots;
      }
      return ALLOW_ALL; // слишком много редиректов у robots.txt — по RFC считаем недоступным как 4xx
    } catch (e) {
      this.log(`robots.txt ${origin}: не получен (${(e as Error).message}), считаем всё запрещённым`);
      return { isAllowed: () => false, unreachable: (e as Error).message };
    }
  }

  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    let current = url;
    let currentReq = req;
    let cookie = '';
    const visited: string[] = [];
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      const robots = await this.robotsFor(u.origin);
      if (!robots.isAllowed(u.pathname + u.search)) throw new RobotsDisallowedError(current, robots.unreachable);
      const delay = Math.max(this.settings.minDelayMs, (robots.crawlDelay ?? 0) * 1000);

      const res = await this.fetchWithRetry(u.host, delay, current, currentReq, cookie);
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length) {
        cookie = [cookie, ...setCookies.map((c) => c.split(';')[0])].filter(Boolean).join('; ');
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.arrayBuffer().catch(() => {});
        visited.push(current);
        current = new URL(loc, current).toString();
        if (hop + 1 > this.settings.maxRedirects || visited.filter((v) => v === current).length >= 2) {
          throw new HttpError(`Петля или слишком много редиректов: ${visited.join(' → ')} → ${current}`, url);
        }
        // После 301/302/303 браузеры переходят методом GET.
        if (res.status !== 307 && res.status !== 308) currentReq = { headers: req.headers ?? {} };
        continue;
      }
      const text = await res.text();
      const challenge = detectChallenge({ status: res.status, headers: res.headers, body: text });
      if (challenge) throw new ProtectedError(challenge, current);
      if (res.status < 200 || res.status >= 300) {
        throw new HttpError(`HTTP ${res.status}`, current, res.status);
      }
      return { url: current, status: res.status, headers: res.headers, text, fetchedAt: new Date(this.now()).toISOString() };
    }
  }

  private async fetchWithRetry(
    host: string,
    delay: number,
    url: string,
    req: HttpRequest,
    cookie: string,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.schedule(host, delay, () => this.rawFetch(url, req, cookie));
        // Повторяем только временные ошибки сервера; challenge-страницы (обычно 403/503 с телом)
        // не повторяем — их распознаёт вызывающий код.
        if (res.status >= 500 && attempt < this.settings.retries) {
          const body = await res.clone().text().catch(() => '');
          if (!detectChallenge({ status: res.status, headers: res.headers, body })) {
            this.log(`${url}: HTTP ${res.status}, повтор`);
            continue;
          }
        }
        return res;
      } catch (e) {
        if (attempt >= this.settings.retries) {
          throw new HttpError(`Сеть: ${(e as Error).message}`, url);
        }
        this.log(`${url}: ${(e as Error).message}, повтор`);
      }
    }
  }

  getText(url: string, req?: HttpRequest): Promise<HttpResponse> {
    return this.request(url, req);
  }

  async getJson<T = unknown>(url: string, req?: HttpRequest): Promise<{ data: T; response: HttpResponse }> {
    return jsonFrom<T>(await this.request(url, req));
  }
}

/** Разбор JSON-ответа; общий для всех реализаций HttpClient. */
export function jsonFrom<T>(response: HttpResponse): { data: T; response: HttpResponse } {
  try {
    return { data: JSON.parse(response.text.replace(/^﻿/, '')) as T, response };
  } catch {
    throw new HttpError(`Ответ не JSON (${response.text.slice(0, 80)}…)`, response.url, response.status);
  }
}
