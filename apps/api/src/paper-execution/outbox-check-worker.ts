/**
 * Checks one ended run's child outbox against its journal in a process of its own: on a long
 * run this reads tens of megabytes and used to stall the whole engine (other runs and every
 * page) for 10-130 s. The result is saved next to the journal, so the engine then reads it
 * with a cheap check.
 */
import type { PaperExperimentDetail } from '../../../../packages/shared/src/paper-experiment-contracts.js';
import { reconcileNautilusPaperOutbox } from './nautilus-paper-ledger.js';

export interface OutboxCheckRequest {
  readonly detail: PaperExperimentDetail;
  readonly directory: string;
}

export type OutboxCheckResponse =
  | { readonly ok: true; readonly recovered: number }
  | { readonly ok: false; readonly error: string };

process.once('message', (request: OutboxCheckRequest) => {
  let response: OutboxCheckResponse;
  try {
    response = { ok: true, recovered: reconcileNautilusPaperOutbox(request.detail, request.directory).recovered };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.send?.(response, () => process.disconnect?.());
});
