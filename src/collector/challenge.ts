/**
 * Распознавание страниц защиты от ботов (challenge, капча, блок).
 * Правило проекта: такие страницы НЕ обходятся. Источник получает статус
 * «protected» — «защита, только вручную».
 *
 * Важно не путать защиту с обычной страницей за CDN: maib отдаёт нормальную страницу
 * с cookie Incapsula, MICB — через Cloudflare без challenge, у OTP на обычной странице
 * есть reCAPTCHA для форм. Поэтому признаки — только тело/заголовки самой заглушки.
 */

export type ChallengeKind =
  | 'imperva-incapsula'
  | 'foxcloud'
  | 'cloudflare'
  | 'ddos-guard'
  | 'f5-asm'
  | 'captcha';

export interface ChallengeInfo {
  kind: ChallengeKind;
  evidence: string;
}

export interface ResponseLike {
  status: number;
  headers: Headers;
  body: string;
}

const head = (body: string) => body.slice(0, 20_000);

export function detectChallenge(r: ResponseLike): ChallengeInfo | null {
  const h = (k: string) => r.headers.get(k) ?? '';
  const b = head(r.body);

  // Cloudflare сам помечает challenge-ответы этим заголовком.
  if (h('cf-mitigated').toLowerCase() === 'challenge') {
    return { kind: 'cloudflare', evidence: 'заголовок cf-mitigated: challenge' };
  }
  if (
    /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>/i.test(b) ||
    /\/cdn-cgi\/challenge-platform\//.test(b) ||
    /\bcf-chl-|window\._cf_chl_opt/.test(b)
  ) {
    return { kind: 'cloudflare', evidence: 'страница challenge Cloudflare' };
  }

  // Imperva Incapsula: challenge-страница подгружает /_Incapsula_Resource и почти пуста.
  // Скрипт Incapsula бывает и на обычных страницах, поэтому дополнительно требуем
  // ошибочный статус или крошечное тело (у заглушки ~1 КБ).
  if (
    /Incapsula incident ID/i.test(b) ||
    (/_Incapsula_Resource/.test(b) && (r.status >= 400 || r.body.length < 5_000))
  ) {
    return { kind: 'imperva-incapsula', evidence: 'страница Incapsula (_Incapsula_Resource)' };
  }

  if (/FOXCLOUD/i.test(b) && /(проверяем ваш браузер|check your browser|browser check|verificăm browserul)/i.test(b)) {
    return { kind: 'foxcloud', evidence: 'страница «проверка браузера» FOXCLOUD' };
  }

  if (/ddos-guard/i.test(h('server')) && r.status >= 400) {
    return { kind: 'ddos-guard', evidence: `server: ${h('server')}, статус ${r.status}` };
  }
  if (/The requested URL was rejected\. Please consult with your administrator/i.test(b)) {
    return { kind: 'f5-asm', evidence: 'страница блокировки F5 ASM' };
  }

  // Капча как ответ на сам запрос (не форма на обычной странице): только при ошибочном статусе.
  if (r.status >= 400 && /(g-recaptcha|h-captcha|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile|captcha)/i.test(b)) {
    return { kind: 'captcha', evidence: `капча в ответе со статусом ${r.status}` };
  }
  return null;
}
