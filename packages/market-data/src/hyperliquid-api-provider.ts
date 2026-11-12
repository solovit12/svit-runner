import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe, type Candle } from '../../shared/src/contracts.js';
import {
  HYPERLIQUID_API_CANDLE_LIMIT,
  HYPERLIQUID_BACKTEST_DEXES,
  type HyperliquidBacktestDex,
  type HyperliquidMarketList,
  type HyperliquidMarketOption,
} from '../../shared/src/hyperliquid-history.js';
import { aggregateCandlesTo } from './candle-aggregation.js';
import { canonicalCandlesSha256 } from './high-detailization.js';
import type {
  HistoricalInstrumentResult,
  HistoricalMarketDataProvider,
  HistoricalMarketDataQuery,
  HistoricalMarketDataResult,
} from './historical-market-data-provider.js';

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const DEFAULT_TIMEOUT_MS = 30_000;
const META_TTL_MS = 5 * 60_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HyperliquidApiProviderOptions {
  fetcher?: Fetcher;
  clock?: () => Date;
  url?: string;
  timeoutMs?: number;
}

interface UniverseEntry { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }

function dexOf(symbol: string): HyperliquidBacktestDex {
  const dex = symbol.includes(':') ? symbol.slice(0, symbol.indexOf(':')) : '';
  return (HYPERLIQUID_BACKTEST_DEXES as readonly string[]).includes(dex) ? dex as HyperliquidBacktestDex : '';
}

function parseNumber(value: unknown, field: string): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`Hyperliquid returned an invalid candle ${field}.`);
  return number;
}

