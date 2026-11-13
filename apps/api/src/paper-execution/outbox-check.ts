import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { PaperExperimentDetail } from '../../../../packages/shared/src/paper-experiment-contracts.js';
import { nautilusOutboxCheckIsCurrent } from './nautilus-paper-ledger.js';
import type { OutboxCheckRequest, OutboxCheckResponse } from './outbox-check-worker.js';

/** Outboxes up to this size are checked inline (well under a second); larger ones in a worker process. */
export const INLINE_OUTBOX_BYTES = 2 * 1024 * 1024;
/** A failed check (for example, the child not yet proven gone) is tried again after this long. */
const RETRY_FAILED_MS = 60_000;
/** A check that runs longer is stopped; the run's page then shows what the journal holds. */
const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Runs the full outbox check of one ended run in its own Node process. */
export function runOutboxCheckWorker(detail: PaperExperimentDetail, directory: string,
  timeoutMs = CHECK_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const development = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(development ? './outbox-check-worker.ts' : './outbox-check-worker.js', import.meta.url);
    const child = fork(fileURLToPath(workerUrl), [], {
      execArgv: ['--max-old-space-size=1536', ...(development ? ['--import', 'tsx'] : [])],
      env: { NODE_ENV: 'production', TZ: 'UTC', PATH: process.env.PATH },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderr = '';
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => finish(() => {
      child.kill();
      reject(new Error(`The journal check took longer than ${Math.round(timeoutMs / 1000)} s.`));
    }), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() =>
      reject(new Error(`The journal check process exited (${code ?? signal}). ${stderr}`.trim()))));
    child.once('message', (response: OutboxCheckResponse) => finish(() => {
      if (response.ok) resolve(response.recovered);
      else reject(new Error(response.error));
    }));
    child.send({ detail, directory } satisfies OutboxCheckRequest);
  });
}

type Runner = (detail: PaperExperimentDetail, directory: string) => Promise<number>;

/**
 * Long outbox checks of ended runs, one at a time and off the engine's thread. `ready` resolves
 * true once reading the run needs only the cheap check, false when its check failed (the page
 * then shows the run without its journal, as before, instead of stalling the engine again).
 */
export class NautilusOutboxChecks {
  readonly #inlineBytes: number;
  readonly #run: Runner;
  readonly #log: (message: string, error?: unknown) => void;
  readonly #current = new Set<string>();
  readonly #pending = new Map<string, Promise<boolean>>();
  readonly #failedAt = new Map<string, number>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { inlineBytes?: number; run?: Runner; log?: (message: string, error?: unknown) => void } = {}) {
    this.#inlineBytes = options.inlineBytes ?? INLINE_OUTBOX_BYTES;
    this.#run = options.run ?? ((detail, directory) => runOutboxCheckWorker(detail, directory));
    this.#log = options.log ?? (() => undefined);
  }

  ready(detail: PaperExperimentDetail, directory: string): Promise<boolean> {
    if (detail.status !== 'completed' && detail.status !== 'interrupted') return Promise.resolve(true);
    const key = `${detail.id}:${detail.endedAt ?? ''}`;
    if (this.#current.has(key)) return Promise.resolve(true);
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const failedAt = this.#failedAt.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_FAILED_MS) return Promise.resolve(false);
    if (nautilusOutboxCheckIsCurrent(detail, directory, this.#inlineBytes)) {
      this.#current.add(key);
      return Promise.resolve(true);
    }
    const check = this.#queue.then(() => this.#run(detail, directory)).then((recovered) => {
      this.#current.add(key);
      this.#failedAt.delete(key);
      if (recovered) this.#log(`Run ${detail.id}: recovered ${recovered} journal events.`);
      return true;
    }, (error: unknown) => {
      this.#failedAt.set(key, Date.now());
      this.#log(`Run ${detail.id}: journal check failed.`, error);
      return false;
    }).finally(() => this.#pending.delete(key));
    this.#queue = check;
    this.#pending.set(key, check);
    return check;
  }

  /** Starts the check of an ended run now, so its page opens at once later. */
  prepare(detail: PaperExperimentDetail, directory: string): void {
    void this.ready(detail, directory);
  }

  /** A deleted run: forget it. */
  forget(id: string): void {
    for (const key of [...this.#current, ...this.#failedAt.keys()]) {
      if (key.startsWith(`${id}:`)) { this.#current.delete(key); this.#failedAt.delete(key); }
    }
  }
}
