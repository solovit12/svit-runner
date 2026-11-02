import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe, type Candle } from '../../shared/src/contracts.js';

const DAY_MS = 86_400_000;
/** 1970-01-05 was a Monday: weeks start on Monday 00:00 UTC, as on Binance. */
const FIRST_MONDAY_MS = 4 * DAY_MS;

/** Open time of the `interval` candle holding `time` (UTC; weeks start on Monday). */
export function candleOpenTime(time: number, interval: BacktestTimeframe): number {
  const ms = BACKTEST_TIMEFRAME_MS[interval];
  const origin = interval === '1w' ? FIRST_MONDAY_MS : 0;
  return time - (((time - origin) % ms) + ms) % ms;
}

/**
 * Builds `interval` candles from smaller ones. Only complete candles come out: every source candle of the bucket
 * present, so a bucket with a hole or one still open is left out and the server reports the gap.
 */
export function aggregateCandlesTo(source: readonly Candle[], sourceInterval: BacktestTimeframe, interval: BacktestTimeframe): Candle[] {
  const sourceMs = BACKTEST_TIMEFRAME_MS[sourceInterval];
  const ms = BACKTEST_TIMEFRAME_MS[interval];
  if (ms % sourceMs !== 0) throw new Error(`${interval} candles cannot be built from ${sourceInterval} candles.`);
  const perBucket = ms / sourceMs;
  const result: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketOpen = Number.NaN;
  const flush = () => {
    if (bucket.length !== perBucket) return;
    const first = bucket[0]!;
    const last = bucket.at(-1)!;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    let quoteAssetVolume = 0;
    let numberOfTrades = 0;
    let takerBuyBaseAssetVolume = 0;
    let takerBuyQuoteAssetVolume = 0;
    for (const candle of bucket) {
      if (candle.high > high) high = candle.high;
      if (candle.low < low) low = candle.low;
      volume += candle.volume;
      quoteAssetVolume += candle.quoteAssetVolume;
      numberOfTrades += candle.numberOfTrades;
      takerBuyBaseAssetVolume += candle.takerBuyBaseAssetVolume;
      takerBuyQuoteAssetVolume += candle.takerBuyQuoteAssetVolume;
    }
    result.push({
      openTime: bucketOpen, open: first.open, high, low, close: last.close, volume, closeTime: bucketOpen + ms - 1,
      quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore: 0,
    });
  };
  for (const candle of source) {
    const open = candleOpenTime(candle.openTime, interval);
    if (open !== bucketOpen) {
      flush();
      bucket = [];
      bucketOpen = open;
    }
    // A hole inside the bucket leaves it short of candles, so flush() drops it.
    if (bucket.length === 0 ? candle.openTime === open : candle.openTime === bucket.at(-1)!.openTime + sourceMs) bucket.push(candle);
    else bucket = [];
  }
  flush();
  return result;
}
