import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

import {
  type PaperExperimentActivity,
  type PaperExperimentActivityEvent,
  type PaperExperimentDetail,
  type PaperExperimentTrades,
  type PaperRunTradeStats,
} from '../../../../packages/shared/src/paper-experiment-contracts.js';
import {
  NautilusPaperLedgerQueryError, readNautilusPaperActivity, readNautilusPaperTradeStats, readNautilusPaperTrades,
} from './nautilus-paper-ledger.js';

const MAX_PAGE_SIZE = 100;

export class PaperExperimentActivityQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperExperimentActivityQueryError'; }
}

function controlEvents(detail: PaperExperimentDetail): PaperExperimentActivityEvent[] {
  const events: PaperExperimentActivityEvent[] = [
    { id: 'control:created', at: detail.createdAt, kind: 'created', message: 'Paper experiment created.' },
  ];
  if (detail.startedAt) events.push({ id: 'control:started', at: detail.startedAt,
    kind: 'started', message: 'Paper execution started.' });
  if (detail.endedAt) {
    events.push({ id: 'control:ended', at: detail.endedAt, kind: 'stopped',
      message: detail.status === 'completed' ? 'Paper experiment completed.' : 'Paper experiment interrupted.' });
  } else if (detail.status === 'stopping') {
    const at = detail.tracks.map((track) => track.updatedAt).sort().at(-1) ?? detail.createdAt;
    events.push({ id: 'control:stopping', at, kind: 'status', message: 'Paper execution is stopping.' });
  }
  return events.sort((left, right) => (right.at ?? '').localeCompare(left.at ?? '') || right.id.localeCompare(left.id));
}

function controlOnly(detail: PaperExperimentDetail, coverage: 'control_only' | 'partial'): PaperExperimentActivity {
  return { events: controlEvents(detail), eventCoverage: 'key_milestones',
    fills: [], totalFills: null, nextFillsCursor: null, coverage };
}

/**
 * Persisted control facts plus the run's Nautilus ledger. Runs of the retired
 * TypeScript Broker (September 2026) keep their files but show control
 * milestones only; their journal format is no longer read.
 */
export function readPaperExperimentActivityV1(input: {
  readonly detail: PaperExperimentDetail;
  readonly runtimeDirectory: string | null;
  readonly limit?: number;
  readonly fillsCursor?: string;
}): PaperExperimentActivity {
  const { detail } = input;
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PaperExperimentActivityQueryError('Fill page size must be between 1 and 100.');
  }
  if (!input.runtimeDirectory) return controlOnly(detail, 'control_only');
  const directory = path.join(path.resolve(input.runtimeDirectory), detail.id);
  if (!existsSync(directory)) return controlOnly(detail, 'control_only');
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return controlOnly(detail, 'partial');
  if (!existsSync(path.join(directory, 'nautilus.sqlite'))) return controlOnly(detail, 'control_only');
  try {
    return readNautilusPaperActivity(detail, directory, limit, input.fillsCursor);
  } catch (error) {
    if (error instanceof NautilusPaperLedgerQueryError) throw new PaperExperimentActivityQueryError(error.message);
    return controlOnly(detail, 'partial');
  }
}

/** Closed positions of a run for the runs list; null without a readable fill journal (nothing invented). */
export function readPaperExperimentTradeStatsV1(input: {
  readonly detail: PaperExperimentDetail;
  readonly runtimeDirectory: string | null;
}): PaperRunTradeStats | null {
  if (!input.runtimeDirectory) return null;
  const directory = path.join(path.resolve(input.runtimeDirectory), input.detail.id);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return null;
  if (!existsSync(path.join(directory, 'nautilus.sqlite'))) return null;
  try {
    return readNautilusPaperTradeStats(input.detail, directory);
  } catch {
    return null;
  }
}

/** The run's fills grouped by position and by the legs opened together (pairs); nothing invented on error. */
export function readPaperExperimentTradesV1(input: {
  readonly detail: PaperExperimentDetail;
  readonly runtimeDirectory: string | null;
}): PaperExperimentTrades {
  const empty = (coverage: PaperExperimentTrades['coverage']): PaperExperimentTrades => ({ groups: [], truncated: false, coverage });
  if (!input.runtimeDirectory) return empty('control_only');
  const directory = path.join(path.resolve(input.runtimeDirectory), input.detail.id);
  if (!existsSync(directory)) return empty('control_only');
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return empty('partial');
  if (!existsSync(path.join(directory, 'nautilus.sqlite'))) return empty('control_only');
  try {
    return readNautilusPaperTrades(input.detail, directory);
  } catch {
    return empty('partial');
  }
}
