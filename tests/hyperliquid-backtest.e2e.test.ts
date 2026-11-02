import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/server';
import { checkOxArchiveKey } from '../apps/api/src/data-source-settings';
import type { HistoricalMarketDataProvider, HistoricalMarketDataQuery } from '../packages/market-data/src/historical-market-data-provider';
import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe, type Candle } from '../packages/shared/src/contracts';
import type { HyperliquidMarketList } from '../packages/shared/src/hyperliquid-history';

const NOW = Date.parse('2026-11-02T10:47:00.000Z');
const KEY = 'test-oxarchive-key-0123456789';
const SOURCE = '//@version=6\nstrategy("t", overlay = true)\nif bar_index == 2\n    strategy.entry("L", strategy.long)\n';

function candle(openTime: number, ms: number): Candle {
  const price = 100 + ((openTime / 60_000) % 7);
  return {
    openTime, open: price, high: price + 1, low: price - 1, close: price, volume: 1, closeTime: openTime + ms - 1,
    quoteAssetVolume: price, numberOfTrades: 1, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
  };
}

/** Steady candles of any interval; records which source answered. */
function fakeSource(name: '0xArchive' | 'Hyperliquid', calls: string[]): HistoricalMarketDataProvider & { listMarkets(): Promise<HyperliquidMarketList> } {
  return {
    async getCandles(query: HistoricalMarketDataQuery) {
      calls.push(`${name} ${query.interval}`);
      const ms = BACKTEST_TIMEFRAME_MS[query.interval];
      const candles: Candle[] = [];
      for (let t = Math.ceil(query.startInclusive / ms) * ms; t + ms <= Math.min(query.endExclusive, NOW); t += ms) candles.push(candle(t, ms));
      return { candles, provenance: { provider: name, venue: 'hyperliquid', symbol: query.symbol, interval: query.interval as BacktestTimeframe, fetchedAt: new Date(NOW).toISOString(), pages: 1, rawRows: candles.length, sha256: 'x', recovery: null } };
    },
    async getInstrument(symbol: string) {
      return { symbol, szDecimals: 3, maxLeverage: 50, isActive: true, instrumentType: 'perp' as const, provenance: { provider: 'Hyperliquid' as const, venue: 'hyperliquid' as const, requestId: null, fetchedAt: '' } };
    },
    async listMarkets() {
      return { exchange: 'Hyperliquid' as const, fetchedAt: new Date(NOW).toISOString(), sourceStatus: 'live' as const, markets: [{ symbol: 'xyz:SP500', dex: 'xyz' as const, maxLeverage: 50, volume24hUsd: 1 }] };
    },
  };
}

/** 0xArchive as the free plan answers: recent hours work, older ones are refused with the plan's window. */
async function fakeOxArchive(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (headers.get('X-API-Key') !== KEY) return new Response('{"error":"invalid key"}', { status: 401 });
  const start = Number(new URL(String(input)).searchParams.get('start'));
  if (start < NOW - 30 * 86_400_000) return new Response('{"code":403,"error":"Your plan includes the most recent 30 days of history: this request starts before the earliest allowed timestamp."}', { status: 403 });
  return Response.json({ success: true, data: [], meta: {} });
}

describe('Hyperliquid backtests', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'psr-hl-'));
  const calls: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      now: () => NOW,
      hyperliquidApi: fakeSource('Hyperliquid', calls),
      oxarchiveProvider: (apiKey) => { expect(apiKey).toBe(KEY); return fakeSource('0xArchive', calls); },
      oxarchiveFetch: fakeOxArchive as typeof fetch,
      dataSourceSecretsDir: path.join(dir, 'data-source-secrets'),
      strategyCatalogDir: null, paperExperimentsDir: null, paperRunsDir: null,
      liveSecretsDir: path.join(dir, 'live'), liveServerSecretsDir: null, reportSecretsDir: path.join(dir, 'reports'),
    });
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const backtest = (start: string, end: string, barDetailization: 'high' | 'default', timeframe: BacktestTimeframe = '15m') => app.inject({
    method: 'POST', url: '/api/backtests',
    payload: {
      source: SOURCE, exchange: 'Hyperliquid', marketType: 'Perpetual', symbol: 'xyz:SP500', timeframe, barIndexOffset: 0,
      dateRange: { start, end }, initialCapital: 10_000, baseCurrency: 'USDC', defaultOrderSizeValue: 10,
      defaultOrderSizeType: 'percent_of_equity', pyramiding: 0, feeModel: 'manual', commissionType: 'percent',
      commissionValue: 0.09, slippagePercent: 0.2, barDetailization, processOrdersOnClose: true,
    },
  });

  it('checks a key, keeps it on the server only and reports the plan window', async () => {
    expect(await checkOxArchiveKey(KEY, fakeOxArchive as typeof fetch, NOW)).toEqual({ historyDays: 30 });
    const wrong = await app.inject({ method: 'PUT', url: '/api/data-sources/oxarchive', payload: { apiKey: 'wrong-key-0123456789' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).not.toContain('wrong-key');
    const saved = await app.inject({ method: 'PUT', url: '/api/data-sources/oxarchive', payload: { apiKey: KEY } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ oxarchive: { configured: true, historyDays: 30, checkedAt: new Date(NOW).toISOString(), fromEnvironment: false } });
    expect(saved.body).not.toContain(KEY);
    const file = path.join(dir, 'data-source-secrets', 'oxarchive.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(KEY);
    expect((await app.inject({ method: 'GET', url: '/api/data-sources' })).body).not.toContain(KEY);
  });

  it('lists Hyperliquid markets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/markets/hyperliquid' });
    expect(response.json().markets[0].symbol).toBe('xyz:SP500');
  });

  it('runs inside the key window on 0xArchive minutes, every timeframe built from them', async () => {
    calls.length = 0;
    const response = await backtest('2026-10-28', '2026-10-29', 'high');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.data).toMatchObject({ provider: '0xArchive', venue: 'hyperliquid', symbol: 'xyz:SP500', bars: 192 });
    expect(body.data.intrabar.source).toBe('0xArchive Hyperliquid candles');
    expect(calls).toEqual(['0xArchive 1m']);
  });

  it('runs earlier periods on Hyperliquid candles with 4 points per bar', async () => {
    calls.length = 0;
    const response = await backtest('2026-09-20', '2026-09-21', 'default');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ provider: 'Hyperliquid', bars: 192, intrabar: null });
    expect(calls).toEqual(['Hyperliquid 15m']);
  });

  it('refuses every-minute checks before the key window, saying what to change', async () => {
    const response = await backtest('2026-09-20', '2026-09-21', 'high');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ kind: 'HYPERLIQUID_HISTORY_WINDOW' });
    expect(response.json().error).toContain('Every-minute checks on Hyperliquid start on 2026-10-04');
  });

  it('without a key, every minute covers only Hyperliquid\'s own minutes', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/data-sources/oxarchive' })).json().oxarchive.configured).toBe(false);
    calls.length = 0;
    const recent = await backtest('2026-11-01', '2026-11-01', 'high');
    expect(recent.statusCode, recent.body).toBe(200);
    expect(recent.json().data).toMatchObject({ provider: 'Hyperliquid' });
    expect(recent.json().data.intrabar.source).toBe('Hyperliquid candles');
    expect(calls).toEqual(['Hyperliquid 1m']);
    const older = await backtest('2026-10-28', '2026-10-29', 'high');
    expect(older.statusCode).toBe(422);
    expect(older.json().error).toContain('Add a free 0xArchive key');
  });
});
