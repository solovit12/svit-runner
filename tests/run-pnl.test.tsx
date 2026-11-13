import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PaperRunHistory } from '../apps/web/src/components/PaperRuns.js';
import { venueTotalPnl } from '../packages/shared/src/paper-pnl.js';
import type { PaperExperimentDetail, PaperExperimentSummary } from '../packages/shared/src/paper-experiment-contracts.js';

const account = (venue: 'Hyperliquid' | 'Lighter', cashBalance: string, extra: Record<string, unknown> = {}) => ({
  venue, accountId: `${venue}-1`, runId: 'r', cashBalance, brokerRevision: 0, publicFrames: 0, pendingOrders: 0,
  signals: 0, intents: 0, fills: 0, rejectedSignals: 0, positions: [], ...extra,
});
const accounts = [
  { venue: 'Hyperliquid' as const, accountId: 'Hyperliquid-1', runId: 'r', currency: 'USDC' as const, startingCash: 1000 },
  { venue: 'Lighter' as const, accountId: 'Lighter-1', runId: 'r', currency: 'USDC' as const, startingCash: 1000 },
];

describe('Total PnL per exchange (Runs list)', () => {
  it('Paper: equity against the virtual start; LIVE: against the real start, only the run\'s exchanges', () => {
    const tracks = [{ venue: 'Hyperliquid', market: 'SOL' }] as unknown as PaperExperimentDetail['tracks'];
    const runtime = { stage: 'running', fundingTreatment: 'excluded', observedAt: '', accounts: [
      account('Hyperliquid', '1010', { positions: [{ market: 'SOL', side: 'long', remainingBaseQuantity: '1', unrealizedPnl: '-2.5' }] }),
      account('Lighter', '990'),
    ] } as unknown as PaperExperimentDetail['runtime'];
    expect(venueTotalPnl({ accounts, tracks, runtime })).toEqual([
      { venue: 'Hyperliquid', total: 7.5, percent: 0.75, balance: 1007.5 },
      { venue: 'Lighter', total: -10, percent: -1, balance: 990 }]);
    const live = { stage: 'running', fundingTreatment: 'excluded', observedAt: '', accounts: [
      account('Hyperliquid', '100.45', { startBalance: '100.60' }), account('Lighter', '10000')] } as unknown as PaperExperimentDetail['runtime'];
    const [row, ...rest] = venueTotalPnl({ accounts, tracks, runtime: live, live: true });
    expect(rest).toEqual([]);
    expect(row!.venue).toBe('Hyperliquid');
    expect(row!.total).toBeCloseTo(-0.15, 6);
    expect(row!.balance).toBeCloseTo(100.45, 6);
    // an older LIVE run without a recorded start still shows its balance
    const [old] = venueTotalPnl({ accounts, tracks, runtime: { ...live!, accounts: [account('Hyperliquid', '55.5')] }, live: true });
    expect(old).toEqual({ venue: 'Hyperliquid', total: null, percent: null, balance: 55.5 });
    expect(venueTotalPnl({ accounts, tracks, runtime: undefined })).toEqual([]);
  });

  it('shows the current balance of every exchange of a LIVE run, and of a Paper run before its first snapshot', () => {
    const run = { id: 'r1', strategyId: 's', strategyVersion: 1, strategyName: 'Pairs', sourceSha256: 'x', status: 'running',
      reason: null, createdAt: '2026-11-13T16:15:00Z', startedAt: '2026-11-13T16:15:00Z', endedAt: null, trackCount: 8, live: true,
      venues: ['Hyperliquid', 'Lighter'], markets: ['XAU'], timeframe: '1m', capitalPerVenue: null,
      pnl: [{ venue: 'Hyperliquid', total: 1.5, percent: 0.49, balance: 308.5 },
        { venue: 'Lighter', total: null, percent: null, balance: 1234.5 }] } as PaperExperimentSummary;
    const html = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [run], onOpen: () => undefined }));
    expect(html).toContain('<div><span>Hyperliquid</span> 308.50 USDC</div><div><span>Lighter</span> 1,234.50 USDC</div>');
    expect(html).not.toContain('>real<');
    const paper = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [{ ...run, live: false, pnl: undefined,
      capitalPerVenue: 10_000 }], onOpen: () => undefined }));
    expect(paper).toContain('<div><span>Hyperliquid</span> 10,000.00 USDC</div><div><span>Lighter</span> 10,000.00 USDC</div>');
    const noSnapshot = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [{ ...run, pnl: undefined }], onOpen: () => undefined }));
    expect(noSnapshot).toContain('<td class="paper-history-pnl">—</td>');
  });

  it('shows the totals of every exchange of a run after its status', () => {
    const run = { id: 'r1', strategyId: 's', strategyVersion: 1, strategyName: 'Breakouts', sourceSha256: 'x', status: 'running',
      reason: null, createdAt: '2026-10-20T16:15:00Z', startedAt: '2026-10-20T16:15:00Z', endedAt: null, trackCount: 30, live: true,
      venues: ['Hyperliquid', 'Lighter'], markets: ['SOL'], timeframe: '1h',
      pnl: [{ venue: 'Hyperliquid', total: 0.12, percent: 0.12 }, { venue: 'Lighter', total: -0.05, percent: -0.05 }] } as PaperExperimentSummary;
    const html = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [run], onOpen: () => undefined }));
    expect(html).toContain('Total PnL');
    expect(html).toMatch(/Hyperliquid<\/span> <b[^>]*>\+0\.12 \(\+0\.12%\)/);
    expect(html).toMatch(/Lighter<\/span> <b[^>]*>−0\.05 \(−0\.05%\)/); // a true minus sign
  });
});
