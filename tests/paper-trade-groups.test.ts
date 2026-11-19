import { describe, expect, it } from 'vitest';
import { GROUP_OPEN_MS, groupTrades, pairsFrom } from '../apps/api/src/paper-execution/paper-trade-groups.js';
import type { PaperExperimentActivityFill, PaperStrategyPanel } from '../packages/shared/src/paper-experiment-contracts.js';

let id = 0;
function fill(at: string, market: string, kind: 'entry' | 'exit', positionSide: 'long' | 'short', quantity: number, price: number,
  realizedPnl: number | null = null, reason: string | null = null): PaperExperimentActivityFill {
  const buy = (kind === 'entry') === (positionSide === 'long');
  return { id: `f${++id}`, at, venue: 'Lighter', market, kind, side: buy ? 'buy' : 'sell', positionSide,
    quantity: String(quantity), quote: String(quantity * price), price: String(price), fee: '0',
    realizedPnl: realizedPnl === null ? null : String(realizedPnl), reason };
}

// One Brent/WTI pair: the WTI entry in two fills, the Brent exit in two.
const LIVE = [
  fill('2026-11-12T08:08:48.100Z', 'BRENTOIL', 'entry', 'long', 21.8674, 91.46),
  fill('2026-11-12T08:08:48.200Z', 'WTI', 'entry', 'short', 11.61, 86.128),
  fill('2026-11-12T08:08:48.300Z', 'WTI', 'entry', 'short', 11.611, 86.125),
  fill('2026-11-12T10:24:49.100Z', 'BRENTOIL', 'exit', 'long', 11.6925, 90.32, -13.32945),
  fill('2026-11-12T10:24:49.200Z', 'BRENTOIL', 'exit', 'long', 10.1749, 90.32, -11.599386),
  fill('2026-11-12T10:24:49.300Z', 'WTI', 'exit', 'short', 23.221, 84.973, 26.785422),
];

/** The same pair, with the words the strategy and the engine put on each fill. */
const WITH_REASONS = [
  fill('2026-11-16T01:15:32.000Z', 'CRWV', 'entry', 'short', 55.8243, 53.74, null, 'r +7.5 bp from its 15-min mean'),
  fill('2026-11-16T01:15:32.100Z', 'NBIS', 'entry', 'long', 25.7776, 116.38, null, 'r +7.5 bp from its 15-min mean'),
  fill('2026-11-16T07:26:20.000Z', 'CRWV', 'exit', 'short', 55.8243, 50.8, 164.12, 'take-profit, r came back +12.0 bp'),
  fill('2026-11-16T07:26:21.000Z', 'NBIS', 'exit', 'long', 25.7776, 110.3711, -154.89, 'take-profit, r came back +12.0 bp'),
];

describe('trade reasons', () => {
  it('keeps why each position opened and closed, and shares one reason over the whole pair', () => {
    const [group] = groupTrades(WITH_REASONS, [], 'CRWV/NBIS').groups;
    expect(group!.openReason).toBe('r +7.5 bp from its 15-min mean');
    expect(group!.closeReason).toBe('take-profit, r came back +12.0 bp');
    expect(group!.legs.map((leg) => leg.closeReason))
      .toEqual(['take-profit, r came back +12.0 bp', 'take-profit, r came back +12.0 bp']);
  });

  it('leaves the group without a shared reason when the legs ended differently', () => {
    const mixed = [...WITH_REASONS.slice(0, 3),
      fill('2026-11-16T07:26:21.000Z', 'NBIS', 'exit', 'long', 25.7776, 110.3711, -154.89, 'the run stopped')];
    const [group] = groupTrades(mixed, [], 'CRWV/NBIS').groups;
    expect(group!.closeReason).toBeNull();
    expect(group!.legs.map((leg) => [leg.market, leg.closeReason]))
      .toEqual([['CRWV', 'take-profit, r came back +12.0 bp'], ['NBIS', 'the run stopped']]);
  });

  it('says nothing for a run recorded before reasons existed, and not before the position is closed', () => {
    const [open, closed] = groupTrades([...LIVE,
      fill('2026-11-16T01:15:32.000Z', 'CRWV', 'entry', 'short', 1, 53.74, null, 'r +7.5 bp from its 15-min mean'),
    ], [], 'BRENTOIL/WTI, CRWV/NBIS').groups;
    expect(open!.openReason).toBe('r +7.5 bp from its 15-min mean');
    expect(open!.closeReason).toBeNull();                       // still open
    expect([closed!.openReason, closed!.closeReason]).toEqual([null, null]);  // an older run
  });
});

