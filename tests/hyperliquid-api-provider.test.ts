import { describe, expect, it } from 'vitest';
import { HyperliquidApiProvider } from '../packages/market-data/src/hyperliquid-api-provider';
import { MinuteHistoryProvider } from '../packages/market-data/src/minute-history-provider';
import type { HistoricalMarketDataProvider, HistoricalMarketDataQuery } from '../packages/market-data/src/historical-market-data-provider';
import type { Candle } from '../packages/shared/src/contracts';

const MINUTE = 60_000;
const DAY = 86_400_000;

function row(t: number, ms: number, price: number) {
  return { t, T: t + ms - 1, s: 'BTC', i: '', o: String(price), c: String(price + 1), h: String(price + 2), l: String(price - 1), v: '1.5', n: 4 };
}

/** A fake info endpoint: candles of any interval at a steady price, and two exchanges' market lists. */
function fakeHyperliquid(calls: unknown[] = []) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; dex?: string; req?: { coin: string; interval: string; startTime: number; endTime: number } };
    calls.push(body);
    if (body.type === 'candleSnapshot') {
      const ms = { '1m': MINUTE, '15m': 15 * MINUTE, '1d': DAY }[body.req!.interval]!;
      const rows = [];
      for (let t = Math.ceil(body.req!.startTime / ms) * ms; t <= body.req!.endTime; t += ms) rows.push(row(t, ms, 100));
      return Response.json(rows);
    }
    const universe = body.dex === 'xyz'
      ? [{ name: 'xyz:SP500', szDecimals: 3, maxLeverage: 50 }, { name: 'xyz:OLD', szDecimals: 2, maxLeverage: 5, isDelisted: true }]
      : body.dex === 'io' ? [{ name: 'io:ANTH', szDecimals: 4, maxLeverage: 15 }]
        : body.dex === 'para' ? [{ name: 'para:ANTH', szDecimals: 4, maxLeverage: 10 }]
          : [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'kPEPE', szDecimals: 0, maxLeverage: 10 }];
    if (body.type === 'meta') return Response.json({ universe });
    const volumes = body.dex === 'xyz' ? ['3000000', '1'] : body.dex === 'io' ? ['2000000'] : body.dex === 'para' ? ['50'] : ['9000000', '100'];
    return Response.json([{ universe }, volumes.map((dayNtlVlm) => ({ dayNtlVlm }))]);
  };
}

describe('Hyperliquid API history', () => {
  const now = new Date('2026-11-02T10:47:30.000Z');

  it('reads closed candles and asks a long period in parts of 5,000', async () => {
    const calls: unknown[] = [];
    const provider = new HyperliquidApiProvider({ fetcher: fakeHyperliquid(calls), clock: () => now });
    const start = Date.parse('2026-10-25T00:00:00Z');
    const result = await provider.getCandles({ symbol: 'BTC', interval: '1m', startInclusive: start, endExclusive: now.getTime() + MINUTE });
    expect(calls).toHaveLength(3);
    expect(result.candles[0]).toMatchObject({ openTime: start, open: 100, high: 102, low: 99, close: 101, volume: 1.5, numberOfTrades: 4 });
    // 10:47 is still open: the last candle is 10:46.
    expect(new Date(result.candles.at(-1)!.openTime).toISOString()).toBe('2026-11-02T10:46:00.000Z');
    expect(result.provenance).toMatchObject({ provider: 'Hyperliquid', venue: 'hyperliquid', symbol: 'BTC', interval: '1m', pages: 3 });
  });

  it('builds Monday weeks from daily candles (its own weeks start on Thursday)', async () => {
    const provider = new HyperliquidApiProvider({ fetcher: fakeHyperliquid(), clock: () => now });
    const result = await provider.getCandles({
      symbol: 'BTC', interval: '1w', startInclusive: Date.parse('2026-10-05T00:00:00Z'), endExclusive: Date.parse('2026-10-26T00:00:00Z'),
    });
    expect(result.candles.map((candle) => new Date(candle.openTime).toISOString().slice(0, 10))).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    expect(result.candles[0]!.closeTime).toBe(Date.parse('2026-10-12T00:00:00Z') - 1);
    expect(result.provenance.interval).toBe('1w');
  });

  it('finds main and HIP-3 contracts (xyz, io, para) by their exact names and lists the active ones by turnover', async () => {
    const provider = new HyperliquidApiProvider({ fetcher: fakeHyperliquid(), clock: () => now });
    expect(await provider.getInstrument('xyz:SP500')).toMatchObject({ symbol: 'xyz:SP500', szDecimals: 3, maxLeverage: 50, isActive: true, instrumentType: 'perp' });
    expect(await provider.getInstrument('io:ANTH')).toMatchObject({ symbol: 'io:ANTH', szDecimals: 4, maxLeverage: 15 });
    expect(await provider.getInstrument('para:ANTH')).toMatchObject({ symbol: 'para:ANTH', maxLeverage: 10 });
    expect(await provider.getInstrument('kPEPE')).toMatchObject({ szDecimals: 0 });
    await expect(provider.getInstrument('KPEPE')).rejects.toThrow('no perpetual market named KPEPE');
    const list = await provider.listMarkets();
    expect(list.markets.map((market) => market.symbol)).toEqual(['BTC', 'xyz:SP500', 'io:ANTH', 'kPEPE', 'para:ANTH']);
    expect(list.markets[2]).toMatchObject({ dex: 'io', maxLeverage: 15 });
    expect(list.markets[1]).toMatchObject({ dex: 'xyz', maxLeverage: 50, volume24hUsd: 3_000_000 });
    expect((await provider.listMarkets()).sourceStatus).toBe('cached');
  });
});

