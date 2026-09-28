import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChallengeKind } from './challenge';
import {
  HttpError,
  ProtectedError,
  RobotsDisallowedError,
  jsonFrom,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './http';

/**
 * Фикстуры адаптеров: каждый ответ, полученный адаптером, сохраняется в
 * test/fixtures/sources/<id>/ (тело + index.json). Тест адаптера воспроизводит их без сети,
 * с тем же «сейчас», что было при записи, — так видно, когда сайт поменял вёрстку:
 * перезаписали фикстуру → тест упал.
 */

interface OkEntry {
  method: string;
  url: string;
  body?: string;
  file: string;
  status: number;
  finalUrl: string;
  fetchedAt: string;
  contentType: string;
}
interface ErrorEntry {
  method: string;
  url: string;
  body?: string;
  error: { name: string; message: string; kind?: ChallengeKind; status?: number };
}
type Entry = OkEntry | ErrorEntry;

export interface FixtureIndex {
  source: string;
  /** Момент записи — в тестах подставляется как ctx.now(). */
  recordedAt: string;
  entries: Entry[];
}

function extFor(contentType: string): string {
  if (/json/i.test(contentType)) return 'json';
  if (/xml/i.test(contentType)) return 'xml';
  return 'html';
}

export class RecordingHttp implements HttpClient {
  private readonly entries: Entry[] = [];
  constructor(
    private readonly inner: HttpClient,
    private readonly dir: string,
    private readonly source: string,
    private readonly recordedAt: string,
  ) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const base = { method: req.method ?? 'GET', url, ...(req.body !== undefined ? { body: req.body } : {}) };
    try {
      const res = await this.inner.request(url, req);
      const contentType = res.headers.get('content-type') ?? '';
      const file = `${String(this.entries.length + 1).padStart(3, '0')}.${extFor(contentType)}`;
      writeFileSync(join(this.dir, file), res.text, 'utf8');
      this.entries.push({ ...base, file, status: res.status, finalUrl: res.url, fetchedAt: res.fetchedAt, contentType });
      return res;
    } catch (e) {
      const err = e as Error;
      const rec: ErrorEntry['error'] = { name: err.name, message: err.message };
      if (e instanceof ProtectedError) rec.kind = e.info.kind;
      if (e instanceof HttpError && e.status !== undefined) rec.status = e.status;
      this.entries.push({ ...base, error: rec });
      throw e;
    }
  }

  getText(url: string, req?: HttpRequest) {
    return this.request(url, req);
  }

  async getJson<T = unknown>(url: string, req?: HttpRequest) {
    return jsonFrom<T>(await this.request(url, req));
  }

  save(): FixtureIndex {
    const index: FixtureIndex = { source: this.source, recordedAt: this.recordedAt, entries: this.entries };
    writeFileSync(join(this.dir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
    return index;
  }
}

/** Воспроизведение записанных ответов. Запрос, которого нет в записи, — ошибка теста. */
export class ReplayHttp implements HttpClient {
  readonly index: FixtureIndex;
  private readonly used = new Set<number>();

  constructor(private readonly dir: string) {
    this.index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex;
  }

  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const method = req.method ?? 'GET';
    const i = this.index.entries.findIndex(
      (e, k) => !this.used.has(k) && e.method === method && e.url === url && (e.body ?? undefined) === req.body,
    );
    if (i < 0) throw new Error(`Фикстура: нет записанного ответа на ${method} ${url}${req.body ? ` [${req.body}]` : ''}`);
    this.used.add(i);
    const e = this.index.entries[i]!;
    if ('error' in e) {
      if (e.error.name === 'ProtectedError') throw new ProtectedError({ kind: e.error.kind!, evidence: e.error.message }, url);
      if (e.error.name === 'RobotsDisallowedError') throw new RobotsDisallowedError(url);
      throw new HttpError(e.error.message, url, e.error.status);
    }
    return {
      url: e.finalUrl,
      status: e.status,
      headers: new Headers({ 'content-type': e.contentType }),
      text: readFileSync(join(this.dir, e.file), 'utf8'),
      fetchedAt: e.fetchedAt,
    };
  }

  getText(url: string, req?: HttpRequest) {
    return this.request(url, req);
  }

  async getJson<T = unknown>(url: string, req?: HttpRequest) {
    return jsonFrom<T>(await this.request(url, req));
  }

  /** Все ли записанные ответы были запрошены (адаптер не перестал читать часть страниц). */
  unused(): string[] {
    return this.index.entries.filter((_, k) => !this.used.has(k)).map((e) => `${e.method} ${e.url}`);
  }
}
