import { pairsFrom } from '../../../../packages/shared/src/pair-legs.js';
import type {
  PaperExperimentActivityFill,
  PaperRunTradeStats,
  PaperStrategyPanel,
  PaperTradeGroup,
  PaperTradeLeg,
} from '../../../../packages/shared/src/paper-experiment-contracts.js';

/** Legs whose first entries are this close belong to one group (both legs of a pair open within a second). */
export const GROUP_OPEN_MS = 60_000;
/** Groups kept in the list, newest first. */
export const MAX_TRADE_GROUPS = 200;

type LegState = {
  venue: PaperTradeLeg['venue']; market: string; side: PaperTradeLeg['side'];
  openedMs: number | null; openedAt: string | null; closedAt: string | null;
  open: number; peak: number; entryQty: number; entryValue: number; exitQty: number; exitValue: number;
  pnl: number | null; fees: number; fills: number;
  openReason: string | null; closeReason: string | null;
};

const EPS = 1e-12;
/** Longest reason kept on a position (the ledger already caps a fill's own at 120). */
const MAX_REASON = 120;

function reasonOf(fill: PaperExperimentActivityFill): string | null {
  const text = typeof fill.reason === 'string' ? fill.reason.trim().slice(0, MAX_REASON) : '';
  return text || null;
}

/** The one reason every leg names, or null when they name none or disagree (then each leg has its own). */
function shared(legs: readonly PaperTradeLeg[], of: (leg: PaperTradeLeg) => string | null): string | null {
  const first = of(legs[0]!);
  return first !== null && legs.every((leg) => of(leg) === first) ? first : null;
}

function finish(leg: LegState): PaperTradeLeg {
  return {
    venue: leg.venue, market: leg.market, side: leg.side, openedAt: leg.openedAt, closedAt: leg.closedAt,
    quantity: leg.peak, entryPrice: leg.entryQty > 0 ? leg.entryValue / leg.entryQty : null,
    exitPrice: leg.exitQty > 0 ? leg.exitValue / leg.exitQty : null, entryValue: leg.entryValue,
    realizedPnl: leg.exitQty > 0 ? leg.pnl : 0, fees: leg.fees, fills: leg.fills,
    openReason: leg.openReason, closeReason: leg.closeReason,
  };
}

/**
 * Fills (oldest first) -> positions per market (entry to flat) -> groups of legs opened together.
 * A leg joins a group of the same exchange opened at most GROUP_OPEN_MS earlier that has no leg of its
 * market yet, and only markets of one pair: the pairs the strategy's panels name (ctx.status markets), else
 * the pairs of its `pairs` parameter ("BRENTOIL/WTI, XAU/XAG"). A market in no pair stays a group of its own.
 */
export { pairsFrom };

export function groupTrades(fills: readonly PaperExperimentActivityFill[],
  panels: readonly PaperStrategyPanel[] = [], pairsParam?: unknown,
): { groups: PaperTradeGroup[]; truncated: boolean; stats: PaperRunTradeStats } {
  const legs: LegState[] = [];
  const open = new Map<string, LegState>();
  for (const fill of fills) {
    const key = `${fill.venue}:${fill.market}`;
    const quantity = Number(fill.quantity);
    const value = Number(fill.quote);
    const ms = fill.at ? Date.parse(fill.at) : NaN;
    let leg = open.get(key);
    if (fill.kind === 'entry' && (!leg || leg.side !== fill.positionSide)) {
      leg = { venue: fill.venue, market: fill.market, side: fill.positionSide, openedMs: Number.isFinite(ms) ? ms : null,
        openedAt: fill.at, closedAt: null, open: 0, peak: 0, entryQty: 0, entryValue: 0, exitQty: 0, exitValue: 0,
        pnl: 0, fees: 0, fills: 0, openReason: null, closeReason: null };
      legs.push(leg);
      open.set(key, leg);
    }
    if (!leg) continue;                       // an exit with no entry seen (journal started mid-position)
    leg.fills += 1;
    leg.fees += Number(fill.fee ?? 0);
    if (fill.kind === 'entry') {
      leg.open += quantity; leg.peak = Math.max(leg.peak, leg.open);
      leg.entryQty += quantity; leg.entryValue += value;
      leg.openReason = leg.openReason ?? reasonOf(fill);   // the first entry fill that names one
    } else {
      leg.closeReason = reasonOf(fill) ?? leg.closeReason; // the last exit fill that names one
      leg.open -= quantity;
      leg.exitQty += quantity; leg.exitValue += value;
      leg.pnl = leg.pnl === null || fill.realizedPnl === null ? null : leg.pnl + Number(fill.realizedPnl);
      if (leg.open <= EPS * Math.max(1, leg.peak)) {
        leg.closedAt = fill.at;
        open.delete(key);
      }
    }
  }
  const panelOf = new Map<string, readonly string[]>();
  for (const panel of panels) if (panel.markets.length > 1) for (const market of panel.markets) panelOf.set(market, panel.markets);
  if (panelOf.size === 0) for (const pair of pairsFrom(pairsParam)) for (const market of pair) panelOf.set(market, pair);
  const groups: { venue: LegState['venue']; legs: LegState[]; first: number | null }[] = [];
  for (const leg of legs) {
    const panel = panelOf.get(leg.market);
    const home = leg.openedMs === null || panel === undefined ? undefined : groups.find((group) => group.first !== null
      && leg.openedMs! - group.first <= GROUP_OPEN_MS && group.venue === leg.venue
      && !group.legs.some((other) => other.market === leg.market)
      && group.legs.every((other) => panelOf.get(other.market) === panel));
    if (home) home.legs.push(leg);
    else groups.push({ venue: leg.venue, legs: [leg], first: leg.openedMs });
  }
  const shaped = groups.map((group): PaperTradeGroup => {
    const done = group.legs.map(finish);
    const panel = panelOf.get(done[0]!.market);
    const order = panel ? [...done].sort((left, right) => panel.indexOf(left.market) - panel.indexOf(right.market)) : done;
    const first = done[0]!;
    const closed = order.every((leg) => leg.closedAt !== null);
    const pnl = order.some((leg) => leg.realizedPnl === null) ? null : order.reduce((sum, leg) => sum + (leg.realizedPnl ?? 0), 0);
    return {
      id: `${first.venue}:${first.market}:${first.openedAt ?? ''}`,
      name: order.map((leg) => leg.market).join('/'),
      openedAt: first.openedAt,
      closedAt: closed ? order.map((leg) => leg.closedAt ?? '').sort().at(-1) ?? null : null,
      realizedPnl: pnl, fees: order.reduce((sum, leg) => sum + leg.fees, 0),
      openReason: shared(order, (leg) => leg.openReason),
      closeReason: closed ? shared(order, (leg) => leg.closeReason) : null,
      legs: order,
    };
  }).reverse();
  return { groups: shaped.slice(0, MAX_TRADE_GROUPS), truncated: shaped.length > MAX_TRADE_GROUPS, stats: tradeStats(shaped) };
}

/** Closed positions, wins and gross profit / loss over every group (not only the ones the list keeps). */
export function tradeStats(groups: readonly PaperTradeGroup[]): PaperRunTradeStats {
  let closed = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let partial = false;
  for (const group of groups) {
    if (group.closedAt === null) continue;
    if (group.realizedPnl === null || !Number.isFinite(group.realizedPnl)) { partial = true; continue; }
    closed += 1;
    if (group.realizedPnl > 0) { wins += 1; grossProfit += group.realizedPnl; }
    else grossLoss -= group.realizedPnl;
  }
  return { closed, wins, grossProfit, grossLoss, partial };
}

