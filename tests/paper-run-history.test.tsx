import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canClosePositions, ClosePositionsDialog, entriesHeld, openPositionCount, RunPageActions, PaperPositionsTable, PaperRunActivity, PaperRunDataGaps, PaperRunHealth, PaperRunRules, PaperRunHistory, PaperRunTrackTable, PaperRuns, StopRunDialog, DeleteRunDialog, runListOrder } from '../apps/web/src/components/PaperRuns';
import type { PaperExperimentActivity, PaperExperimentSummary, PaperExperimentDetail } from '../packages/shared/src/paper-experiment-contracts';

const sample: PaperExperimentSummary = {
  id: 'run-1', strategyId: 'strategy-1', strategyName: 'Range Levels', strategyVersion: 2,
  sourceSha256: 'a'.repeat(64), status: 'stopping',
  reason: 'Paper runtime stop failed: hyperliquid input ACK: Same-millisecond market event',
  createdAt: '2026-09-29T07:59:00.000Z', startedAt: '2026-09-29T08:00:00.000Z',
  endedAt: '2026-09-29T09:15:00.000Z', trackCount: 2,
  venues: ['Hyperliquid', 'Lighter'], markets: ['HYPE'], timeframe: '1h',
  capitalPerVenue: 5_000,
};

afterEach(() => vi.unstubAllGlobals());