describe('trade groups', () => {
  it('turns the fills of a pair into one group with a position per leg', () => {
    const { groups, truncated } = groupTrades(LIVE, [], 'BRENTOIL/WTI, XAU/XAG');
    expect(truncated).toBe(false);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.name).toBe('BRENTOIL/WTI');
    expect(group!.closedAt).toBe('2026-11-12T10:24:49.300Z');
    expect(group!.realizedPnl).toBeCloseTo(1.856586, 6);
    const [brent, wti] = group!.legs;
    expect(brent).toMatchObject({ market: 'BRENTOIL', side: 'long', fills: 3, closedAt: '2026-11-12T10:24:49.200Z' });
    expect(brent!.quantity).toBeCloseTo(21.8674, 9);
    expect(brent!.entryPrice).toBeCloseTo(91.46, 9);
    expect(brent!.exitPrice).toBeCloseTo(90.32, 9);
    expect(brent!.realizedPnl).toBeCloseTo(-24.928836, 6);
    expect(wti).toMatchObject({ market: 'WTI', side: 'short', fills: 3 });
    expect(wti!.quantity).toBeCloseTo(23.221, 9);
    expect(wti!.entryPrice).toBeCloseTo((11.61 * 86.128 + 11.611 * 86.125) / 23.221, 9);
    expect(wti!.realizedPnl).toBeCloseTo(26.785422, 6);
  });

  it('keeps a still open pair open and lists the newest group first', () => {
    const later = [...LIVE,
      fill('2026-11-12T12:00:00.000Z', 'XAU', 'entry', 'short', 0.5, 4000),
      fill('2026-11-12T12:00:00.400Z', 'XAG', 'entry', 'long', 40, 50)];
    const { groups } = groupTrades(later, [], 'BRENTOIL/WTI, XAU/XAG');
    expect(groups.map((group) => group.name)).toEqual(['XAU/XAG', 'BRENTOIL/WTI']);
    expect(groups[0]!.closedAt).toBeNull();
    expect(groups[0]!.legs.every((leg) => leg.closedAt === null && leg.realizedPnl === 0)).toBe(true);
  });

  it('counts closed positions, wins and gross profit / loss over all groups, a pair as one position', () => {
    const fills = [...LIVE,
      // a losing BTC position, then a still open XAU/XAG pair (not counted)
      fill('2026-11-12T11:00:00.000Z', 'BTC', 'entry', 'long', 0.01, 100_000),
      fill('2026-11-12T11:30:00.000Z', 'BTC', 'exit', 'long', 0.01, 99_000, -10.5),
      fill('2026-11-12T12:00:00.000Z', 'XAU', 'entry', 'short', 0.5, 4000),
      fill('2026-11-12T12:00:00.400Z', 'XAG', 'entry', 'long', 40, 50)];
    const { stats } = groupTrades(fills, [], 'BRENTOIL/WTI, XAU/XAG');
    expect(stats).toMatchObject({ closed: 2, wins: 1, partial: false });
    expect(stats.grossProfit).toBeCloseTo(1.856586, 6);
    expect(stats.grossLoss).toBeCloseTo(10.5, 9);
    const unknown = groupTrades([fill('2026-11-12T11:00:00.000Z', 'BTC', 'entry', 'long', 0.01, 100_000),
      fill('2026-11-12T11:30:00.000Z', 'BTC', 'exit', 'long', 0.01, 99_000)]).stats;
    expect(unknown).toEqual({ closed: 0, wins: 0, grossProfit: 0, grossLoss: 0, partial: true });
  });

  it('never joins markets of different pairs, nor legs opened more than a minute apart', () => {
    const fills = [
      fill('2026-11-12T12:00:00.000Z', 'BRENTOIL', 'entry', 'long', 1, 90),
      fill('2026-11-12T12:00:01.000Z', 'XAU', 'entry', 'long', 1, 4000),
      fill(new Date(Date.parse('2026-11-12T12:00:00.000Z') + GROUP_OPEN_MS + 1).toISOString(), 'WTI', 'entry', 'short', 1, 85),
    ];
    const { groups } = groupTrades(fills, [], 'BRENTOIL/WTI, XAU/XAG');
    expect(groups.map((group) => group.name).sort()).toEqual(['BRENTOIL', 'WTI', 'XAU']);
  });

  it('follows the markets of the strategy panels before the pairs parameter, in the panel order', () => {
    const panel: PaperStrategyPanel = { key: 'WTI/BRENTOIL', title: 'WTI/BRENTOIL', at: 1, markets: ['WTI', 'BRENTOIL'], lines: [] };
    const { groups } = groupTrades(LIVE, [panel], 'nothing');
    expect(groups[0]!.name).toBe('WTI/BRENTOIL');
  });

  it('keeps single markets of other strategies apart', () => {
    const fills = [
      fill('2026-11-12T12:00:00.000Z', 'HYPE', 'entry', 'long', 1, 40),
      fill('2026-11-12T12:00:02.000Z', 'BTC', 'entry', 'long', 0.01, 90000),
    ];
    expect(groupTrades(fills).groups.map((group) => group.name).sort()).toEqual(['BTC', 'HYPE']);
  });

  it('reads the pairs parameter', () => {
    expect(pairsFrom('BRENTOIL/WTI, XAU/XAG')).toEqual([['BRENTOIL', 'WTI'], ['XAU', 'XAG']]);
    expect(pairsFrom('xyz:BRENTOIL/xyz:CL')).toEqual([['xyz:BRENTOIL', 'xyz:CL']]);
    expect(pairsFrom(42)).toEqual([]);
    expect(pairsFrom('A/B/C, bad pair')).toEqual([]);
  });
});
