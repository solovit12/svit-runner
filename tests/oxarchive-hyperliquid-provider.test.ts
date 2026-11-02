import { describe, expect, it, vi } from 'vitest';

import {
  OXARCHIVE_CANDLE_PAGE_LIMIT,
  OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR,
  OXARCHIVE_TRADE_PAGE_LIMIT,
  OxArchiveHyperliquidProvider,
  type OxArchiveFetcher,
} from '../packages/market-data/src/oxarchive-hyperliquid-provider.js';

const MINUTE_MS = 60_000;
const START = Date.parse('2026-09-01T00:00:00.000Z');

function candle(
  openTime: number,
  overrides: Partial<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    quote_volume: number;
    trade_count: number;
  }> = {},
) {
  return {
    timestamp: new Date(openTime).toISOString(),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 10,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function page(data: unknown[], nextCursor: string | null, requestId = 'request-1') {
  return { success: true, data, meta: { count: data.length, next_cursor: nextCursor, request_id: requestId } };
}

function trade(
  timestamp: number,
  tradeId: number,
  price: string,
  size: string,
  overrides: Partial<{
    symbol: string;
    coin: string;
    side: 'A' | 'B';
    crossed: boolean;
  }> = {},
) {
  return {
    symbol: 'BTC',
    coin: 'BTC',
    side: 'B',
    crossed: true,
    price,
    size,
    timestamp: new Date(timestamp).toISOString(),
    trade_id: tradeId,
    ...overrides,
  };
}

function tradePair(timestamp: number, tradeId: number, price: string, size: string): unknown[] {
  return [
    trade(timestamp, tradeId, price, size, { side: 'A', crossed: false }),
    trade(timestamp, tradeId, price, size, { side: 'B', crossed: true }),
  ];
}

function recoveryTrades(start = START): unknown[] {
  return [
    ...tradePair(start + 1_000, 1, '100', '2'),
    ...tradePair(start + 2_000, 2, '105', '3'),
    ...tradePair(start + 3_000, 3, '95', '4'),
    ...tradePair(start + 4_000, 4, '102', '1'),
    ...tradePair(start + MINUTE_MS + 1_000, 5, '102', '1'),
    ...tradePair(start + MINUTE_MS + 2_000, 6, '103', '2'),
    ...tradePair(start + MINUTE_MS + 3_000, 7, '101', '3'),
    ...tradePair(start + MINUTE_MS + 4_000, 8, '102', '4'),
    ...tradePair(start + 2 * MINUTE_MS + 1_000, 9, '102', '2'),
    ...tradePair(start + 2 * MINUTE_MS + 2_000, 10, '106', '3'),
    ...tradePair(start + 2 * MINUTE_MS + 3_000, 11, '96', '4'),
    ...tradePair(start + 2 * MINUTE_MS + 4_000, 12, '103', '1'),
  ];
}

function recoveryAnchors(start = START): unknown[] {
  return [
    candle(start, {
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 10,
      quote_volume: 997,
      trade_count: 4,
    }),
    candle(start + 2 * MINUTE_MS, {
      open: 102,
      high: 106,
      low: 96,
      close: 103,
      volume: 10,
      quote_volume: 1_009,
      trade_count: 4,
    }),
  ];
}

describe('OxArchiveHyperliquidProvider', () => {
  it('uses raw authenticated REST pagination and returns exact sorted [start,end) candles', async () => {
    const apiKey = 'test-key-that-must-stay-in-a-header';
    const duplicate = candle(START + MINUTE_MS, { quote_volume: 1_020, trade_count: 12 });
    const fetcher = vi.fn<OxArchiveFetcher>(async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get('cursor') === null) {
        return jsonResponse(page([
          candle(START + 2 * MINUTE_MS),
          duplicate,
          candle(START - MINUTE_MS),
        ], 'opaque-cursor-1'));
      }
      return jsonResponse(page([
        candle(START),
        candle(START + 3 * MINUTE_MS),
      ], null, 'request-2'));
    });
    const provider = new OxArchiveHyperliquidProvider({
      apiKey,
      fetcher,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    const result = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetcher.mock.calls[0]![0]));
    const secondUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(firstUrl.origin + firstUrl.pathname).toBe('https://api.0xarchive.io/v1/hyperliquid/candles/BTC');
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      start: String(START),
      end: String(START + 3 * MINUTE_MS),
      interval: '1m',
      limit: String(OXARCHIVE_CANDLE_PAGE_LIMIT),
    });
    expect(secondUrl.searchParams.get('cursor')).toBe('opaque-cursor-1');
    expect(firstUrl.href).not.toContain(apiKey);
    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get('X-API-Key')).toBe(apiKey);

    expect(result.candles.map((item) => item.openTime)).toEqual([
      START,
      START + MINUTE_MS,
      START + 2 * MINUTE_MS,
    ]);
    expect(result.candles[0]).toMatchObject({
      closeTime: START + MINUTE_MS - 1,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
    });
    expect(result.candles[1]).toMatchObject({ quoteAssetVolume: 1_020, numberOfTrades: 12 });
    expect(result.provenance).toMatchObject({
      provider: '0xArchive',
      venue: 'hyperliquid',
      symbol: 'BTC',
      interval: '1m',
      fetchedAt: '2026-09-18T12:00:00.000Z',
      pages: 2,
      rawRows: 5,
    });
    expect(result.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('recovers a missing 1m candle only from paginated archived trades and records provenance', async () => {
    const apiKey = 'trade-recovery-key';
    const archivedTrades = recoveryTrades();
    const fetcher = vi.fn<OxArchiveFetcher>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/candles/')) {
        return jsonResponse(page(recoveryAnchors(), null, 'candles-request'));
      }
      expect(url.pathname).toBe('/v1/hyperliquid/trades/BTC');
      if (url.searchParams.get('cursor') === null) {
        return jsonResponse(page(archivedTrades.slice(0, 7), 'trade-cursor-1', 'trades-request-1'));
      }
      return jsonResponse(page(archivedTrades.slice(7), null, 'trades-request-2'));
    });
    const provider = new OxArchiveHyperliquidProvider({
      apiKey,
      fetcher,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    const result = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const firstTradeUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(Object.fromEntries(firstTradeUrl.searchParams)).toEqual({
      start: String(START),
      end: String(START + 3 * MINUTE_MS - 1),
      limit: String(OXARCHIVE_TRADE_PAGE_LIMIT),
    });
    expect(firstTradeUrl.href).not.toContain(apiKey);
    expect(result.candles).toHaveLength(3);
    expect(result.candles[1]).toEqual({
      openTime: START + MINUTE_MS,
      open: 102,
      high: 103,
      low: 101,
      close: 102,
      volume: 10,
      closeTime: START + 2 * MINUTE_MS - 1,
      quoteAssetVolume: 1_019,
      numberOfTrades: 4,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0,
    });
    expect(result.provenance).toMatchObject({
      pages: 1,
      rawRows: 2,
      recovery: {
        version: '0xarchive-archived-trades-1m-v2',
        source: '0xArchive archived trades',
        endpoint: '/v1/hyperliquid/trades/BTC',
        coverageFloor: OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR,
        requestedMissingTimestamps: [START + MINUTE_MS],
        recoveredTimestamps: [START + MINUTE_MS],
        noTradeTimestamps: [],
        validatedNativeTimestamps: [START, START + 2 * MINUTE_MS],
        pages: 2,
        rawRows: 24,
        acceptedTrades: 12,
        requestIds: ['trades-request-1', 'trades-request-2'],
      },
    });
    expect(result.provenance.recovery?.tradesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.recovery?.recoveredCandlesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.recovery?.nativeCandlesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.recovery?.ranges).toEqual([
      expect.objectContaining({
        startInclusive: START,
        endExclusive: START + 3 * MINUTE_MS,
        pages: 2,
        rawRows: 24,
        acceptedTrades: 12,
      }),
    ]);
  });

  it('fills a verified no-trade minute with the previous close and zero volume', async () => {
    const archivedTrades = recoveryTrades().filter((row) => {
      const timestamp = Date.parse((row as { timestamp: string }).timestamp);
      return timestamp < START + MINUTE_MS || timestamp >= START + 2 * MINUTE_MS;
    });
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(archivedTrades, null)),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    const result = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    });

    expect(result.candles[1]).toEqual({
      openTime: START + MINUTE_MS,
      open: 102,
      high: 102,
      low: 102,
      close: 102,
      volume: 0,
      closeTime: START + 2 * MINUTE_MS - 1,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0,
    });
    expect(result.provenance.recovery?.noTradeTimestamps).toEqual([START + MINUTE_MS]);
  });

  it('leaves leading no-trade minutes without a previous close out of the result', async () => {
    const start = START + MINUTE_MS;
    const nextAnchor = recoveryAnchors()[1]!;
    const nextAnchorTrades = recoveryTrades().filter((row) => (
      Date.parse((row as { timestamp: string }).timestamp) >= START + 2 * MINUTE_MS
    ));
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page([nextAnchor], null))
        : jsonResponse(page(nextAnchorTrades, null)),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    // Nothing to carry a price from: the minute stays missing. The caller asks a day earlier than it needs, and
    // the server refuses a period whose own minutes are incomplete.
    const result = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: start,
      endExclusive: START + 3 * MINUTE_MS,
    });
    expect(result.candles.map((candle) => candle.openTime)).toEqual([START + 2 * MINUTE_MS]);
  });

  it('fails closed when archived trades disagree with a native validation anchor', async () => {
    const mismatching = recoveryTrades().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
    for (const row of mismatching) {
      if (row.trade_id === 4) row.price = '101';
    }
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(mismatching, null)),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow(`do not match the native 1m candle at ${START}`);
  });

  it('refuses archived-trade recovery before the documented complete coverage floor', async () => {
    const oldStart = Date.parse('2025-03-21T00:00:00.000Z');
    const fetcher = vi.fn<OxArchiveFetcher>(async () => jsonResponse(page(
      recoveryAnchors(oldStart),
      null,
    )));
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: oldStart,
      endExclusive: oldStart + 3 * MINUTE_MS,
    })).rejects.toThrow('documented as incomplete');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails instead of looping when archived trade pagination repeats a cursor', async () => {
    const fetcher = vi.fn<OxArchiveFetcher>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/candles/')) return jsonResponse(page(recoveryAnchors(), null));
      return jsonResponse(page(recoveryTrades(), 'same-trade-cursor'));
    });
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow('archived trade pagination repeated cursor');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails closed when archived trade metadata claims a different row count', async () => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse({
            success: true,
            data: recoveryTrades(),
            meta: { count: recoveryTrades().length + 1, next_cursor: null, request_id: 'bad-count' },
          }),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow('inconsistent archived trade page metadata');
  });

  it('fails closed when archived trade coverage starts after the recovery window', async () => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse({
            ...page(recoveryTrades(), null, 'late-coverage'),
            meta: {
              ...page(recoveryTrades(), null, 'late-coverage').meta,
              coverage_from: new Date(START + MINUTE_MS).toISOString(),
            },
          }),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow('coverage begins after the required recovery range');
  });

  it('fails closed when the two participant rows for a trade conflict', async () => {
    const duplicated = recoveryTrades().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
    duplicated[1]!.price = '101';
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(duplicated, null, 'duplicate-trade-id')),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow('has conflicting participant rows');
  });

  it('fails closed when an archived execution is missing its maker or taker counterpart', async () => {
    const incomplete = recoveryTrades().slice(1);
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(incomplete, null, 'incomplete-participant-pair')),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow('does not contain exactly one maker row and one taker row');
  });

  it('treats the same trade id at different timestamps as distinct executions', async () => {
    const reusedId = recoveryTrades().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
    for (const row of reusedId) {
      if (row.trade_id === 12) row.trade_id = 1;
    }
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(reusedId, null)),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    const result = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    });
    expect(result.provenance.recovery?.acceptedTrades).toBe(12);
  });

  it('fails closed when a missing minute has several possible same-millisecond open prices', async () => {
    const ambiguous = [
      ...recoveryTrades(),
      ...tradePair(START + MINUTE_MS + 1_000, 13, '101', '1'),
    ];
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async (input) => new URL(String(input)).pathname.includes('/candles/')
        ? jsonResponse(page(recoveryAnchors(), null))
        : jsonResponse(page(ambiguous, null)),
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + 3 * MINUTE_MS,
    })).rejects.toThrow(`ambiguous same-millisecond open or close ordering at ${START + MINUTE_MS}`);
  });

  it('fails closed when duplicate timestamps have conflicting normalized values', async () => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse(page([
        candle(START),
        candle(START, { close: 103 }),
      ], null)),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    })).rejects.toThrow(`conflicting candles at ${START}`);
  });

  it('fails closed even when duplicate timestamps have identical values', async () => {
    const row = candle(START);
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse(page([row, row], null)),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    })).rejects.toThrow(`duplicate candles at ${START}`);
  });

  it('hashes normalized candles instead of volatile response metadata', async () => {
    const providerFor = (requestId: string) => new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse(page([candle(START)], null, requestId)),
    });
    const query = {
      symbol: 'BTC',
      interval: '1m' as const,
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    };

    const first = await providerFor('request-a').getCandles(query);
    const second = await providerFor('request-b').getCandles(query);

    expect(first.provenance.sha256).toBe(second.provenance.sha256);
  });

  it.each([
    [{ high: 99 }, 'invalid OHLC'],
    [{ low: 103 }, 'invalid OHLC'],
    [{ volume: -1 }, 'negative candle volume'],
    [{ quote_volume: -1 }, 'negative candle quote volume'],
    [{ trade_count: -1 }, 'invalid candle trade count'],
  ])('rejects invalid candle values: %j', async (overrides, message) => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse(page([candle(START, overrides)], null)),
    });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    })).rejects.toThrow(message);
  });

  it('fails instead of looping when the API repeats an opaque cursor', async () => {
    const fetcher = vi.fn(async () => jsonResponse(page([candle(START)], 'same-cursor')));
    const provider = new OxArchiveHyperliquidProvider({ apiKey: 'secret', fetcher });

    await expect(provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    })).rejects.toThrow('pagination repeated cursor');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429])('reports HTTP %i without leaking the key or response body', async (status) => {
    const apiKey = 'never-print-this-key';
    const responseBody = `server accidentally echoed ${apiKey}`;
    const provider = new OxArchiveHyperliquidProvider({
      apiKey,
      fetcher: async () => new Response(responseBody, { status }),
    });

    const error = await provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(responseBody);
  });

  it('propagates caller abort and does not return a partial result', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetcher: OxArchiveFetcher = async (_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true });
      });
    };
    const provider = new OxArchiveHyperliquidProvider({ apiKey: 'secret', fetcher });
    const pending = provider.getCandles({
      symbol: 'BTC',
      interval: '1m',
      startInclusive: START,
      endExclusive: START + MINUTE_MS,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('normalizes validated instrument metadata and captures request provenance', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        name: 'BTC',
        sz_decimals: 5,
        max_leverage: 50,
        is_active: true,
        instrument_type: 'perp',
      },
      meta: { request_id: 'instrument-request-1' },
    }));
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher,
      clock: () => new Date('2026-09-18T12:01:00.000Z'),
    });

    await expect(provider.getInstrument('BTC')).resolves.toEqual({
      symbol: 'BTC',
      szDecimals: 5,
      maxLeverage: 50,
      isActive: true,
      instrumentType: 'perp',
      provenance: {
        provider: '0xArchive',
        venue: 'hyperliquid',
        requestId: 'instrument-request-1',
        fetchedAt: '2026-09-18T12:01:00.000Z',
      },
    });
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.origin + requested.pathname).toBe('https://api.0xarchive.io/v1/hyperliquid/instruments/BTC');
  });

  it('rejects invalid instrument metadata', async () => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse({
        success: true,
        data: { name: 'BTC', sz_decimals: -1, is_active: true, instrument_type: 'perp' },
        meta: { request_id: 'request-1' },
      }),
    });

    await expect(provider.getInstrument('BTC')).rejects.toThrow('invalid instrument size decimals');
  });

  it('rejects instrument metadata for a different requested symbol', async () => {
    const provider = new OxArchiveHyperliquidProvider({
      apiKey: 'secret',
      fetcher: async () => jsonResponse({
        success: true,
        data: { name: 'ETH', sz_decimals: 4, is_active: true, instrument_type: 'perp' },
        meta: { request_id: 'request-1' },
      }),
    });

    await expect(provider.getInstrument('BTC')).rejects.toThrow('for requested symbol "BTC"');
  });

  it('sanitizes an instrument authentication failure', async () => {
    const apiKey = 'instrument-secret';
    const provider = new OxArchiveHyperliquidProvider({
      apiKey,
      fetcher: async () => new Response(`invalid ${apiKey}`, { status: 401 }),
    });

    const error = await provider.getInstrument('BTC').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain(apiKey);
  });
});
