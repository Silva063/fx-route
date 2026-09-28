// Разведочный зонд доступности источников курсов.
// Запуск: node recon/probe.mjs [out.json]   (Node >= 20, без зависимостей)
// Одинаково работает локально и в GitHub Actions. Делает по одному запросу
// на цель с паузой 1.5 с, ничего не обходит: challenge-страницы только фиксируются.
import { writeFileSync } from 'node:fs';

const UA = process.env.PROBE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const today = new Date();
const dmy = [today.getUTCDate(), today.getUTCMonth() + 1, today.getUTCFullYear()]
  .map((n, i) => (i < 2 ? String(n).padStart(2, '0') : String(n))).join('.');
const ymd = today.toISOString().slice(0, 10);

// expect: регулярка, совпадение с которой означает «курсы реально получены».
const targets = [
  // --- ПМР ---
  { id: 'agroprombank-html', url: 'https://www.agroprombank.com/eshche/poleznoe/kursy-valyut/', expect: /USD\/RUP[\s\S]{0,400}?\d+\.\d{4}/ },
  { id: 'agroprombank-json', url: `https://www.agroprombank.com/includes/histratesnew.php?type=all&date=${dmy}&json=1`, expect: /"value_buy"/ },
  { id: 'prisbank-api', url: 'https://api.prisbank.com/courses', expect: /"abbr":"USD"/ },
  { id: 'bankexim-pmr', url: 'https://bankexim.com/', expect: /USD[\s\S]{0,300}?\d+[.,]\d{2,4}/ },
  { id: 'cbpmr-official', url: 'https://www.cbpmr.net/kursval.php?lang=ru', expect: /USD[\s\S]{0,200}?\d+\.\d{4}/ },
  // --- Молдова ---
  { id: 'bnm-official-xml', url: `https://www.bnm.md/ro/official_exchange_rates?get_xml=1&date=${dmy}`, expect: /<CharCode>USD<\/CharCode>/ },
  { id: 'maib', url: 'https://www.maib.md/ro/curs-valutar', expect: /USD[\s\S]{0,300}?\d+\.\d{2}/ },
  { id: 'micb', url: 'https://micb.md/', expect: /data-sell="\d/ },
  { id: 'victoriabank-cash', url: `https://www.victoriabank.md/bff/api/currency-rates?dateFrom=${ymd}&dateTo=${ymd}&marketType=11&lang=ro-RO`, expect: /"buyRate"/ },
  { id: 'victoriabank-online', url: `https://www.victoriabank.md/bff/api/currency-rates?dateFrom=${ymd}&dateTo=${ymd}&marketType=14&lang=ro-RO`, expect: /"buyRate"/ },
  { id: 'otpbank', url: 'https://www.otpbank.md/exchange', expect: /USD[\s\S]{0,300}?\d+\.\d{4}/ },
  { id: 'procreditbank', url: 'https://procreditbank.md/ro/schimb_valutar', expect: /USD[\s\S]{0,300}?\d+\.\d{4}/ },
  { id: 'fincombank-cash', url: 'https://fincombank.com/ro/curs-valutar', expect: /USD[\s\S]{0,300}?\d+\.\d{2} MDL/ },
  { id: 'fincombank-card', url: 'https://fincombank.com/ro/curs-valutar-pentru-carduri', expect: /USD[\s\S]{0,300}?\d+\.\d{2} MDL/ },
  { id: 'energbank-cash', url: 'https://www.energbank.com/api/v1/main/corebanking/exchanges/cash/history', expect: /"buying"/ },
  { id: 'energbank-card', url: 'https://www.energbank.com/api/v1/main/corebanking/exchanges/card/history', expect: /"buying"/ },
  { id: 'eurocreditbank', url: 'https://www.ecb.md/', expect: /USD[\s\S]{0,300}?\d+\.\d{4}/ },
  { id: 'comertbank', url: 'https://comertbank.md/', expect: /vault_nr">\d+\.\d{4}/ },
  { id: 'eximbank-md', url: 'https://www.eximbank.md/', expect: /USD[\s\S]{0,300}?\d+\.\d{2,4}/ },
];

function detectProtection(status, headers, body) {
  const h = (k) => headers.get(k) || '';
  if (/incap_ses|visid_incap/.test(h('set-cookie')) || /_Incapsula_Resource/.test(body)) return 'Imperva Incapsula';
  if (/FOXCLOUD/i.test(body) && /провер|check/i.test(body)) return 'FOXCLOUD browser check';
  if (/cloudflare/i.test(h('server')) && (status === 403 || status === 503) && /challenge|cf-chl|Just a moment/i.test(body)) return 'Cloudflare challenge';
  if (/captcha/i.test(body) && status >= 400) return 'captcha';
  return h('server').toLowerCase().includes('cloudflare') ? 'Cloudflare (без challenge)' : '';
}

async function probe(t) {
  const started = Date.now();
  let hops = 0, url = t.url, res, cookie = '';
  try {
    // ручные редиректы, чтобы поймать петли
    for (;;) {
      res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'ro,ru;q=0.9,en;q=0.8', ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(30000) });
      const sc = res.headers.getSetCookie?.() || [];
      if (sc.length) cookie = [cookie, ...sc.map((c) => c.split(';')[0])].filter(Boolean).join('; ');
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url).toString();
        if (++hops > 6) return { id: t.id, url: t.url, ok: false, status: res.status, note: `петля редиректов (${next})`, ms: Date.now() - started };
        url = next; await res.arrayBuffer().catch(() => {}); continue;
      }
      break;
    }
    const body = await res.text();
    const protection = detectProtection(res.status, res.headers, body);
    const ok = res.ok && t.expect.test(body);
    return { id: t.id, url: t.url, finalUrl: url, ok, status: res.status, bytes: body.length, protection, server: res.headers.get('server') || '', ms: Date.now() - started };
  } catch (e) {
    return { id: t.id, url: t.url, ok: false, status: 0, note: `${e.name}: ${e.cause?.code || e.message}`, ms: Date.now() - started };
  }
}

const results = [];
for (const t of targets) {
  const r = await probe(t);
  results.push(r);
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.status).padEnd(3)} ${r.id.padEnd(22)} ${r.protection || ''} ${r.note || ''}`);
  await new Promise((s) => setTimeout(s, 1500));
}
let ipInfo = null;
try { ipInfo = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })).json(); } catch {}
const report = { probedAt: new Date().toISOString(), runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', egress: ipInfo && { ip: ipInfo.ip, country: ipInfo.country, org: ipInfo.org }, results };
const out = process.argv[2] || 'probe-result.json';
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nОтчёт: ${out}; egress: ${ipInfo ? `${ipInfo.country} ${ipInfo.org}` : 'неизвестно'}`);
