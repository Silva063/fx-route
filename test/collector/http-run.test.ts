import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Adapter } from '../../src/collector/adapter';
import { loadConfig } from '../../src/collector/config';
import { HttpError, PoliteHttp, ProtectedError, RobotsDisallowedError } from '../../src/collector/http';
import { runCollection } from '../../src/collector/run';
import type { SourceDef } from '../../src/core/types';
import { ROOT, settings } from '../helpers';

type Route = (req: Request) => Response | Promise<Response>;

/** Поддельный fetch + виртуальные часы: паузы не ждут по-настоящему, а записываются. */
function fakeNet(routes: Record<string, Route>) {
  let clock = 0;
  const sleeps: number[] = [];
  const calls: { url: string; at: number; ua: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, at: clock, ua: req.headers.get('user-agent') });
    const route = routes[req.url] ?? routes[new URL(req.url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route(req);
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    deps: {
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

const httpSettings = { ...settings.http, minDelayMs: 3000 };

describe('PoliteHttp', () => {
  it('честный User-Agent и пауза между запросами к хосту', async () => {
    const net = fakeNet({ '/rates': () => new Response('ok') });
    const http = new PoliteHttp(httpSettings, net.deps);
    await http.getText('https://bank.md/rates');
    await http.getText('https://bank.md/rates');
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual(['/robots.txt', '/rates', '/rates']);
    expect(net.calls.every((c) => c.ua === settings.http.userAgent)).toBe(true);
    expect(net.sleeps).toEqual([3000, 3000]);
  });

  it('Crawl-delay из robots.txt увеличивает паузу', async () => {
    const net = fakeNet({
      '/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 10\n'),
      '/': () => new Response('ok'),
    });
    const http = new PoliteHttp(httpSettings, net.deps);
    await http.getText('https://ecb.md/');
    await http.getText('https://ecb.md/');
    expect(net.sleeps.at(-1)).toBe(10_000);
  });

  it('robots.txt запрещает — запрос не выполняется', async () => {
    const net = fakeNet({ '/robots.txt': () => new Response('User-agent: *\nDisallow: /api/\n') });
    const http = new PoliteHttp(httpSettings, net.deps);
    await expect(http.getJson('https://energbank.com/api/v1/x')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(net.calls.some((c) => c.url.includes('/api/'))).toBe(false);
  });

  it('robots.txt недоступен (5xx) — всё запрещено, с понятной причиной', async () => {
    const net = fakeNet({ '/robots.txt': () => new Response('err', { status: 503 }) });
    const http = new PoliteHttp(httpSettings, net.deps);
    await expect(http.getText('https://down.md/')).rejects.toThrow(/robots\.txt недоступен/);
  });

  it('challenge-страница → ProtectedError без повторов', async () => {
    const page = readFileSync(join(ROOT, 'test/fixtures/challenge/foxcloud-bankexim-pmr.503.html'), 'utf8');
    const net = fakeNet({ '/': () => new Response(page, { status: 503 }) });
    const http = new PoliteHttp(httpSettings, net.deps);
    const err = await http.getText('https://bankexim.com/').catch((e) => e);
    expect(err).toBeInstanceOf(ProtectedError);
    expect(err.info.kind).toBe('foxcloud');
    expect(net.calls.filter((c) => c.url === 'https://bankexim.com/')).toHaveLength(1);
  });

  it('временная 5xx — один повтор', async () => {
    let n = 0;
    const net = fakeNet({ '/': () => (++n === 1 ? new Response('busy', { status: 502 }) : new Response('ok')) });
    const http = new PoliteHttp(httpSettings, net.deps);
    expect((await http.getText('https://x.md/')).text).toBe('ok');
  });

  it('редиректы: переход, cookie внутри цепочки, петля распознаётся', async () => {
    const net = fakeNet({
      'https://www.eximbank.md/': () =>
        new Response(null, { status: 301, headers: { location: 'https://eximbank.md/', 'set-cookie': 'a=1; Path=/' } }),
      'https://eximbank.md/': (req) => new Response(`cookie=${req.headers.get('cookie')}`),
      'https://www.comertbank.md/': () => new Response(null, { status: 301, headers: { location: 'https://www.comertbank.md/' } }),
    });
    const http = new PoliteHttp(httpSettings, net.deps);
    const ok = await http.getText('https://www.eximbank.md/');
    expect(ok.url).toBe('https://eximbank.md/');
    expect(ok.text).toBe('cookie=a=1');
    await expect(http.getText('https://www.comertbank.md/')).rejects.toThrow(/Петля/);
  });

  it('HTTP 404 → HttpError; не-JSON → HttpError', async () => {
    const net = fakeNet({ '/html': () => new Response('<html>') });
    const http = new PoliteHttp(httpSettings, net.deps);
    await expect(http.getText('https://x.md/missing')).rejects.toBeInstanceOf(HttpError);
    await expect(http.getJson('https://x.md/html')).rejects.toThrow(/не JSON/);
  });
});

describe('runCollection', () => {
  const def = (id: string, over: Partial<SourceDef> = {}): SourceDef => ({
    id,
    name: id,
    jurisdiction: 'MD',
    kind: 'bank',
    website: `https://${id}.md/`,
    ratesUrl: `https://${id}.md/curs`,
    collect: 'auto',
    adapter: id,
    tables: { cash: { label: 'Numerar', channel: 'cash', use: 'offer' } },
    ...over,
  });
  const at = '2026-09-28T10:00:00.000Z';
  const okAdapter: Adapter = async () => ({
    batches: [{ sourceUrl: 'https://good.md/curs', fetchedAt: at, quotes: [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 17.62, sell: 17.82 }] }],
  });
  const officialAdapter: Adapter = async () => ({
    official: [{ sourceUrl: 'https://bnm.md/', fetchedAt: at, base: 'MDL', validFor: '2026-09-28', rates: { USD: 17.7406 } }],
  });
  const http = new PoliteHttp(settings.http, fakeNet({}).deps);

  it('ошибка одного источника не роняет сбор; у каждого — свой статус', async () => {
    const { file, report } = await runCollection({
      sources: [
        def('good'),
        def('broken'),
        def('guarded'),
        def('empty'),
        def('typo'),
        def('nobody'),
        def('energ', { collect: 'manual-only', manualReason: 'robots.txt запрещает /api/' }),
        def('bnm', { kind: 'official', tables: undefined }),
      ],
      settings,
      adapters: {
        good: okAdapter,
        broken: async () => {
          throw new Error('селектор не найден');
        },
        guarded: async () => {
          throw new ProtectedError({ kind: 'foxcloud', evidence: 'x' }, 'https://guarded.md/');
        },
        empty: async () => ({ batches: [] }),
        typo: async () => ({
          batches: [{ sourceUrl: 'u', fetchedAt: at, quotes: [{ table: 'cash', base: 'USD', quote: 'MDL', buy: 1.762, sell: 1.782 }] }],
        }),
        bnm: officialAdapter,
      },
      http,
      runner: 'test',
      now: () => new Date(at),
    });
    const status = Object.fromEntries(report.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      bnm: 'ok',
      good: 'ok',
      broken: 'error',
      guarded: 'protected',
      empty: 'error',
      typo: 'ok',
      nobody: 'not-implemented',
      energ: 'manual-only',
    });
    // Официальный источник собран первым и использован в проверке: опечатка помечена.
    expect(report[0]!.id).toBe('bnm');
    expect(file.offers.filter((o) => o.source === 'typo').every((o) => o.status === 'suspicious')).toBe(true);
    expect(file.sources.find((s) => s.id === 'typo')!.suspicious).toBe(2);
    expect(file.sources.find((s) => s.id === 'guarded')!.message).toMatch(/только вручную/);
    expect(file.offers.filter((o) => o.source === 'good')).toHaveLength(2);
    expect(file.official).toHaveLength(1);
  });

  it('предупреждения адаптера → partial', async () => {
    const { report } = await runCollection({
      sources: [def('good')],
      settings,
      adapters: { good: async (ctx) => ({ ...(await okAdapter(ctx)), warnings: ['таблица карт не найдена'] }) },
      http,
      runner: 'test',
    });
    expect(report[0]).toMatchObject({ status: 'partial', message: 'таблица карт не найдена' });
  });

  it('зависший адаптер обрывается по таймауту', async () => {
    const { report } = await runCollection({
      sources: [def('slow')],
      settings: { ...settings, sourceTimeoutMs: 20 },
      adapters: { slow: () => new Promise(() => {}) },
      http,
      runner: 'test',
    });
    expect(report[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/таймаут/) });
  });
});

describe('конфиг проекта', () => {
  it('config/*.json проходит валидацию; Energbank — только вручную', async () => {
    const cfg = await loadConfig(join(ROOT, 'config'));
    const energ = cfg.sources.find((s) => s.id === 'energbank')!;
    expect(energ.collect).toBe('manual-only');
    expect(cfg.transitions).toEqual([]);
    expect(cfg.fees.map((f) => f.id)).toContain('md-cash-fx-purchase-0.1');
  });
});