function parseCandle(value: unknown, intervalMs: number): Candle {
  if (typeof value !== 'object' || value === null) throw new Error('Hyperliquid returned an invalid candle.');
  const row = value as Record<string, unknown>;
  const openTime = row.t;
  if (!Number.isSafeInteger(openTime) || (openTime as number) % intervalMs !== 0) throw new Error('Hyperliquid returned a candle with an invalid open time.');
  if (row.T !== (openTime as number) + intervalMs - 1) throw new Error('Hyperliquid returned a candle with an invalid close time.');
  const trades = row.n ?? 0;
  if (!Number.isSafeInteger(trades) || (trades as number) < 0) throw new Error('Hyperliquid returned an invalid candle trade count.');
  return {
    openTime: openTime as number,
    open: parseNumber(row.o, 'open'),
    high: parseNumber(row.h, 'high'),
    low: parseNumber(row.l, 'low'),
    close: parseNumber(row.c, 'close'),
    volume: parseNumber(row.v, 'volume'),
    closeTime: row.T as number,
    quoteAssetVolume: 0,
    numberOfTrades: trades as number,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

/**
 * Candles and contracts from Hyperliquid's own public API (no key). It keeps only the most recent 5,000 candles of
 * every interval; older requests come back short and the server reports the incomplete period. Weekly candles
 * start on Thursday there, so 1w is built from daily candles (Monday weeks, as on Binance).
 */
export class HyperliquidApiProvider implements HistoricalMarketDataProvider {
  readonly #fetcher: Fetcher;
  readonly #clock: () => Date;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #meta = new Map<HyperliquidBacktestDex, { at: number; universe: UniverseEntry[] }>();
  #markets: HyperliquidMarketList | null = null;

  constructor(options: HyperliquidApiProviderOptions = {}) {
    this.#fetcher = options.fetcher ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#url = options.url ?? HYPERLIQUID_INFO_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    if (query.interval === '1w') {
      const daily = await this.getCandles({ ...query, interval: '1d' });
      const candles = aggregateCandlesTo(daily.candles, '1d', '1w');
      return { candles, provenance: { ...daily.provenance, interval: '1w', sha256: canonicalCandlesSha256(candles) } };
    }
    const intervalMs = BACKTEST_TIMEFRAME_MS[query.interval];
    const fetchedAt = this.#clock();
    const byOpenTime = new Map<number, Candle>();
    let pages = 0;
    let rawRows = 0;
    // A request holds at most 5,000 candles, so a longer period is asked in parts.
    for (let from = query.startInclusive; from < query.endExclusive; from += HYPERLIQUID_API_CANDLE_LIMIT * intervalMs) {
      query.signal?.throwIfAborted();
      const to = Math.min(query.endExclusive, from + HYPERLIQUID_API_CANDLE_LIMIT * intervalMs);
      const rows = await this.#post({
        type: 'candleSnapshot',
        req: { coin: query.symbol, interval: query.interval, startTime: from, endTime: to - 1 },
      }, query.signal);
      if (!Array.isArray(rows)) throw new Error('Hyperliquid returned an invalid candle list.');
      pages += 1;
      rawRows += rows.length;
      for (const row of rows) {
        const candle = parseCandle(row, intervalMs);
        if (candle.openTime < query.startInclusive || candle.openTime >= query.endExclusive) continue;
        if (candle.closeTime >= fetchedAt.getTime()) continue; // still open
        byOpenTime.set(candle.openTime, candle);
      }
    }
    const candles = [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
    return {
      candles,
      provenance: {
        provider: 'Hyperliquid',
        venue: 'hyperliquid',
        symbol: query.symbol,
        interval: query.interval as BacktestTimeframe,
        fetchedAt: fetchedAt.toISOString(),
        pages,
        rawRows,
        sha256: canonicalCandlesSha256(candles),
        recovery: null,
      },
    };
  }

  async getInstrument(symbol: string, signal?: AbortSignal): Promise<HistoricalInstrumentResult> {
    const universe = await this.#universe(dexOf(symbol), signal);
    const entry = universe.find((candidate) => candidate.name === symbol);
    if (!entry) throw new Error(`Hyperliquid has no perpetual market named ${symbol}.`);
    return {
      symbol: entry.name,
      szDecimals: entry.szDecimals,
      maxLeverage: entry.maxLeverage,
      isActive: entry.isDelisted !== true,
      instrumentType: 'perp',
      provenance: { provider: 'Hyperliquid', venue: 'hyperliquid', requestId: null, fetchedAt: this.#clock().toISOString() },
    };
  }

  /** Active markets of the main exchange and the HIP-3 exchanges, largest 24-hour turnover first; an older list if Hyperliquid fails. */
  async listMarkets(signal?: AbortSignal): Promise<HyperliquidMarketList> {
    const now = this.#clock().getTime();
    if (this.#markets && now - Date.parse(this.#markets.fetchedAt) < META_TTL_MS) return { ...this.#markets, sourceStatus: 'cached' };
    try {
      const markets: HyperliquidMarketOption[] = [];
      for (const dex of HYPERLIQUID_BACKTEST_DEXES) {
        const response = await this.#post(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, signal);
        if (!Array.isArray(response) || response.length !== 2) throw new Error('Hyperliquid returned an invalid market list.');
        const [meta, contexts] = response as [{ universe: UniverseEntry[] }, Array<{ dayNtlVlm?: string }>];
        meta.universe.forEach((entry, index) => {
          if (entry.isDelisted) return;
          markets.push({ symbol: entry.name, dex, maxLeverage: entry.maxLeverage, volume24hUsd: Number(contexts[index]?.dayNtlVlm ?? 0) || 0 });
        });
        this.#meta.set(dex, { at: now, universe: meta.universe });
      }
      markets.sort((left, right) => right.volume24hUsd - left.volume24hUsd);
      this.#markets = { exchange: 'Hyperliquid', fetchedAt: new Date(now).toISOString(), sourceStatus: 'live', markets };
      return this.#markets;
    } catch (error) {
      if (this.#markets) return { ...this.#markets, sourceStatus: 'stale' };
      throw error;
    }
  }

  async #universe(dex: HyperliquidBacktestDex, signal?: AbortSignal): Promise<UniverseEntry[]> {
    const cached = this.#meta.get(dex);
    const now = this.#clock().getTime();
    if (cached && now - cached.at < META_TTL_MS) return cached.universe;
    const meta = await this.#post(dex ? { type: 'meta', dex } : { type: 'meta' }, signal) as { universe?: UniverseEntry[] };
    if (!meta || !Array.isArray(meta.universe)) throw new Error('Hyperliquid returned an invalid market list.');
    this.#meta.set(dex, { at: now, universe: meta.universe });
    return meta.universe;
  }

  async #post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetcher(this.#url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: requestSignal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new Error('Hyperliquid did not answer in time.');
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new Error('Could not reach Hyperliquid.');
    }
    if (!response.ok) throw new Error(`Hyperliquid answered HTTP ${response.status}.`);
    return response.json();
  }
}
