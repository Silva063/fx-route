import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectChallenge } from '../../src/collector/challenge';
import { parseRobots } from '../../src/collector/robots';
import { ROOT } from '../helpers';

const dir = join(ROOT, 'test/fixtures/challenge');

/** Файлы фикстур: <вид>-<описание>.<HTTP-статус>.html; вид "ok" — обычная страница. */
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => {
    const m = /^(.+)\.(\d{3})\.html$/.exec(f)!;
    return { file: f, status: Number(m[2]), ok: f.startsWith('ok-'), body: readFileSync(join(dir, f), 'utf8') };
  });

describe('detectChallenge на реальных страницах из разведки', () => {
  it('фикстуры есть', () => expect(fixtures.length).toBeGreaterThanOrEqual(7));

  for (const fx of fixtures) {
    it(`${fx.file} → ${fx.ok ? 'не challenge' : 'challenge'}`, () => {
      const r = detectChallenge({ status: fx.status, headers: new Headers(), body: fx.body });
      if (fx.ok) expect(r).toBeNull();
      else expect(r).not.toBeNull();
    });
  }

  it('виды защиты определяются верно', () => {
    const get = (name: string) => fixtures.find((f) => f.file.startsWith(name))!;
    const fox = get('foxcloud');
    expect(detectChallenge({ status: fox.status, headers: new Headers(), body: fox.body })!.kind).toBe('foxcloud');
    const inc = get('incapsula');
    expect(detectChallenge({ status: inc.status, headers: new Headers(), body: inc.body })!.kind).toBe(
      'imperva-incapsula',
    );
  });

  it('скрипт Incapsula в начале большой обычной страницы — не challenge', () => {
    const body =
      '<html><head><script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script></head><body>' +
      '<table><tr><td>USD</td><td>17.62</td></tr></table>'.repeat(500) +
      '</body></html>';
    expect(body.length).toBeGreaterThan(5_000);
    expect(detectChallenge({ status: 200, headers: new Headers(), body })).toBeNull();
    // Та же страница, но крошечная или с ошибкой — заглушка.
    expect(detectChallenge({ status: 403, headers: new Headers(), body })!.kind).toBe('imperva-incapsula');
  });

  it('Cloudflare challenge по заголовку и по странице', () => {
    expect(
      detectChallenge({ status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), body: '' })!.kind,
    ).toBe('cloudflare');
    expect(
      detectChallenge({ status: 403, headers: new Headers(), body: '<html><title>Just a moment...</title></html>' })!
        .kind,
    ).toBe('cloudflare');
  });

  it('капча в ответе с ошибкой — защита; форма с reCAPTCHA на 200 — нет', () => {
    const body = '<div class="g-recaptcha" data-sitekey="x"></div>';
    expect(detectChallenge({ status: 429, headers: new Headers(), body })!.kind).toBe('captcha');
    expect(detectChallenge({ status: 200, headers: new Headers(), body })).toBeNull();
  });

  it('обычная ошибка сервера — не защита', () => {
    expect(detectChallenge({ status: 500, headers: new Headers(), body: 'Internal Server Error' })).toBeNull();
  });
});

describe('parseRobots', () => {
  it('реальные правила: Energbank запрещает /api/, maib — старый путь курсов', () => {
    const energ = parseRobots('User-agent: *\nDisallow: /api/\n', 'fx-route-collector');
    expect(energ.isAllowed('/api/v1/main/corebanking/exchanges/cash/history')).toBe(false);
    expect(energ.isAllowed('/ro')).toBe(true);

    const maib = parseRobots(
      'User-agent: *\nDisallow: /admin/*\nDisallow: /api\nDisallow: /ro/persoane-fizice/curs-valutar\n',
      'fx-route-collector',
    );
    expect(maib.isAllowed('/ro/curs-valutar')).toBe(true);
    expect(maib.isAllowed('/ro/persoane-fizice/curs-valutar')).toBe(false);
    expect(maib.isAllowed('/api/rates')).toBe(false);
  });

  it('Victoriabank: /api/ запрещён, /bff/api/ — нет', () => {
    const vb = parseRobots('User-agent: *\nDisallow: /api/\n', 'fx-route-collector');
    expect(vb.isAllowed('/bff/api/currency-rates?marketType=11')).toBe(true);
  });

  it('Crawl-delay (ECB, Comerțbank)', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 10 #\n', 'fx-route-collector').crawlDelay).toBe(10);
  });

  it('шаблоны * и $, самое длинное совпадение, Allow при равенстве', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /*index.php$\nDisallow: /private/\nAllow: /private/public\n',
      'fx-route-collector',
    );
    expect(r.isAllowed('/index.php')).toBe(false);
    expect(r.isAllowed('/index.php?x=1')).toBe(true);
    expect(r.isAllowed('/private/a')).toBe(false);
    expect(r.isAllowed('/private/public/x')).toBe(true);
  });

  it('группа для нашего User-Agent важнее группы *', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: fx-route-collector\nDisallow: /secret\n',
      'fx-route-collector',
    );
    expect(r.isAllowed('/rates')).toBe(true);
    expect(r.isAllowed('/secret')).toBe(false);
  });

  it('пустой Disallow — всё разрешено; несколько user-agent в одной группе', () => {
    expect(parseRobots('User-agent: *\nDisallow:\n', 'x').isAllowed('/a')).toBe(true);
    const r = parseRobots('User-agent: googlebot\nUser-agent: *\nDisallow: /x\n', 'fx-route-collector');
    expect(r.isAllowed('/x')).toBe(false);
  });
});
