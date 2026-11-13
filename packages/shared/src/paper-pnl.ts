import type { PaperExperimentDetail, VenuePnl } from './paper-experiment-contracts.js';

/**
 * Total profit and loss of a run per exchange: the exchange account's equity (balance plus the open
 * positions' unrealized PnL) against its start — the virtual starting balance in Paper, the real
 * balance when the run started in LIVE. Null values: not reported (no snapshot, or an older LIVE run
 * that did not record its start balance).
 */
export function venueTotalPnl(detail: Pick<PaperExperimentDetail, 'accounts' | 'tracks' | 'runtime' | 'live'>): VenuePnl[] {
  const runtime = detail.runtime;
  if (!runtime) return [];
  const live = Boolean(detail.live);
  return detail.accounts
    .filter((account) => !live || detail.tracks.some((track) => track.venue === account.venue))
    .map((account) => {
      const observed = runtime.accounts.find((entry) => entry.venue === account.venue && entry.accountId === account.accountId);
      if (!observed) return { venue: account.venue, total: null, percent: null, balance: null };
      const unrealized = observed.positions.reduce((sum, position) => sum + Number(position.unrealizedPnl ?? 0), 0);
      const equity = Number(observed.cashBalance) + unrealized;
      const balance = Number.isFinite(equity) ? equity : null;
      const start = live ? (observed.startBalance === undefined ? null : Number(observed.startBalance)) : account.startingCash;
      if (start === null || balance === null) return { venue: account.venue, total: null, percent: null, balance };
      const total = balance - start;
      return { venue: account.venue, total, percent: start ? total / start * 100 : null, balance };
    });
}
