import type { BacktestTimeframe } from '../../shared/src/contracts.js';
import { aggregateCandlesTo } from './candle-aggregation.js';
import { canonicalCandlesSha256, MINUTE_MS } from './high-detailization.js';
import type {
  HistoricalInstrumentResult,
  HistoricalMarketDataProvider,
  HistoricalMarketDataQuery,
  HistoricalMarketDataResult,
} from './historical-market-data-provider.js';

export interface MinuteHistoryProviderOptions {
  /** Minutes are asked this much earlier, so quiet first minutes get a previous price. */
  lookbackMs?: number;
  /** Never ask before this time (the edge of the data plan). */
  notBefore?: number;
}

const DEFAULT_LOOKBACK_MS = 24 * 60 * MINUTE_MS;

/**
 * One backtest's history built from a single minute source: every timeframe is aggregated from the same 1m candles
 * the "Every minute" checks replay, so chart candles and minutes always agree. The minutes are loaded once per run
 * (one instance per run) and reused for the chart, the replay and request.security inside the same period.
 */
export class MinuteHistoryProvider implements HistoricalMarketDataProvider {
  readonly #minutes: HistoricalMarketDataProvider;
  readonly #instruments: HistoricalMarketDataProvider;
  readonly #lookbackMs: number;
  readonly #notBefore: number;
  #cache: { symbol: string; startInclusive: number; endExclusive: number; result: HistoricalMarketDataResult } | null = null;

  constructor(minutes: HistoricalMarketDataProvider, instruments: HistoricalMarketDataProvider, options: MinuteHistoryProviderOptions = {}) {
    this.#minutes = minutes;
    this.#instruments = instruments;
    this.#lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.#notBefore = options.notBefore ?? Number.NEGATIVE_INFINITY;
  }

  async getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    const minutes = await this.#loadMinutes(query);
    const inPeriod = minutes.candles.filter((candle) => candle.openTime >= query.startInclusive && candle.openTime < query.endExclusive);
    const first = inPeriod[0];
    if (first && first.openTime > query.startInclusive) {
      const from = new Date(this.#cache?.startInclusive ?? query.startInclusive).toISOString().slice(0, 16);
      // No trade between the look-back and the first trade of the period: these minutes have no price to replay.
      throw new Error(`${query.symbol} had no trade from ${from} to ${new Date(first.openTime).toISOString().slice(0, 16)} UTC, so the start of the period has no price. Choose a later start or a more traded market. / На ${query.symbol} не было сделок с ${from} до ${new Date(first.openTime).toISOString().slice(0, 16)} UTC, поэтому у начала периода нет цены. Выберите более позднее начало или более торгуемый рынок.`);
    }
    const candles = query.interval === '1m' ? inPeriod : aggregateCandlesTo(inPeriod, '1m', query.interval);
    return {
      candles,
      provenance: { ...minutes.provenance, interval: query.interval as BacktestTimeframe, sha256: canonicalCandlesSha256(candles) },
    };
  }

  getInstrument(symbol: string, signal?: AbortSignal): Promise<HistoricalInstrumentResult> {
    return this.#instruments.getInstrument(symbol, signal);
  }

  async #loadMinutes(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    // The look-back stops at the plan's edge, but never cuts into the asked period itself.
    const startInclusive = Math.floor(Math.max(query.startInclusive - this.#lookbackMs, Math.min(this.#notBefore, query.startInclusive)) / MINUTE_MS) * MINUTE_MS;
    const endExclusive = Math.ceil(query.endExclusive / MINUTE_MS) * MINUTE_MS;
    const cached = this.#cache;
    if (cached && cached.symbol === query.symbol && cached.startInclusive <= startInclusive && cached.endExclusive >= endExclusive) return cached.result;
    const result = await this.#minutes.getCandles({ symbol: query.symbol, interval: '1m', startInclusive, endExclusive, signal: query.signal });
    this.#cache = { symbol: query.symbol, startInclusive, endExclusive, result };
    return result;
  }
}