function flatMinute(openTime: number, price: number): Candle {
  return {
    openTime, open: price, high: price, low: price, close: price, volume: 0, closeTime: openTime + MINUTE - 1,
    quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
  };
}

describe('one run, one minute source', () => {
  const start = Date.parse('2026-10-20T00:00:00Z');
  const minutes = (from: number, to: number) => Array.from({ length: (to - from) / MINUTE }, (_, index) => flatMinute(from + index * MINUTE, 100 + index));
  const source = (queries: HistoricalMarketDataQuery[], firstTrade = Number.NEGATIVE_INFINITY): HistoricalMarketDataProvider => ({
    async getCandles(query) {
      queries.push(query);
      const candles = minutes(query.startInclusive, query.endExclusive).filter((candle) => candle.openTime >= firstTrade);
      return { candles, provenance: { provider: '0xArchive', venue: 'hyperliquid', symbol: query.symbol, interval: '1m', fetchedAt: '', pages: 1, rawRows: candles.length, sha256: '', recovery: null } };
    },
    async getInstrument() { throw new Error('not used'); },
  });

  it('builds the chart candles from the replayed minutes and loads them once, a day early', async () => {
    const queries: HistoricalMarketDataQuery[] = [];
    const provider = new MinuteHistoryProvider(source(queries), source([]), { notBefore: start - 2 * 60 * MINUTE });
    const parent = await provider.getCandles({ symbol: 'BTC', interval: '15m', startInclusive: start, endExclusive: start + 60 * MINUTE });
    const replay = await provider.getCandles({ symbol: 'BTC', interval: '1m', startInclusive: start, endExclusive: start + 60 * MINUTE });
    expect(queries).toHaveLength(1);
    // The look-back stops at the plan's edge.
    expect(queries[0]!.startInclusive).toBe(start - 2 * 60 * MINUTE);
    expect(parent.candles).toHaveLength(4);
    expect(parent.candles[1]).toMatchObject({ openTime: start + 15 * MINUTE, open: replay.candles[15]!.open, close: replay.candles[29]!.close });
    expect(replay.candles).toHaveLength(60);
    expect(parent.provenance.interval).toBe('15m');
  });

  it('refuses a period whose first minutes have no price at all', async () => {
    const provider = new MinuteHistoryProvider(source([], start + 7 * MINUTE), source([]));
    await expect(provider.getCandles({ symbol: 'xyz:TWST', interval: '1h', startInclusive: start, endExclusive: start + 60 * MINUTE }))
      .rejects.toThrow('xyz:TWST had no trade from 2026-10-19T00:00 to 2026-10-20T00:07 UTC');
  });
});
