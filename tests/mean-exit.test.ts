import { describe, expect, it } from 'vitest';
import { meanExitsOf } from '../apps/api/src/paper-execution/mean-exit';
import type { PaperExperimentDetail } from '../packages/shared/src/paper-experiment-contracts';

/** A running pair run with the positions its exchanges report. */
function run(params: Record<string, unknown>, accounts: { venue: string; positions: { market: string; openedAt?: string }[] }[]) {
  return {
    id: 'run-1', status: 'running', params,
    runtime: { stage: 'running', engine: 'nautilus', accounts: accounts.map((account) => ({ ...account, accountId: account.venue.toLowerCase(), cashBalance: '1000' })) },
  } as unknown as PaperExperimentDetail;
}

const pairParams = { pairs: 'CRWV/NBIS', mean_after_hours: 6, max_hold_hours: 8 };

describe('mean exit countdown', () => {
  it('counts the hours from the entry fill, as the strategy does on its run page', () => {
    // Run d1f2ce9e, 2026-11-18: ANTHROPIC/OPENAI opened 15:06:29, mean_after_hours 3. Its own panel
    // said "closes at its mean after 3 h: in 1 h 57 min" at 16:09:29, which is this moment minus now.
    const exits = meanExitsOf(run({ pairs: 'ANTHROPIC/OPENAI', mean_after_hours: 3 }, [
      { venue: 'Lighter', positions: [
        { market: 'ANTHROPIC', openedAt: '2026-11-18T15:06:29.679Z' },
        { market: 'OPENAI', openedAt: '2026-11-18T15:06:29.566Z' },
      ] },
    ]));
    expect(exits).toEqual([{ label: 'ANTHROPIC/OPENAI', at: '2026-11-18T18:06:29.566Z' }]);
    expect(Date.parse(exits[0]!.at) - Date.parse('2026-11-18T16:09:29.566Z')).toBe((1 * 60 + 57) * 60_000);
  });

  it('gives every open pair its own line, each exchange paired on its own, soonest first', () => {
    const exits = meanExitsOf(run({ pairs: 'CRWV/NBIS, xyz:CRWV/xyz:NBIS', mean_after_hours: 6 }, [
      { venue: 'Lighter', positions: [
        { market: 'CRWV', openedAt: '2026-11-18T14:30:12.749Z' },
        { market: 'NBIS', openedAt: '2026-11-18T14:30:12.445Z' },
      ] },
      { venue: 'Hyperliquid', positions: [
        { market: 'xyz:CRWV', openedAt: '2026-11-18T12:00:00.000Z' },
        { market: 'xyz:NBIS', openedAt: '2026-11-18T12:00:01.000Z' },
      ] },
    ]));
    expect(exits).toEqual([
      { label: 'xyz:CRWV/xyz:NBIS', at: '2026-11-18T18:00:00.000Z' },
      { label: 'CRWV/NBIS', at: '2026-11-18T20:30:12.445Z' },
    ]);
  });

  it('keeps a moment that has passed: the pair then closes at the first touch of its mean', () => {
    expect(meanExitsOf(run(pairParams, [{ venue: 'Lighter', positions: [
      { market: 'CRWV', openedAt: '2026-11-01T00:00:00.000Z' }, { market: 'NBIS', openedAt: '2026-11-01T00:00:00.000Z' },
    ] }]))).toEqual([{ label: 'CRWV/NBIS', at: '2026-11-01T06:00:00.000Z' }]);
  });

  it('says nothing without the rule, without positions, or without an open time', () => {
    const positions = [{ venue: 'Lighter', positions: [{ market: 'CRWV', openedAt: '2026-11-18T14:00:00.000Z' }] }];
    expect(meanExitsOf(run({ ...pairParams, mean_after_hours: 0 }, positions))).toEqual([]);
    expect(meanExitsOf(run({ pairs: 'CRWV/NBIS' }, positions))).toEqual([]);
    expect(meanExitsOf(run(pairParams, [{ venue: 'Lighter', positions: [] }]))).toEqual([]);
    expect(meanExitsOf(run(pairParams, [{ venue: 'Lighter', positions: [{ market: 'CRWV' }] }]))).toEqual([]);
    expect(meanExitsOf({ id: 'x', status: 'running' } as unknown as PaperExperimentDetail)).toEqual([]);
  });

  it('a market outside the pairs parameter waits on its own', () => {
    expect(meanExitsOf(run({ pairs: 'CRWV/NBIS', mean_after_hours: 6 }, [{ venue: 'Lighter', positions: [
      { market: 'CRWV', openedAt: '2026-11-18T14:00:00.000Z' },
      { market: 'HYPE', openedAt: '2026-11-18T15:00:00.000Z' },
    ] }]))).toEqual([
      { label: 'CRWV/NBIS', at: '2026-11-18T20:00:00.000Z' },
      { label: 'HYPE', at: '2026-11-18T21:00:00.000Z' },
    ]);
  });
});
