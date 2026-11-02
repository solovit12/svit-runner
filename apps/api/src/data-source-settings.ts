import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DataSourcesView, OxArchiveAccess } from '../../../packages/shared/src/hyperliquid-history.js';

const OXARCHIVE_FILE = 'oxarchive.json';
const OXARCHIVE_URL = 'https://api.0xarchive.io';
const DAY_MS = 86_400_000;
/** A key read from a file given by the server's environment, when the key cannot be typed in (servers, scripts). */
export const OXARCHIVE_KEY_FILE_ENV = 'OXARCHIVE_API_KEY_FILE';

const bilingualMessage = (english: string, russian: string) => `${english} / ${russian}`;

interface StoredOxArchive { apiKey: string; historyDays: number | null; checkedAt: string }

export class DataSourceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Keys of the history sources. They stay on this server (a folder only its user can read) and never go back to
 * the browser: the page sees whether a key is saved and how many days of history its plan includes.
 */
export class DataSourceSettingsStore {
  constructor(private readonly directory: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  #file(): string { return path.join(this.directory, OXARCHIVE_FILE); }

  #fromEnvironment(): StoredOxArchive | null {
    const file = this.environment[OXARCHIVE_KEY_FILE_ENV];
    if (!file) return null;
    try {
      const apiKey = readFileSync(file, 'utf8').trim();
      if (!apiKey) return null;
      const days = Number(this.environment.OXARCHIVE_HISTORY_DAYS ?? 30);
      return { apiKey, historyDays: Number.isSafeInteger(days) && days > 0 ? days : null, checkedAt: '' };
    } catch {
      return null;
    }
  }

  #stored(): StoredOxArchive | null {
    const environment = this.#fromEnvironment();
    if (environment) return environment;
    if (!existsSync(this.#file())) return null;
    try {
      const value = JSON.parse(readFileSync(this.#file(), 'utf8')) as Partial<StoredOxArchive>;
      if (typeof value.apiKey !== 'string' || !value.apiKey) return null;
      return {
        apiKey: value.apiKey,
        historyDays: typeof value.historyDays === 'number' ? value.historyDays : null,
        checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : '',
      };
    } catch {
      return null;
    }
  }

  oxarchiveKey(): string | null { return this.#stored()?.apiKey ?? null; }

  access(): OxArchiveAccess {
    const stored = this.#stored();
    return { configured: stored !== null, historyDays: stored?.historyDays ?? null };
  }

  view(): DataSourcesView {
    const stored = this.#stored();
    return {
      oxarchive: {
        configured: stored !== null,
        historyDays: stored?.historyDays ?? null,
        checkedAt: stored?.checkedAt || null,
        fromEnvironment: this.#fromEnvironment() !== null,
      },
    };
  }

  saveOxArchive(value: StoredOxArchive): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = this.#file();
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }

  removeOxArchive(): void {
    rmSync(this.#file(), { force: true });
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Checks a key with two small requests (two of the plan's monthly credits): a recent hour proves the key works,
 * an hour 400 days ago shows how far back the plan reaches (the free plan answers "the most recent 30 days").
 */
export async function checkOxArchiveKey(apiKey: string, fetcher: Fetcher = globalThis.fetch, now = Date.now()): Promise<{ historyDays: number | null }> {
  const ask = async (startMs: number) => {
    const url = new URL('/v1/hyperliquid/candles/BTC', OXARCHIVE_URL);
    url.searchParams.set('start', String(startMs));
    url.searchParams.set('end', String(startMs + 60 * 60_000));
    url.searchParams.set('interval', '1h');
    url.searchParams.set('limit', '2');
    let response: Response;
    try {
      response = await fetcher(url, { headers: { Accept: 'application/json', 'X-API-Key': apiKey }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DataSourceError(502, bilingualMessage('Could not reach 0xArchive. Try again later.', 'Не удалось связаться с 0xArchive. Попробуйте позже.'));
    }
    let text = '';
    try { text = await response.text(); } catch { /* no body */ }
    return { status: response.status, text };
  };
  const recent = await ask(now - 3 * 60 * 60_000);
  if (recent.status === 401 || recent.status === 403) {
    throw new DataSourceError(400, bilingualMessage('0xArchive did not accept this key. Copy it again from your 0xArchive account.', '0xArchive не принял этот ключ. Скопируйте его ещё раз в кабинете 0xArchive.'));
  }
  if (recent.status !== 200) {
    throw new DataSourceError(502, bilingualMessage(`0xArchive answered HTTP ${recent.status}. Try again later.`, `0xArchive ответил HTTP ${recent.status}. Попробуйте позже.`));
  }
  const old = await ask(now - 400 * DAY_MS);
  if (old.status === 200) return { historyDays: null };
  const days = /most recent (\d+) days/i.exec(old.text);
  return { historyDays: days ? Number(days[1]) : 30 };
}

const SaveOxArchiveSchema = z.object({ apiKey: z.string().trim().min(16).max(256).regex(/^[\x21-\x7e]+$/) });

export interface DataSourceRouteDependencies {
  store: DataSourceSettingsStore;
  fetcher?: Fetcher;
  now?: () => number;
}

export function registerDataSourceRoutes(app: FastifyInstance, dependencies: DataSourceRouteDependencies): void {
  const { store } = dependencies;
  const send = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof DataSourceError) return reply.code(error.status).send({ kind: 'DATA_SOURCE_SETTINGS', error: error.message });
    throw error;
  };

  app.get('/api/data-sources', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.view();
  });

  app.put('/api/data-sources/oxarchive', async (request, reply) => {
    try {
      // The key is never echoed back, not even in validation details.
      const parsed = SaveOxArchiveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new DataSourceError(400, bilingualMessage('Paste the API key from your 0xArchive account.', 'Вставьте API-ключ из кабинета 0xArchive.'));
      }
      if (store.view().oxarchive.fromEnvironment) {
        throw new DataSourceError(409, bilingualMessage('This server takes the 0xArchive key from its settings file; change it there.', 'Этот сервер берёт ключ 0xArchive из своего файла настроек; меняйте его там.'));
      }
      const { historyDays } = await checkOxArchiveKey(parsed.data.apiKey, dependencies.fetcher, (dependencies.now ?? Date.now)());
      store.saveOxArchive({ apiKey: parsed.data.apiKey, historyDays, checkedAt: new Date((dependencies.now ?? Date.now)()).toISOString() });
      return store.view();
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete('/api/data-sources/oxarchive', async (_request, reply) => {
    try {
      if (store.view().oxarchive.fromEnvironment) {
        throw new DataSourceError(409, bilingualMessage('This server takes the 0xArchive key from its settings file; remove it there.', 'Этот сервер берёт ключ 0xArchive из своего файла настроек; удаляйте его там.'));
      }
      store.removeOxArchive();
      return store.view();
    } catch (error) {
      return send(reply, error);
    }
  });
}