describe('Paper run history', () => {
  it('shows a data gap as a running run state, not as an alarm', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, status: 'recovering', reason: null, endedAt: null }], onOpen: () => undefined,
    }));
    expect(html).toContain('<strong>Running · data gap</strong>');
    expect(html).not.toContain('Interrupted');
  });

  it('gives every run a real link, so it can be opened in a separate browser tab', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [sample, { ...sample, id: 'run 2', live: true }], onOpen: () => undefined,
    }));
    expect(html).toContain('href="/runs/run-1"');
    expect(html).toContain('href="/runs/run%202"');
    expect(html).toContain('opens it in a new browser tab');
  });

  it('shows how long each open pair may still be held before it closes at its mean', () => {
    const inHours = (ms: number) => new Date(Date.now() + ms).toISOString();
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, status: 'running', endedAt: null, meanExits: [
        { label: 'CRWV/NBIS', at: inHours(2 * 3_600_000 + 14 * 60_000 + 2_000) },
        { label: 'xyz:CRWV/xyz:NBIS', at: inHours(-60_000) },
      ] }],
      onOpen: () => undefined,
    }));
    expect(html).toContain('Mean exit in');
    expect(html).toContain('<span>CRWV/NBIS</span> 2h 14m');
    expect(html).toContain('<span>xyz:CRWV/xyz:NBIS</span> waiting for the mean');
  });

  it('leaves the mean exit column empty for a run with nothing open', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [sample], onOpen: () => undefined }));
    expect(html).toContain('<td class="paper-history-countdown">\u2014</td>');
  });

  it('lists only the markets without fresh data and tags their open positions', () => {
    const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
    const detail = {
      status: 'running',
      accounts: [{ venue: 'Lighter', accountId: 'lighter', startingCash: 1000 }],
      runtime: { stage: 'running', engine: 'nautilus',
        accounts: [{ venue: 'Lighter', accountId: 'lighter', cashBalance: '1000', positions: [
          { market: 'QQQ', side: 'long', quantity: '1', avgEntryPrice: '500', markPrice: '501', unrealizedPnl: '1' },
          { market: 'BTC', side: 'short', quantity: '0.01', avgEntryPrice: '60000', markPrice: '60000', unrealizedPnl: '0' },
        ] }],
        tracks: [
          { venue: 'Lighter', market: 'QQQ', priceReady: false, pendingOrders: 0,
            dataGap: { sinceMs: nowMs - 12 * 60_000, connected: true, resubscribes: 2 } },
          { venue: 'Lighter', market: 'BTC', priceReady: true, pendingOrders: 0 },
        ] },
    } as unknown as PaperExperimentDetail;
    const notice = renderToStaticMarkup(createElement(PaperRunDataGaps, { detail, nowMs }));
    expect(notice).toContain('No fresh market data · 1 market');
    expect(notice).toContain('<b>Lighter QQQ</b> — 12 min without data · connection restored; order book requested again 2 times · open position: its exits wait for data');
    expect(notice).not.toContain('BTC');
    const table = renderToStaticMarkup(createElement(PaperPositionsTable, { detail }));
    expect(table.match(/paper-gap-tag/g)).toHaveLength(1);
    expect(table.split('paper-gap-tag')[0]).toContain('QQQ');
    expect(renderToStaticMarkup(createElement(PaperRunDataGaps, { detail: { ...detail, status: 'completed' }, nowMs }))).toBe('');
  });

  it('shows individual readiness on a shared account and never copies its ready flag across missing market rows', () => {
    const detail = {
      tracks: ['HYPE', 'SOL'].map((market, index) => ({ venue: 'Lighter', market, trackId: market,
        accountId: 'shared-lighter', runId: 'same-run', status: 'running', updatedAt: sample.createdAt,
        events: index + 11, signals: index + 21, intents: index + 31, fills: index + 41 })),
      runtime: { stage: 'running', engine: 'nautilus', accounts: [{ venue: 'Lighter', accountId: 'shared-lighter',
        runId: 'same-run', priceReady: true, pendingOrders: 99 }], tracks: [
        { venue: 'Lighter', market: 'HYPE', priceReady: true, pendingOrders: 0 },
        { venue: 'Lighter', market: 'SOL', priceReady: false, pendingOrders: 1 },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperRunTrackTable, { detail }));
    const rows = html.split('<tbody>')[1]!.split('</tbody>')[0]!.split('</tr>');
    expect(rows[0]).toContain('<td>HYPE</td>');
    expect(rows[0]).toContain('<td>Ready</td><td>0</td>');
    expect(rows[1]).toContain('<td>SOL</td>');
    expect(rows[1]).toContain('<td>Waiting for fresh price</td><td>1</td>');
    expect(html).not.toContain('<td>99</td>');
    const missing = renderToStaticMarkup(createElement(PaperRunTrackTable, { detail: {
      ...detail, runtime: { ...detail.runtime!, tracks: undefined },
    } }));
    expect(missing.match(/Not reported/g)).toHaveLength(2);
    expect(missing).not.toContain('<td>Ready</td>');
  });

  it('shows launch characteristics and a short status instead of the technical stop reason', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [sample], onOpen: () => undefined,
    }));

    expect(html).toContain('Hyperliquid, Lighter');
    expect(html).toContain('HYPE');
    expect(html).toContain('1h');
    expect(html).toContain('<div><span>Hyperliquid</span> 5,000.00 USDC</div><div><span>Lighter</span> 5,000.00 USDC</div>');
    expect(html).toContain('1h 15m');
    expect(html).toContain('Stop needs attention');
    expect(html).not.toContain('Same-millisecond market event');
    expect(html).not.toContain('Paper runtime stop failed');
  });

  it('shows the results, then the strategy parameters, and a Stop button for active runs only', () => {
    const params = { pairs: 'BRENTOIL/WTI, XAU/XAG', ema_minutes: 30, windows: 'cme_closed' };
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, id: 'run-a', status: 'running', reason: null, endedAt: null, params },
        { ...sample, id: 'run-b', status: 'completed', reason: null }],
      onOpen: () => undefined, onStop: () => undefined,
    }));
    const headers = [...html.matchAll(/<th>([A-Za-z /]+)/g)].map((match) => match[1]!.trim());
    expect(headers.slice(0, 9)).toEqual(['Strategy', 'Status', 'Total PnL', 'Mean exit in', 'Closed positions', 'Win rate',
      'Profit factor', 'Strategy parameters', 'Venues']);
    expect(headers.at(-1)).toBe('Actions');
    expect(html).toContain('<span>pairs = BRENTOIL/WTI, XAU/XAG</span><span>ema_minutes = 30</span><span>windows = cme_closed</span>');
    const [first, second] = html.split('<tbody>')[1]!.split('</tr>');
    expect(first).toContain('aria-label="Stop run run-a of Range Levels"');
    expect(first).toContain('>Stop</button>');
    expect(second).not.toContain('<button');
    expect(second).toContain('<td class="paper-history-params-cell">—</td>');
  });

  it('lists running LIVE runs first, then running Paper runs (newest start first), then the rest as the server lists them', () => {
    const run = (id: string, status: PaperExperimentSummary['status'], startedAt: string, live = false): PaperExperimentSummary =>
      ({ ...sample, id, status, startedAt, live, endedAt: status === 'interrupted' ? '2026-11-13T09:00:00.000Z' : null });
    const server = [   // newest launch first, as the server sends them
      run('paper-new', 'running', '2026-11-13T08:00:00.000Z'),
      run('done-live', 'interrupted', '2026-11-13T07:00:00.000Z', true),
      run('live-old', 'running', '2026-11-12T06:00:00.000Z', true),
      run('done-paper', 'interrupted', '2026-11-12T05:00:00.000Z'),
      run('live-new', 'warming_up', '2026-11-13T04:00:00.000Z', true),
      run('paper-old', 'stopping', '2026-11-11T03:00:00.000Z'),
    ];
    expect(runListOrder(server).map((item) => item.id))
      .toEqual(['live-new', 'live-old', 'paper-new', 'paper-old', 'done-live', 'done-paper']);
    const html = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: server, onOpen: () => undefined }));
    const rows = html.split('<tbody>')[1]!.split('</tr>');
    expect(rows[0]).toContain('class="paper-history-row paper-history-row-live"');
    expect(rows[0]).toContain('aria-label="Open LIVE run of Range Levels"');
    expect(rows[2]).toContain('class="paper-history-row"');
    expect(rows[4]).toContain('class="paper-history-row paper-history-row-live-ended"');   // a finished LIVE run: amber
  });

  it('shows closed positions, win rate and profit factor of each run', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [
        { ...sample, id: 'mixed', trades: { closed: 8, wins: 5, grossProfit: 12.5, grossLoss: 5, partial: false } },
        { ...sample, id: 'no-loss', trades: { closed: 2, wins: 2, grossProfit: 3, grossLoss: 0, partial: false } },
        { ...sample, id: 'long', trades: { closed: 4, wins: 1, grossProfit: 1, grossLoss: 4, partial: true } },
        { ...sample, id: 'none', trades: { closed: 0, wins: 0, grossProfit: 0, grossLoss: 0, partial: false } },
        { ...sample, id: 'no-journal' }],
      onOpen: () => undefined,
    }));
    const cells = (row: string) => [...row.matchAll(/<td class="paper-history-number"><span[^>]*>([^<]*)<\/span><\/td>/g)].map((match) => match[1]);
    const rows = html.split('<tbody>')[1]!.split('</tr>');
    expect(cells(rows[0]!)).toEqual(['8', '62.5%', '2.50']);
    expect(cells(rows[1]!)).toEqual(['2', '100.0%', '∞']);
    expect(cells(rows[2]!)).toEqual(['≈4', '≈25.0%', '≈0.25']);
    expect(rows[2]).toContain('title="The oldest fills of a very long run');
    expect(cells(rows[3]!)).toEqual(['0', '—', '—']);
    expect(cells(rows[4]!)).toEqual(['—', '—', '—']);
  });

  it('collapses the columns chosen in this browser, never Actions, and offers to show them all again', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(['pnl', 'params', 'unknown']), setItem: () => undefined });
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, params: { pairs: 'BRENTOIL/WTI' },
        pnl: [{ venue: 'Lighter', total: 12.34, percent: 1.2 }] }],
      onOpen: () => undefined, onDuplicate: () => undefined,
    }));
    expect(html).toContain('aria-label="Show column Total PnL"');
    expect(html).toContain('aria-label="Show column Strategy parameters"');
    expect(html).toContain('aria-label="Hide column Status"');
    expect(html).not.toContain('Hide column Actions');
    expect(html).not.toContain('+12.34');
    expect(html).not.toContain('pairs = BRENTOIL/WTI');
    expect(html).toContain('Show all columns (2 hidden)');
    expect(html.match(/<td class="paper-col-collapsed" aria-hidden="true"><\/td>/g)).toHaveLength(2);
    expect(html).toContain('>Run Duplicate</button>');
    vi.unstubAllGlobals();
    const open = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [sample], onOpen: () => undefined }));
    expect(open).not.toContain('paper-col-collapsed');
    expect(open).not.toContain('Show all columns');
  });

  it('asks "are you sure" before a stop and says what a LIVE stop does', () => {
    const run = { id: 'run-a', strategyName: 'Pair reversion', live: false, exchanges: 'Lighter and Hyperliquid' };
    const paper = renderToStaticMarkup(createElement(StopRunDialog, { run, busy: false, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(paper).toContain('Stop this run?');
    expect(paper).toContain('Are you sure you want to stop <strong>Pair reversion</strong>?');
    expect(paper).toContain('Run run-a');
    expect(paper).toContain('>Cancel</button>');
    expect(paper).toContain('>Yes, stop</button>');
    const live = renderToStaticMarkup(createElement(StopRunDialog, { run: { ...run, live: true }, busy: true, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(live).toContain('Stop this LIVE run?');
    expect(live).toContain('closed at market on Lighter and Hyperliquid');
    expect(live).toContain('Stopping…');
  });

  it('asks "are you sure" before closing positions and promises the run keeps trading', () => {
    const run = { id: 'run-a', strategyName: 'Pair reversion', live: true, exchanges: 'Lighter' };
    const html = renderToStaticMarkup(createElement(ClosePositionsDialog, {
      run, positions: 2, busy: false, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(html).toContain('Close every position now?');
    expect(html).toContain('holds 2 open positions');
    expect(html).toContain('on Lighter');
    expect(html).toContain('closed at market on the exchange right away');
    expect(html).toContain('is <strong>not</strong> stopped');
    expect(html).toContain('>Yes, close positions</button>');
    const empty = renderToStaticMarkup(createElement(ClosePositionsDialog, {
      run: { ...run, live: false }, positions: 0, busy: true, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(empty).toContain('No position is open right now');
    expect(empty).toContain('Closing…');
  });

  it('puts Close positions beside Stop on the run page, and only where it works', () => {
    const detail = { id: 'run-1', strategyName: 'Pair reversion Live', status: 'running',
      accountModel: 'python_live_v1', live: { maxLeverage: 20 } } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(RunPageActions, {
      detail, closeBusyId: null, stopBusyId: null, onClose: () => undefined, onStop: () => undefined }));
    expect(html).toContain('aria-label="Close the open positions of run run-1"');
    expect(html).not.toContain('Close and hold');     // no hold handler: no hold button
    expect(html).toContain('>Close positions</button>');
    expect(html).toContain('>Stop and close all</button>');
    expect(html.indexOf('Close positions')).toBeLessThan(html.indexOf('Stop and close all'));
    // While one is running neither can be pressed again.
    const busy = renderToStaticMarkup(createElement(RunPageActions, {
      detail, closeBusyId: 'run-1', stopBusyId: null, onClose: () => undefined, onStop: () => undefined }));
    expect(busy).toContain('>Closing…</button>');
    expect(busy).toContain('disabled=""');
    // A Pine run keeps Stop alone.
    const pine = renderToStaticMarkup(createElement(RunPageActions, {
      detail: { ...detail, accountModel: 'pine_live_v1' } as PaperExperimentDetail,
      closeBusyId: null, stopBusyId: null, onClose: () => undefined, onStop: () => undefined }));
    expect(pine).not.toContain('Close positions');
    expect(pine).toContain('>Stop and close all</button>');
    // A finished run has neither.
    const done = renderToStaticMarkup(createElement(RunPageActions, {
      detail: { ...detail, status: 'interrupted' } as PaperExperimentDetail,
      closeBusyId: null, stopBusyId: null, onClose: () => undefined, onStop: () => undefined }));
    expect(done).toBe('');
  });

  it('offers Close and hold, then only Resume entries while the hold is on', () => {
    const detail = { id: 'run-1', strategyName: 'Pair reversion Live', status: 'running',
      accountModel: 'python_live_v1', live: { maxLeverage: 20 } } as unknown as PaperExperimentDetail;
    const props = { closeBusyId: null, stopBusyId: null, holdBusyId: null, onClose: () => undefined,
      onCloseAndHold: () => undefined, onResume: () => undefined, onStop: () => undefined };
    const open = renderToStaticMarkup(createElement(RunPageActions, { ...props, detail }));
    expect(open).toContain('>Close positions</button>');
    expect(open).toContain('>Close and hold</button>');
    expect(open).not.toContain('Resume entries');
    const onHold = { ...detail, runtime: { entriesHeld: true } } as unknown as PaperExperimentDetail;
    const held = renderToStaticMarkup(createElement(RunPageActions, { ...props, detail: onHold }));
    expect(held).toContain('>Resume entries</button>');
    expect(held).toContain('aria-label="Allow new entries of run run-1 again"');
    expect(held).not.toContain('>Close positions</button>');   // nothing can be open while held
    expect(held).toContain('>Stop and close all</button>');    // Stop is always there
    expect(entriesHeld(onHold)).toBe(true);
    expect(entriesHeld(detail)).toBe(false);
    // The hold dialog says plainly that nothing new opens until Resume.
    const dialog = renderToStaticMarkup(createElement(ClosePositionsDialog, {
      run: { id: 'run-1', strategyName: 'Pair reversion Live', live: true, exchanges: 'Lighter' },
      positions: 1, busy: false, hold: true, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(dialog).toContain('Close everything and hold new entries?');
    expect(dialog).toContain('<strong>nothing new</strong>');
    expect(dialog).toContain('<strong>Resume entries</strong>');
    expect(dialog).toContain('>Yes, close and hold</button>');
  });

  it('offers Close positions only for a running Python strategy, and counts what is open', () => {
    const python = { status: 'running', accountModel: 'python_live_v1' } as const;
    expect(canClosePositions(python)).toBe(true);
    expect(canClosePositions({ ...python, status: 'stopping' })).toBe(false);
    expect(canClosePositions({ ...python, status: 'interrupted' })).toBe(false);
    // Pine keeps its own trade list: a close behind its back would be opened again.
    expect(canClosePositions({ status: 'running', accountModel: 'pine_live_v1' })).toBe(false);
    expect(canClosePositions({ status: 'running', accountModel: 'venue_shared_v2' })).toBe(false);
    expect(openPositionCount({ runtime: undefined })).toBe(0);
    expect(openPositionCount({ runtime: { accounts: [
      { positions: [{ market: 'BRENTOIL' }, { market: 'WTI' }] }, { positions: [] },
    ] } } as never)).toBe(2);
  });

  it('offers Run Duplicate for active and finished runs alike', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, id: 'done', status: 'interrupted' }, { ...sample, id: 'going', status: 'running', endedAt: null }],
      onOpen: () => undefined, onStop: () => undefined, onDelete: () => undefined, onDuplicate: () => undefined, duplicateBusyId: 'going',
    }));
    expect(html).toContain('aria-label="Run a duplicate of run done of Range Levels"');
    expect(html).toContain('aria-label="Run a duplicate of run going of Range Levels"');
    expect(html).toContain('>Run Duplicate</button>');
    expect(html).toContain('>Opening…</button>');
    const none = renderToStaticMarkup(createElement(PaperRunHistory, { experiments: [sample], onOpen: () => undefined }));
    expect(none).not.toContain('Run Duplicate');
  });

  it('offers Delete only for finished runs and asks "are you sure" first', () => {
    const html = renderToStaticMarkup(createElement(PaperRunHistory, {
      experiments: [{ ...sample, id: 'done', status: 'interrupted' }, { ...sample, id: 'going', status: 'running', endedAt: null }],
      onOpen: () => undefined, onStop: () => undefined, onDelete: () => undefined,
    }));
    expect(html).toContain('aria-label="Delete run done of Range Levels"');
    expect(html).not.toContain('aria-label="Delete run going');
    expect(html).toContain('aria-label="Stop run going of Range Levels"');
    const run = { id: 'run-a', strategyName: 'Pair reversion', live: true, exchanges: 'Lighter' };
    const dialog = renderToStaticMarkup(createElement(DeleteRunDialog, { run, busy: false, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(dialog).toContain('Delete this LIVE run?');
    expect(dialog).toContain('Are you sure you want to delete <strong>Pair reversion</strong>?');
    expect(dialog).toContain('This cannot be undone.');
    expect(dialog).toContain('The real trades stay in your Lighter account history');
    expect(dialog).toContain('>Yes, delete</button>');
  });

  it('does not put the history table on a specific run page', () => {
    vi.stubGlobal('window', { location: { pathname: '/paper/run-1' } });
    const html = renderToStaticMarkup(createElement(PaperRuns, { onPrepare: () => undefined }));

    expect(html).toContain('All runs');
    expect(html).not.toContain('Server experiments');
  });
});

describe('Paper run activity', () => {
  const activity: PaperExperimentActivity = {
    eventCoverage: 'key_milestones', coverage: 'durable_journal', totalFills: 2, nextFillsCursor: null,
    events: [
      { id: 'event-2', at: '2026-09-29T08:00:00.000Z', kind: 'status', venue: 'Lighter', market: 'HYPE', message: 'Paper was interrupted.' },
      { id: 'event-1', at: '2026-09-29T07:00:00.000Z', kind: 'started', message: 'Paper started.' },
    ],
    fills: [
      { id: 'fill-2', at: '2026-09-29T07:59:00.000Z', venue: 'Lighter', market: 'HYPE', kind: 'exit', side: 'sell', positionSide: 'long', quantity: '2', quote: '100', price: '50', fee: '0', realizedPnl: '1.23' },
      { id: 'fill-1', at: null, venue: 'Hyperliquid', market: 'HYPE', kind: 'entry', side: 'buy', positionSide: 'long', quantity: '2', quote: '99', price: null, fee: null, realizedPnl: null },
    ],
  };

  it('shows supplied realized PnL and leaves missing fill values unknown', () => {
    const html = renderToStaticMarkup(createElement(PaperRunActivity, {
      activity, loading: false, refreshFailed: false, pageIndex: 0,
      onPrevious: () => undefined, onNext: () => undefined,
    }));

    expect(html).toContain('Paper was interrupted.');
    expect(html).toContain('Paper started.');
    expect(html).toContain('2 committed virtual fills');
    expect(html).toContain('Hyperliquid');
    expect(html).toContain('Lighter');
    expect(html).toContain('99 USDC');
    expect(html).toContain('Realized PnL</th>');
    expect(html).toContain('1.23 USDC');
    expect(html).toContain('Realized PnL is shown only when the execution engine supplies it');
    expect(html).toContain('Реализованный PnL показан только там, где движок передал его');
    expect(html).not.toContain('null USDC');
  });

  it('marks incomplete journal coverage and offers access to the next fill page', () => {
    const html = renderToStaticMarkup(createElement(PaperRunActivity, {
      activity: { ...activity, coverage: 'partial', totalFills: null, nextFillsCursor: 'opaque-next' },
      loading: false, refreshFailed: false, pageIndex: 0,
      onPrevious: () => undefined, onNext: () => undefined,
    }));

    expect(html).toContain('Some journal history is unavailable');
    expect(html).toContain('Next');
    expect(html).not.toContain('2 committed virtual fills');
  });

  it('shows only the latest five events until expanded', () => {
    const many = { ...activity, events: Array.from({ length: 8 }, (_, index) => ({
      id: `e${index}`, at: '2026-09-29T08:00:00.000Z', kind: 'status', message: `event number ${index}` })) } as unknown as PaperExperimentActivity;
    const props = { activity: many, loading: false, refreshFailed: false, pageIndex: 0, onPrevious: () => undefined, onNext: () => undefined };
    const collapsed = renderToStaticMarkup(createElement(PaperRunActivity, props));
    expect(collapsed).toContain('event number 4');
    expect(collapsed).not.toContain('event number 5');
    expect(collapsed).toContain('Show all 8 events');
    const expanded = renderToStaticMarkup(createElement(PaperRunActivity, { ...props, initiallyExpanded: true }));
    expect(expanded).toContain('event number 7');
    expect(expanded).toContain('Show the latest 5 only');
  });

  it('lists open positions by exchange with side colour, UPNL, leverage and exchange PnL', () => {
    const detail = {
      accounts: [
        { venue: 'Lighter', accountId: 'acc-l', runId: 'r', startingCash: 10_000, currency: 'USDC' },
        { venue: 'Hyperliquid', accountId: 'acc-h', runId: 'r', startingCash: 10_000, currency: 'USDC' },
      ],
      runtime: { stage: 'running', engine: 'nautilus', observedAt: '2026-10-07T10:00:00.000Z', fundingTreatment: 'excluded', accounts: [
        { venue: 'Lighter', accountId: 'acc-l', runId: 'r', cashBalance: '10012.5', positions: [
          { market: 'HYPE', side: 'long', remainingBaseQuantity: '10', avgEntryPrice: '89.04', markPrice: '90', unrealizedPnl: '9.6', openedAt: '2026-10-07T09:50:00.000Z' },
          { market: 'SOL', side: 'short', remainingBaseQuantity: '2', avgEntryPrice: '118.25', markPrice: '119', unrealizedPnl: '-1.5' },
        ] },
        { venue: 'Hyperliquid', accountId: 'acc-h', runId: 'r', cashBalance: '9990', positions: [] },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperPositionsTable, { detail }));
    expect(html).toContain('<strong class="paper-side-long" title="Long">HYPE</strong>');
    expect(html).toContain('<strong class="paper-side-short" title="Short">SOL</strong>');
    expect(html).toContain('+9.60 USDC');
    expect(html).toContain('−1.50 USDC');
    expect(html).toContain('0.09x'); // 10 × 90 / (10012.5 + 8.1)
    expect(html).toContain('Total PnL <b class="paper-pnl-up">+20.60 (+0.21%)</b>');
    expect(html).toContain('Total PnL <b class="paper-pnl-down">−10.00 (−0.10%)</b>');
    // The exchange is named once, in its summary row above.
    expect(html).toContain('<tr><td colSpan="8" class="paper-positions-none">No open positions</td></tr>');
    expect(html).not.toContain('Diff');
  });

  it('shows a Live run its realized and total PnL from the real start balance', () => {
    const detail = (startBalance?: string) => ({
      live: true, tracks: [{ venue: 'Lighter', market: 'XRP' }],
      accounts: [{ venue: 'Lighter', accountId: 'acc-l', runId: 'r', startingCash: 10_000, currency: 'USDC' }],
      runtime: { stage: 'running', engine: 'nautilus', observedAt: '2026-10-18T10:00:00.000Z', fundingTreatment: 'excluded', accounts: [
        { venue: 'Lighter', accountId: 'acc-l', runId: 'r', cashBalance: '100.78', ...(startBalance ? { startBalance } : {}), positions: [
          { market: 'XRP', side: 'short', remainingBaseQuantity: '11', avgEntryPrice: '1.302', markPrice: '1.2987', unrealizedPnl: '0.04' },
        ] },
      ] },
    }) as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperPositionsTable, { detail: detail('100.10') }));
    expect(html).toContain('Realized <b class="paper-pnl-up">+0.68</b>');
    expect(html).toContain('Total PnL <b class="paper-pnl-up">+0.72 (+0.72%)</b>');
    expect(html).toContain('LIVE — real Lighter account');
    // An older Live run without its start balance: no made-up totals from the virtual 10,000.
    const older = renderToStaticMarkup(createElement(PaperPositionsTable, { detail: detail() }));
    expect(older).not.toContain('Realized <b');
    expect(older).not.toContain('Total PnL <b');
  });

  it('states the markets, balances, fees, parameters and execution rules of the run', () => {
    const detail = {
      status: 'running',
      tracks: [
        { venue: 'Lighter', market: 'HYPE' }, { venue: 'Lighter', market: 'SOL' }, { venue: 'Hyperliquid', market: 'HYPE' },
      ],
      settings: { accountModel: 'python_live_v1', timeframe: '1h', capitalPerVenue: 10_000, orderSizePercent: 10,
        lighterMakerFeePercent: 0, lighterTakerFeePercent: 0, hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045,
        params: { volatile_markets: 'HYPE,SOL', take_profit_percent: 1.2 } },
      runtime: { tracks: [
        { venue: 'Lighter', market: 'HYPE', priceReady: true, pendingOrders: 1 },
        { venue: 'Lighter', market: 'SOL', priceReady: false, pendingOrders: 0 },
        { venue: 'Hyperliquid', market: 'HYPE', priceReady: true, pendingOrders: 0 },
      ] },
    } as unknown as PaperExperimentDetail;
    const html = renderToStaticMarkup(createElement(PaperRunRules, { detail }));
    expect(html).toContain('<td>HYPE, SOL</td>');
    expect(html).toContain('<td>0.015%</td><td>0.045%</td>');
    expect(html).toContain('10,000 USDC');
    expect(html).toContain('10% of the exchange balance per entry');
    expect(html).toContain('volatile_markets = HYPE,SOL · take_profit_percent = 1.2');
    expect(html).toContain('taker fee is charged on every fill');
    const health = renderToStaticMarkup(createElement(PaperRunHealth, { detail }));
    expect(health).toContain('2 of 3 markets — waiting: Lighter SOL');
    expect(health).toContain('<span>Working orders</span><strong>1</strong>');
  });
});
