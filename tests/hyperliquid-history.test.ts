import { describe, expect, it } from 'vitest';
import { aggregateCandlesTo, candleOpenTime } from '../packages/market-data/src/candle-aggregation';
import { hyperliquidHistorySource, hyperliquidHistoryWindow } from '../packages/shared/src/hyperliquid-history';
import type { Candle } from '../packages/shared/src/contracts';

const NOW = Date.parse('2026-11-02T10:47:00.000Z');
const NO_KEY = { configured: false, historyDays: null };
const FREE_KEY = { configured: true, historyDays: 30 };

describe('Hyperliquid history window', () => {
  it('without a key: the last 5,000 candles of the timeframe, about 3.5 days of minutes', () => {
    const window = hyperliquidHistoryWindow('15m', 'default', NO_KEY, NOW);
    expect(window.apiFrom).toBe('2026-09-12');
    expect(window.apiMinuteFrom).toBe('2026-10-30');
    expect(window.oxarchiveFrom).toBeNull();
    expect(window.earliestStart).toBe('2026-09-12');
    expect(hyperliquidHistoryWindow('15m', 'high', NO_KEY, NOW).earliestStart).toBe('2026-10-30');
    expect(hyperliquidHistoryWindow('1h', 'default', NO_KEY, NOW).earliestStart).toBe('2026-04-09');
  });

  it('with a free 0xArchive key: every minute for the plan window, earlier dates from Hyperliquid itself', () => {
    expect(hyperliquidHistoryWindow('15m', 'high', FREE_KEY, NOW).earliestStart).toBe('2026-10-04');
    expect(hyperliquidHistoryWindow('15m', 'default', FREE_KEY, NOW).earliestStart).toBe('2026-09-12');
    // On 1m Hyperliquid keeps only ~3.5 days, so 0xArchive reaches further back.
    expect(hyperliquidHistoryWindow('1m', 'default', FREE_KEY, NOW).earliestStart).toBe('2026-10-04');
  });

  it('picks one source per run and explains a start that is too early', () => {
    expect(hyperliquidHistorySource('2026-10-20', '15m', 'high', FREE_KEY, NOW)).toEqual({ source: 'oxarchive' });
    expect(hyperliquidHistorySource('2026-09-15', '15m', 'default', FREE_KEY, NOW)).toEqual({ source: 'hyperliquid' });
    expect(hyperliquidHistorySource('2026-10-31', '15m', 'high', NO_KEY, NOW)).toEqual({ source: 'hyperliquid' });
    const withKey = hyperliquidHistorySource('2026-09-15', '15m', 'high', FREE_KEY, NOW);
    expect(withKey).toHaveProperty('error');
    if ('error' in withKey) {
      expect(withKey.error.en).toContain('start on 2026-10-04');
      expect(withKey.error.en).toContain('4 points per bar');
      expect(withKey.error.ru).toContain('2026-09-12');
    }
    const noKey = hyperliquidHistorySource('2026-10-20', '15m', 'high', NO_KEY, NOW);
    expect('error' in noKey && noKey.error.en).toContain('Add a free 0xArchive key');
    const tooDeep = hyperliquidHistorySource('2026-08-01', '15m', 'default', NO_KEY, NOW);
    expect('error' in tooDeep && tooDeep.error.en).toContain('last 5,000 15m candles, from 2026-09-12');
  });
});

function minuteCandle(openTime: number, price: number): Candle {
  return {
    openTime, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 2, closeTime: openTime + 59_999,
    quoteAssetVolume: 2 * price, numberOfTrades: 3, takerBuyBaseAssetVolume: 1, takerBuyQuoteAssetVolume: price, ignore: 0,
  };
}

describe('candle aggregation', () => {
  it('starts weeks on Monday, as Binance does', () => {
    expect(new Date(candleOpenTime(Date.parse('2026-10-29T12:00:00Z'), '1w')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(new Date(candleOpenTime(Date.parse('2026-10-26T00:00:00Z'), '1w')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('builds only complete candles: a bucket with a hole is left out', () => {
    const start = Date.parse('2026-10-20T00:00:00Z');
    const minutes = Array.from({ length: 45 }, (_, index) => minuteCandle(start + index * 60_000, 100 + index))
      .filter((candle) => candle.openTime !== start + 20 * 60_000);
    const candles = aggregateCandlesTo(minutes, '1m', '15m');
    expect(candles.map((candle) => candle.openTime)).toEqual([start, start + 30 * 60_000]);
    expect(candles[0]).toMatchObject({ open: 100, high: 115, low: 99, close: 114.5, volume: 30, numberOfTrades: 45, closeTime: start + 15 * 60_000 - 1 });
  });
});
