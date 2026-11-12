import { describe, expect, it } from 'vitest';
import { GROUP_OPEN_MS, groupTrades, pairsFrom } from '../apps/api/src/paper-execution/paper-trade-groups.js';
import type { PaperExperimentActivityFill, PaperStrategyPanel } from '../packages/shared/src/paper-experiment-contracts.js';

let id = 0;
function fill(at: string, market: string, kind: 'entry' | 'exit', positionSide: 'long' | 'short', quantity: number, price: number,
  realizedPnl: number | null = null): PaperExperimentActivityFill {
  const buy = (kind === 'entry') === (positionSide === 'long');
  return { id: `f${++id}`, at, venue: 'Lighter', market, kind, side: buy ? 'buy' : 'sell', positionSide,
    quantity: String(quantity), quote: String(quantity * price), price: String(price), fee: '0',
    realizedPnl: realizedPnl === null ? null : String(realizedPnl) };
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
