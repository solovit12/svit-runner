import type {
  PaperExperimentActivityFill,
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
};

const EPS = 1e-12;

function finish(leg: LegState): PaperTradeLeg {
  return {
    venue: leg.venue, market: leg.market, side: leg.side, openedAt: leg.openedAt, closedAt: leg.closedAt,
    quantity: leg.peak, entryPrice: leg.entryQty > 0 ? leg.entryValue / leg.entryQty : null,
    exitPrice: leg.exitQty > 0 ? leg.exitValue / leg.exitQty : null, entryValue: leg.entryValue,
    realizedPnl: leg.exitQty > 0 ? leg.pnl : 0, fees: leg.fees, fills: leg.fills,
  };
}

/**
 * Fills (oldest first) -> positions per market (entry to flat) -> groups of legs opened together.
 * A leg joins a group of the same exchange opened at most GROUP_OPEN_MS earlier that has no leg of its
 * market yet, and only markets of one pair: the pairs the strategy's panels name (ctx.status markets), else
 * the pairs of its `pairs` parameter ("BRENTOIL/WTI, XAU/XAG"). A market in no pair stays a group of its own.
 */
export function groupTrades(fills: readonly PaperExperimentActivityFill[],
  panels: readonly PaperStrategyPanel[] = [], pairsParam?: unknown): { groups: PaperTradeGroup[]; truncated: boolean } {
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
        pnl: 0, fees: 0, fills: 0 };
      legs.push(leg);
      open.set(key, leg);
    }
    if (!leg) continue;                       // an exit with no entry seen (journal started mid-position)
    leg.fills += 1;
    leg.fees += Number(fill.fee ?? 0);
    if (fill.kind === 'entry') {
      leg.open += quantity; leg.peak = Math.max(leg.peak, leg.open);
      leg.entryQty += quantity; leg.entryValue += value;
    } else {
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
      realizedPnl: pnl, fees: order.reduce((sum, leg) => sum + leg.fees, 0), legs: order,
    };
  }).reverse();
  return { groups: shaped.slice(0, MAX_TRADE_GROUPS), truncated: shaped.length > MAX_TRADE_GROUPS };
}

/** "BRENTOIL/WTI, XAU/XAG" -> [["BRENTOIL", "WTI"], ["XAU", "XAG"]]; anything else -> []. */
export function pairsFrom(value: unknown): string[][] {
  if (typeof value !== 'string' || value.length > 2_000) return [];
  return value.split(/[,;\n]/).map((item) => item.trim().split('/').map((market) => market.trim()))
    .filter((pair) => pair.length === 2 && pair.every((market) => /^[A-Za-z0-9:._-]{1,40}$/.test(market)));
}
