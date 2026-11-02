import { createHash } from 'node:crypto';
import type { Candle } from '../../shared/src/contracts.js';
import {
  canonicalCandlesSha256,
  MINUTE_MS,
  VOLUME_ABSOLUTE_TOLERANCE,
  VOLUME_RELATIVE_TOLERANCE,
} from './high-detailization.js';
import {
  timeframeToMs,
  type HistoricalCandleRecoveryProvenance,
  type HistoricalInstrumentResult,
  type HistoricalMarketDataProvider,
  type HistoricalMarketDataQuery,
  type HistoricalMarketDataResult,
  type HistoricalTradeRecoveryRangeProvenance,
} from './historical-market-data-provider.js';

export const OXARCHIVE_BASE_URL = 'https://api.0xarchive.io';
export const OXARCHIVE_CANDLE_PAGE_LIMIT = 10_000;
export const OXARCHIVE_TRADE_PAGE_LIMIT = 1_000;
export const OXARCHIVE_TRADE_RECOVERY_MAX_PAGES = 1_000;
export const OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR = '2025-03-22T00:00:00.000Z';

const DEFAULT_TIMEOUT_MS = 30_000;
const OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR_MS = Date.parse(
  OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR,
);
const TRADE_RECOVERY_VERSION = '0xarchive-archived-trades-1m-v2' as const;

export type OxArchiveFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type Clock = () => Date;

export interface OxArchiveHyperliquidProviderOptions {
  /** Inject OXA_API_KEY from the backend environment; this module never reads process.env. */
  apiKey: string;
  fetcher?: OxArchiveFetcher;
  clock?: Clock;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ParsedCandlePage {
  rows: unknown[];
  nextCursor: string | null;
}

interface ParsedInstrumentEnvelope {
  data: Record<string, unknown>;
  requestId: string | null;
}

interface ParsedTradePage {
  rows: unknown[];
  nextCursor: string | null;
  requestId: string | null;
  coverageFrom: number | null;
  notice: string | null;
}

interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

interface ArchivedTrade {
  symbol: string;
  side: 'A' | 'B';
  crossed: boolean;
  timestampMs: number;
  tradeId: number;
  price: number;
  size: number;
  priceDecimal: ExactDecimal;
  sizeDecimal: ExactDecimal;
  canonicalPrice: string;
  canonicalSize: string;
}

interface ReconstructedMinuteCandle {
  candle: Candle;
  openCandidates: number[];
  closeCandidates: number[];
}

interface TradeRecoveryWindow {
  startInclusive: number;
  endExclusive: number;
}

interface LoadedArchivedTrades {
  trades: ArchivedTrade[];
  provenance: HistoricalTradeRecoveryRangeProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`0xArchive returned an invalid candle ${field}.`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number {
  if (value === undefined) return 0;
  const parsed = finiteNumber(value, field);
  if (parsed < 0) throw new Error(`0xArchive returned a negative candle ${field}.`);
  return parsed;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('0xArchive returned an invalid candle timestamp.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error('0xArchive returned an invalid candle timestamp.');
  }
  return timestamp;
}

function parseCandle(value: unknown, intervalMs: number): Candle {
  if (!isRecord(value)) throw new Error('0xArchive returned an invalid candle row.');

  const openTime = parseTimestamp(value.timestamp);
  const open = finiteNumber(value.open, 'open');
  const high = finiteNumber(value.high, 'high');
  const low = finiteNumber(value.low, 'low');
  const close = finiteNumber(value.close, 'close');
  const volume = finiteNumber(value.volume, 'volume');
  const quoteAssetVolume = optionalNonNegativeNumber(value.quote_volume, 'quote volume');
  const rawTradeCount = value.trade_count ?? 0;

  if (!Number.isSafeInteger(rawTradeCount) || (rawTradeCount as number) < 0) {
    throw new Error('0xArchive returned an invalid candle trade count.');
  }
  if (volume < 0) throw new Error('0xArchive returned a negative candle volume.');
  if (low <= 0 || low > high || open < low || open > high || close < low || close > high) {
    throw new Error(`0xArchive returned invalid OHLC values at ${openTime}.`);
  }

  const closeTime = openTime + intervalMs - 1;
  if (!Number.isSafeInteger(closeTime)) {
    throw new Error(`0xArchive returned a candle timestamp outside the safe range at ${openTime}.`);
  }

  return {
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    quoteAssetVolume,
    numberOfTrades: rawTradeCount as number,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function sameCandle(left: Candle, right: Candle): boolean {
  return left.openTime === right.openTime
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.closeTime === right.closeTime
    && left.quoteAssetVolume === right.quoteAssetVolume
    && left.numberOfTrades === right.numberOfTrades
    && left.takerBuyBaseAssetVolume === right.takerBuyBaseAssetVolume
    && left.takerBuyQuoteAssetVolume === right.takerBuyQuoteAssetVolume
    && left.ignore === right.ignore;
}

function parsePositiveDecimal(value: unknown, field: string): {
  decimal: ExactDecimal;
  canonical: string;
  number: number;
} {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 100
    || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`0xArchive returned an invalid archived trade ${field}.`);
  }
  const [rawInteger, rawFraction = ''] = value.split('.');
  const integer = rawInteger!.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > 30) {
    throw new Error(`0xArchive returned an over-precise archived trade ${field}.`);
  }
  const canonical = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  const coefficient = BigInt(integer + fraction);
  if (coefficient <= 0n) {
    throw new Error(`0xArchive returned a non-positive archived trade ${field}.`);
  }
  const numeric = Number(canonical);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`0xArchive returned an invalid archived trade ${field}.`);
  }
  return {
    decimal: { coefficient, scale: fraction.length },
    canonical,
    number: numeric,
  };
}

function decimalAdd(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: left.coefficient * 10n ** BigInt(scale - left.scale)
      + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function decimalMultiply(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

function decimalCompare(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function decimalToCanonical(value: ExactDecimal): string {
  if (value.scale === 0) return value.coefficient.toString();
  const digits = value.coefficient.toString().padStart(value.scale + 1, '0');
  const integer = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, '');
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

function decimalToNumber(value: ExactDecimal, field: string): number {
  const numeric = Number(decimalToCanonical(value));
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`0xArchive archived trade ${field} exceeds the supported numeric range.`);
  }
  return numeric;
}

function parseArchivedTrade(value: unknown, expectedSymbol: string): ArchivedTrade {
  if (!isRecord(value)) throw new Error('0xArchive returned an invalid archived trade row.');
  if (typeof value.symbol !== 'string'
    || typeof value.coin !== 'string'
    || value.symbol.trim().toUpperCase() !== expectedSymbol.toUpperCase()
    || value.coin.trim().toUpperCase() !== expectedSymbol.toUpperCase()) {
    throw new Error('0xArchive returned an archived trade for a different symbol.');
  }
  if (value.side !== 'A' && value.side !== 'B') {
    throw new Error('0xArchive returned an invalid archived trade side.');
  }
  if (typeof value.crossed !== 'boolean') {
    throw new Error('0xArchive returned an invalid archived trade crossed flag.');
  }
  if (typeof value.timestamp !== 'string' || value.timestamp.length === 0) {
    throw new Error('0xArchive returned an invalid archived trade timestamp.');
  }
  const timestampMs = Date.parse(value.timestamp);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new Error('0xArchive returned an invalid archived trade timestamp.');
  }
  if (!Number.isSafeInteger(value.trade_id) || (value.trade_id as number) < 0) {
    throw new Error('0xArchive archived trade recovery requires a safe unique trade_id.');
  }
  const price = parsePositiveDecimal(value.price, 'price');
  const size = parsePositiveDecimal(value.size, 'size');
  return {
    symbol: expectedSymbol,
    side: value.side,
    crossed: value.crossed,
    timestampMs,
    tradeId: value.trade_id as number,
    price: price.number,
    size: size.number,
    priceDecimal: price.decimal,
    sizeDecimal: size.decimal,
    canonicalPrice: price.canonical,
    canonicalSize: size.canonical,
  };
}

function sameExecution(left: ArchivedTrade, right: ArchivedTrade): boolean {
  return left.symbol === right.symbol
    && left.timestampMs === right.timestampMs
    && left.canonicalPrice === right.canonicalPrice
    && left.canonicalSize === right.canonicalSize;
}

function executionKey(trade: ArchivedTrade): string {
  return `${trade.symbol}\u0000${trade.timestampMs}\u0000${trade.tradeId}`;
}

/**
 * The archived-trades endpoint returns the two participant fills for one
 * Hyperliquid execution: one maker row (`crossed=false`) and one taker row
 * (`crossed=true`). A candle must count that execution once, using the taker's
 * side as the public aggressor side. Any incomplete or conflicting pair is
 * unsafe for OHLCV reconstruction and therefore fails closed.
 */
function normalizeArchivedTradeFills(fills: ArchivedTrade[]): ArchivedTrade[] {
  const byExecution = new Map<string, ArchivedTrade[]>();
  for (const fill of fills) {
    const key = executionKey(fill);
    const group = byExecution.get(key) ?? [];
    group.push(fill);
    byExecution.set(key, group);
  }

  const trades: ArchivedTrade[] = [];
  for (const group of byExecution.values()) {
    const tradeId = group[0]!.tradeId;
    const takerRows = group.filter((fill) => fill.crossed);
    const makerRows = group.filter((fill) => !fill.crossed);
    if (group.length !== 2 || takerRows.length !== 1 || makerRows.length !== 1) {
      throw new Error(
        `0xArchive archived trade ${tradeId} does not contain exactly one maker row and one taker row.`,
      );
    }
    const taker = takerRows[0]!;
    const maker = makerRows[0]!;
    if (!sameExecution(taker, maker) || taker.side === maker.side) {
      throw new Error(`0xArchive archived trade ${tradeId} has conflicting participant rows.`);
    }
    trades.push(taker);
  }
  return trades.sort(compareArchivedTrades);
}

function compareArchivedTrades(left: ArchivedTrade, right: ArchivedTrade): number {
  if (left.timestampMs !== right.timestampMs) {
    return left.timestampMs < right.timestampMs ? -1 : 1;
  }
  return left.tradeId < right.tradeId ? -1 : left.tradeId > right.tradeId ? 1 : 0;
}

function canonicalTradesSha256(trades: ArchivedTrade[]): string {
  const hash = createHash('sha256');
  for (const trade of [...trades].sort(compareArchivedTrades)) {
    hash.update([
      trade.symbol,
      trade.timestampMs,
      trade.tradeId,
      trade.side,
      trade.crossed ? 'taker' : 'maker',
      trade.canonicalPrice,
      trade.canonicalSize,
    ].join(',') + '\n');
  }
  return hash.digest('hex');
}

function reconstructMinuteCandles(trades: ArchivedTrade[]): Map<number, ReconstructedMinuteCandle> {
  const tradesByMinute = new Map<number, ArchivedTrade[]>();
  for (const trade of [...trades].sort(compareArchivedTrades)) {
    const openTime = Math.floor(trade.timestampMs / MINUTE_MS) * MINUTE_MS;
    const minuteTrades = tradesByMinute.get(openTime) ?? [];
    minuteTrades.push(trade);
    tradesByMinute.set(openTime, minuteTrades);
  }

  const candles = new Map<number, ReconstructedMinuteCandle>();
  for (const [openTime, minuteTrades] of tradesByMinute) {
    const first = minuteTrades[0]!;
    const last = minuteTrades.at(-1)!;
    const openCandidates = [...new Map(
      minuteTrades
        .filter((trade) => trade.timestampMs === first.timestampMs)
        .map((trade) => [trade.canonicalPrice, trade.price]),
    ).values()];
    const closeCandidates = [...new Map(
      minuteTrades
        .filter((trade) => trade.timestampMs === last.timestampMs)
        .map((trade) => [trade.canonicalPrice, trade.price]),
    ).values()];
    let high = first.priceDecimal;
    let low = first.priceDecimal;
    let volume: ExactDecimal = { coefficient: 0n, scale: 0 };
    let quoteVolume: ExactDecimal = { coefficient: 0n, scale: 0 };
    for (const trade of minuteTrades) {
      if (decimalCompare(trade.priceDecimal, high) > 0) high = trade.priceDecimal;
      if (decimalCompare(trade.priceDecimal, low) < 0) low = trade.priceDecimal;
      volume = decimalAdd(volume, trade.sizeDecimal);
      quoteVolume = decimalAdd(quoteVolume, decimalMultiply(trade.priceDecimal, trade.sizeDecimal));
    }
    candles.set(openTime, {
      candle: {
        openTime,
        open: openCandidates[0]!,
        high: decimalToNumber(high, 'high'),
        low: decimalToNumber(low, 'low'),
        close: closeCandidates[0]!,
        volume: decimalToNumber(volume, 'volume'),
        closeTime: openTime + MINUTE_MS - 1,
        quoteAssetVolume: decimalToNumber(quoteVolume, 'quote volume'),
        numberOfTrades: minuteTrades.length,
        takerBuyBaseAssetVolume: 0,
        takerBuyQuoteAssetVolume: 0,
        ignore: 0,
      },
      openCandidates,
      closeCandidates,
    });
  }
  return candles;
}

function noTradeMinuteCandle(openTime: number, previousClose: number): Candle {
  return {
    openTime,
    open: previousClose,
    high: previousClose,
    low: previousClose,
    close: previousClose,
    volume: 0,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function approximateEqual(left: number, right: number): boolean {
  const tolerance = Math.max(
    VOLUME_ABSOLUTE_TOLERANCE,
    Math.max(Math.abs(left), Math.abs(right)) * VOLUME_RELATIVE_TOLERANCE,
  );
  return Math.abs(left - right) <= tolerance;
}

function assertTradeReconstructionMatchesNative(
  native: Candle,
  reconstructed: ReconstructedMinuteCandle,
): void {
  const mismatches: string[] = [];
  if (!reconstructed.openCandidates.includes(native.open)) mismatches.push('open');
  if (native.high !== reconstructed.candle.high) mismatches.push('high');
  if (native.low !== reconstructed.candle.low) mismatches.push('low');
  if (!reconstructed.closeCandidates.includes(native.close)) mismatches.push('close');
  if (!approximateEqual(native.volume, reconstructed.candle.volume)) mismatches.push('volume');
  if (native.quoteAssetVolume > 0
    && !approximateEqual(native.quoteAssetVolume, reconstructed.candle.quoteAssetVolume)) {
    mismatches.push('quoteAssetVolume');
  }
  if (native.numberOfTrades > 0 && native.numberOfTrades !== reconstructed.candle.numberOfTrades) {
    mismatches.push('numberOfTrades');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `0xArchive archived trades do not match the native 1m candle at ${native.openTime}: ${mismatches.join(', ')}.`,
    );
  }
}

function buildTradeRecoveryWindows(
  missingTimestamps: number[],
  nativeByOpenTime: Map<number, Candle>,
  startInclusive: number,
  endExclusive: number,
): TradeRecoveryWindow[] {
  const gaps: TradeRecoveryWindow[] = [];
  for (const timestamp of missingTimestamps) {
    const previous = gaps.at(-1);
    if (previous && previous.endExclusive === timestamp) {
      previous.endExclusive += MINUTE_MS;
    } else {
      gaps.push({ startInclusive: timestamp, endExclusive: timestamp + MINUTE_MS });
    }
  }

  const expanded = gaps.map((gap) => {
    const previousTimestamp = gap.startInclusive - MINUTE_MS;
    const nextTimestamp = gap.endExclusive;
    const hasPreviousAnchor = previousTimestamp >= startInclusive && nativeByOpenTime.has(previousTimestamp);
    const hasNextAnchor = nextTimestamp < endExclusive && nativeByOpenTime.has(nextTimestamp);
    if (!hasPreviousAnchor && !hasNextAnchor) {
      throw new Error(
        `0xArchive archived trade recovery has no native 1m validation anchor around ${gap.startInclusive}.`,
      );
    }
    return {
      startInclusive: hasPreviousAnchor ? previousTimestamp : gap.startInclusive,
      endExclusive: hasNextAnchor ? nextTimestamp + MINUTE_MS : gap.endExclusive,
    };
  });

  const merged: TradeRecoveryWindow[] = [];
  for (const window of expanded) {
    const previous = merged.at(-1);
    if (previous && window.startInclusive <= previous.endExclusive) {
      previous.endExclusive = Math.max(previous.endExclusive, window.endExclusive);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/** Main perps under /v1/hyperliquid, builder-deployed (HIP-3) markets such as xyz:SP500 under /v1/hyperliquid/hip3. */
function archivePath(kind: 'candles' | 'trades', symbol: string): string {
  return `/v1/hyperliquid${symbol.includes(':') ? '/hip3' : ''}/${kind}/${encodeURIComponent(symbol)}`;
}

function validateSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || symbol.trim().length === 0) {
    throw new Error('A non-empty Hyperliquid symbol is required.');
  }
  return symbol.trim();
}

function parseEnvelope(rawBody: string, expectedData: 'array' | 'object'): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error('0xArchive returned invalid JSON.');
  }
  if (!isRecord(payload) || payload.success !== true) {
    throw new Error('0xArchive returned an unsuccessful or invalid response.');
  }
  if (expectedData === 'array' ? !Array.isArray(payload.data) : !isRecord(payload.data)) {
    throw new Error('0xArchive returned an invalid response payload.');
  }
  if (!isRecord(payload.meta)) {
    throw new Error('0xArchive returned invalid response metadata.');
  }
  return payload;
}

function parseCandlePage(rawBody: string): ParsedCandlePage {
  const payload = parseEnvelope(rawBody, 'array');
  const meta = payload.meta as Record<string, unknown>;
  const rawCursor = meta.next_cursor;
  if (rawCursor !== undefined && rawCursor !== null
    && (typeof rawCursor !== 'string' || rawCursor.length === 0)) {
    throw new Error('0xArchive returned an invalid candle pagination cursor.');
  }
  return {
    rows: payload.data as unknown[],
    nextCursor: rawCursor === undefined || rawCursor === null ? null : rawCursor as string,
  };
}

function parseTradePage(rawBody: string): ParsedTradePage {
  const payload = parseEnvelope(rawBody, 'array');
  const meta = payload.meta as Record<string, unknown>;
  const rows = payload.data as unknown[];
  if (!Number.isSafeInteger(meta.count) || meta.count !== rows.length) {
    throw new Error('0xArchive returned inconsistent archived trade page metadata.');
  }
  const rawCursor = meta.next_cursor;
  if (rawCursor !== undefined && rawCursor !== null
    && (typeof rawCursor !== 'string' || rawCursor.length === 0)) {
    throw new Error('0xArchive returned an invalid archived trade pagination cursor.');
  }
  const rawRequestId = meta.request_id;
  if (rawRequestId !== undefined && rawRequestId !== null
    && (typeof rawRequestId !== 'string' || rawRequestId.length === 0)) {
    throw new Error('0xArchive returned an invalid archived trade request id.');
  }
  const rawCoverageFrom = meta.coverage_from;
  let coverageFrom: number | null = null;
  if (rawCoverageFrom !== undefined && rawCoverageFrom !== null) {
    if (typeof rawCoverageFrom !== 'string' || rawCoverageFrom.length === 0) {
      throw new Error('0xArchive returned invalid archived trade coverage metadata.');
    }
    coverageFrom = Date.parse(rawCoverageFrom);
    if (!Number.isSafeInteger(coverageFrom)) {
      throw new Error('0xArchive returned invalid archived trade coverage metadata.');
    }
  }
  const rawNotice = meta.notice;
  if (rawNotice !== undefined && rawNotice !== null
    && (typeof rawNotice !== 'string' || rawNotice.length === 0)) {
    throw new Error('0xArchive returned invalid archived trade notice metadata.');
  }
  return {
    rows,
    nextCursor: rawCursor === undefined || rawCursor === null ? null : rawCursor as string,
    requestId: rawRequestId === undefined || rawRequestId === null ? null : rawRequestId as string,
    coverageFrom,
    notice: rawNotice === undefined || rawNotice === null ? null : rawNotice as string,
  };
}

function parseInstrumentEnvelope(rawBody: string): ParsedInstrumentEnvelope {
  const payload = parseEnvelope(rawBody, 'object');
  const meta = payload.meta as Record<string, unknown>;
  const rawRequestId = meta.request_id;
  if (rawRequestId !== undefined && rawRequestId !== null
    && (typeof rawRequestId !== 'string' || rawRequestId.length === 0)) {
    throw new Error('0xArchive returned an invalid request id.');
  }
  return {
    data: payload.data as Record<string, unknown>,
    requestId: rawRequestId === undefined || rawRequestId === null ? null : rawRequestId as string,
  };
}

export class OxArchiveHyperliquidProvider implements HistoricalMarketDataProvider {
  readonly #apiKey: string;
  readonly #fetcher: OxArchiveFetcher;
  readonly #clock: Clock;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: OxArchiveHyperliquidProviderOptions);
  constructor(apiKey: string, fetcher?: OxArchiveFetcher, clock?: Clock);
  constructor(
    optionsOrApiKey: OxArchiveHyperliquidProviderOptions | string,
    positionalFetcher: OxArchiveFetcher = globalThis.fetch,
    positionalClock: Clock = () => new Date(),
  ) {
    const options: OxArchiveHyperliquidProviderOptions = typeof optionsOrApiKey === 'string'
      ? { apiKey: optionsOrApiKey, fetcher: positionalFetcher, clock: positionalClock }
      : optionsOrApiKey;
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw new Error('0xArchive API key is required.');
    }
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error('0xArchive request timeout must be a positive integer.');
    }

    this.#apiKey = options.apiKey.trim();
    this.#fetcher = options.fetcher ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#baseUrl = options.baseUrl ?? OXARCHIVE_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    const symbol = validateSymbol(query.symbol);
    if (!Number.isSafeInteger(query.startInclusive)
      || !Number.isSafeInteger(query.endExclusive)
      || query.startInclusive < 0
      || query.startInclusive >= query.endExclusive) {
      throw new Error('Historical candle boundaries must be a non-empty range of Unix milliseconds.');
    }
    query.signal?.throwIfAborted();

    const intervalMs = timeframeToMs(query.interval);
    if (query.interval === '1m'
      && (query.startInclusive % MINUTE_MS !== 0 || query.endExclusive % MINUTE_MS !== 0)) {
      throw new Error('A 1m historical candle range must use complete UTC minute boundaries.');
    }
    const fetchedAt = this.#clock();
    if (!Number.isSafeInteger(fetchedAt.getTime())) {
      throw new Error('Historical market data clock returned an invalid time.');
    }
    const candlesByOpenTime = new Map<number, Candle>();
    let pageCount = 0;
    const seenCursors = new Set<string>();
    let rawRows = 0;
    let cursor: string | null = null;

    do {
      query.signal?.throwIfAborted();
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new Error(`0xArchive candle pagination repeated cursor ${JSON.stringify(cursor)}.`);
        }
        seenCursors.add(cursor);
      }

      const url = new URL(archivePath('candles', symbol), this.#baseUrl);
      url.searchParams.set('start', String(query.startInclusive));
      url.searchParams.set('end', String(query.endExclusive));
      url.searchParams.set('interval', query.interval);
      url.searchParams.set('limit', String(OXARCHIVE_CANDLE_PAGE_LIMIT));
      if (cursor !== null) url.searchParams.set('cursor', cursor);

      const page = parseCandlePage(await this.#request(url, query.signal));
      if (page.nextCursor !== null
        && (page.nextCursor === cursor || seenCursors.has(page.nextCursor))) {
        throw new Error(`0xArchive candle pagination repeated cursor ${JSON.stringify(page.nextCursor)}.`);
      }
      pageCount += 1;
      rawRows += page.rows.length;

      for (const value of page.rows) {
        const candle = parseCandle(value, intervalMs);
        if (candle.openTime < query.startInclusive || candle.openTime >= query.endExclusive) continue;

        const existing = candlesByOpenTime.get(candle.openTime);
        if (existing) {
          const duplicateKind = sameCandle(existing, candle) ? 'duplicate' : 'conflicting';
          throw new Error(`0xArchive returned ${duplicateKind} candles at ${candle.openTime}.`);
        }
        candlesByOpenTime.set(candle.openTime, candle);
      }

      cursor = page.nextCursor;
    } while (cursor !== null);

    const nativeCandles = [...candlesByOpenTime.values()]
      .sort((left, right) => left.openTime - right.openTime);
    const recovered = query.interval === '1m'
      ? await this.#recoverMissingMinuteCandles(
          nativeCandles,
          symbol,
          query.startInclusive,
          query.endExclusive,
          fetchedAt.getTime(),
          query.signal,
        )
      : { candles: nativeCandles, provenance: null };

    return {
      candles: recovered.candles,
      provenance: {
        provider: '0xArchive',
        venue: 'hyperliquid',
        symbol,
        interval: query.interval,
        fetchedAt: fetchedAt.toISOString(),
        pages: pageCount,
        rawRows,
        sha256: canonicalCandlesSha256(recovered.candles),
        recovery: recovered.provenance,
      },
    };
  }

  async #recoverMissingMinuteCandles(
    nativeCandles: Candle[],
    symbol: string,
    startInclusive: number,
    requestedEndExclusive: number,
    fetchedAtMs: number,
    signal?: AbortSignal,
  ): Promise<{ candles: Candle[]; provenance: HistoricalCandleRecoveryProvenance | null }> {
    const completeEndExclusive = Math.min(
      requestedEndExclusive,
      Math.floor(fetchedAtMs / MINUTE_MS) * MINUTE_MS,
    );
    if (completeEndExclusive <= startInclusive) {
      return { candles: nativeCandles, provenance: null };
    }
    const expectedRows = (completeEndExclusive - startInclusive) / MINUTE_MS;
    if (!Number.isSafeInteger(expectedRows) || expectedRows > 1_000_000) {
      throw new Error('The requested 1m recovery range is not safely enumerable.');
    }

    const nativeByOpenTime = new Map(nativeCandles.map((candle) => [candle.openTime, candle]));
    const missingTimestamps: number[] = [];
    for (let timestamp = startInclusive; timestamp < completeEndExclusive; timestamp += MINUTE_MS) {
      if (!nativeByOpenTime.has(timestamp)) missingTimestamps.push(timestamp);
    }
    if (missingTimestamps.length === 0) {
      return { candles: nativeCandles, provenance: null };
    }
    const earliestMissing = missingTimestamps[0]!;
    if (earliestMissing < OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR_MS) {
      throw new Error(
        `0xArchive archived trades before ${OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR} are documented as incomplete; missing 1m candles cannot be recovered safely.`,
      );
    }

    const windows = buildTradeRecoveryWindows(
      missingTimestamps,
      nativeByOpenTime,
      startInclusive,
      completeEndExclusive,
    );
    const loadedRanges: LoadedArchivedTrades[] = [];
    for (const window of windows) {
      signal?.throwIfAborted();
      loadedRanges.push(await this.#loadArchivedTrades(symbol, window, signal));
    }

    const allTrades = loadedRanges.flatMap((range) => range.trades).sort(compareArchivedTrades);
    const seenExecutionKeys = new Set<string>();
    for (const trade of allTrades) {
      const key = executionKey(trade);
      if (seenExecutionKeys.has(key)) {
        throw new Error(`0xArchive archived trade recovery returned duplicate execution ${key}.`);
      }
      seenExecutionKeys.add(key);
    }
    const reconstructedByOpenTime = reconstructMinuteCandles(allTrades);
    const validatedNativeTimestamps: number[] = [];
    for (const window of windows) {
      for (let timestamp = window.startInclusive; timestamp < window.endExclusive; timestamp += MINUTE_MS) {
        const native = nativeByOpenTime.get(timestamp);
        if (!native) continue;
        const reconstructed = reconstructedByOpenTime.get(timestamp);
        if (!reconstructed) {
          throw new Error(
            `0xArchive archived trades are incomplete for native 1m validation anchor ${timestamp}.`,
          );
        }
        assertTradeReconstructionMatchesNative(native, reconstructed);
        validatedNativeTimestamps.push(timestamp);
      }
    }

    const recoveredCandles: Candle[] = [];
    const noTradeTimestamps: number[] = [];
    let leadingWithoutPrice = 0;
    for (const timestamp of missingTimestamps) {
      const reconstructedTradeMinute = reconstructedByOpenTime.get(timestamp);
      if (reconstructedTradeMinute
        && (reconstructedTradeMinute.openCandidates.length !== 1
          || reconstructedTradeMinute.closeCandidates.length !== 1)) {
        throw new Error(
          `0xArchive archived trades have ambiguous same-millisecond open or close ordering at ${timestamp}.`,
        );
      }
      let reconstructed = reconstructedTradeMinute?.candle;
      if (!reconstructed) {
        const previous = nativeByOpenTime.get(timestamp - MINUTE_MS);
        if (previous) {
          reconstructed = noTradeMinuteCandle(timestamp, previous.close);
          noTradeTimestamps.push(timestamp);
        }
      }
      if (!reconstructed && timestamp === startInclusive + leadingWithoutPrice * MINUTE_MS) {
        // Quiet from the start of the asked range: nothing to carry a price from. Left missing.
        leadingWithoutPrice += 1;
        continue;
      }
      if (!reconstructed) {
        throw new Error(
          `0xArchive archived trades do not contain a complete recoverable 1m candle or a safe previous close at ${timestamp}.`,
        );
      }
      nativeByOpenTime.set(timestamp, reconstructed);
      recoveredCandles.push(reconstructed);
    }

    const candles = [...nativeByOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
    for (let index = 0; index < expectedRows - leadingWithoutPrice; index += 1) {
      const expectedTimestamp = startInclusive + (leadingWithoutPrice + index) * MINUTE_MS;
      if (candles[index]?.openTime !== expectedTimestamp) {
        throw new Error(`0xArchive 1m recovery remains incomplete at ${expectedTimestamp}.`);
      }
    }

    const requestIds = [...new Set(loadedRanges.flatMap((range) => range.provenance.requestIds))];
    return {
      candles,
      provenance: {
        version: TRADE_RECOVERY_VERSION,
        source: '0xArchive archived trades',
        endpoint: archivePath('trades', symbol),
        coverageFloor: OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR,
        requestedMissingTimestamps: missingTimestamps,
        recoveredTimestamps: recoveredCandles.map((candle) => candle.openTime),
        noTradeTimestamps,
        validatedNativeTimestamps: [...new Set(validatedNativeTimestamps)].sort((left, right) => left - right),
        pages: loadedRanges.reduce((sum, range) => sum + range.provenance.pages, 0),
        rawRows: loadedRanges.reduce((sum, range) => sum + range.provenance.rawRows, 0),
        acceptedTrades: allTrades.length,
        requestIds,
        tradesSha256: canonicalTradesSha256(allTrades),
        recoveredCandlesSha256: canonicalCandlesSha256(recoveredCandles),
        nativeCandlesSha256: canonicalCandlesSha256(nativeCandles),
        ranges: loadedRanges.map((range) => range.provenance),
      },
    };
  }

  async #loadArchivedTrades(
    symbol: string,
    window: TradeRecoveryWindow,
    signal?: AbortSignal,
  ): Promise<LoadedArchivedTrades> {
    if (window.startInclusive < OXARCHIVE_COMPLETE_TRADE_COVERAGE_FLOOR_MS) {
      throw new Error('0xArchive archived trade recovery range predates complete coverage.');
    }
    const fills: ArchivedTrade[] = [];
    const requestIds: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let rawRows = 0;

    do {
      signal?.throwIfAborted();
      if (pages >= OXARCHIVE_TRADE_RECOVERY_MAX_PAGES) {
        throw new Error('0xArchive archived trade recovery exceeded the bounded page limit.');
      }
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new Error(`0xArchive archived trade pagination repeated cursor ${JSON.stringify(cursor)}.`);
        }
        seenCursors.add(cursor);
      }

      const url = new URL(archivePath('trades', symbol), this.#baseUrl);
      url.searchParams.set('start', String(window.startInclusive));
      // The API documents an end timestamp rather than half-open semantics. Asking
      // through the last millisecond and validating every returned row makes our
      // own [start,end) boundary unambiguous.
      url.searchParams.set('end', String(window.endExclusive - 1));
      url.searchParams.set('limit', String(OXARCHIVE_TRADE_PAGE_LIMIT));
      if (cursor !== null) url.searchParams.set('cursor', cursor);

      const page = parseTradePage(await this.#request(url, signal));
      if (page.notice !== null) {
        throw new Error('0xArchive archived trade response included an advisory; recovery is not complete enough to use.');
      }
      if (page.coverageFrom !== null && page.coverageFrom > window.startInclusive) {
        throw new Error('0xArchive archived trade coverage begins after the required recovery range.');
      }
      if (page.nextCursor !== null
        && (page.nextCursor === cursor || seenCursors.has(page.nextCursor))) {
        throw new Error(
          `0xArchive archived trade pagination repeated cursor ${JSON.stringify(page.nextCursor)}.`,
        );
      }
      pages += 1;
      rawRows += page.rows.length;
      if (page.requestId !== null) requestIds.push(page.requestId);

      for (const value of page.rows) {
        const trade = parseArchivedTrade(value, symbol);
        if (trade.timestampMs < window.startInclusive || trade.timestampMs >= window.endExclusive) {
          throw new Error('0xArchive returned an archived trade outside the requested recovery range.');
        }
        fills.push(trade);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    const trades = normalizeArchivedTradeFills(fills);
    return {
      trades,
      provenance: {
        startInclusive: window.startInclusive,
        endExclusive: window.endExclusive,
        pages,
        rawRows,
        acceptedTrades: trades.length,
        requestIds: [...new Set(requestIds)],
        tradesSha256: canonicalTradesSha256(trades),
      },
    };
  }

  async getInstrument(symbolInput: string, signal?: AbortSignal): Promise<HistoricalInstrumentResult> {
    const requestedSymbol = validateSymbol(symbolInput);
    signal?.throwIfAborted();
    const url = new URL(`/v1/hyperliquid/instruments/${encodeURIComponent(requestedSymbol)}`, this.#baseUrl);
    const parsed = parseInstrumentEnvelope(await this.#request(url, signal));
    const { data } = parsed;

    if (typeof data.name !== 'string' || data.name.length === 0) {
      throw new Error('0xArchive returned an invalid instrument symbol.');
    }
    if (data.name.trim().toUpperCase() !== requestedSymbol.toUpperCase()) {
      throw new Error(
        `0xArchive returned instrument ${JSON.stringify(data.name)} for requested symbol ${JSON.stringify(requestedSymbol)}.`,
      );
    }
    if (!Number.isSafeInteger(data.sz_decimals)
      || (data.sz_decimals as number) < 0
      || (data.sz_decimals as number) > 6) {
      throw new Error('0xArchive returned invalid instrument size decimals.');
    }
    if (typeof data.is_active !== 'boolean') {
      throw new Error('0xArchive returned an invalid instrument active flag.');
    }
    if (data.max_leverage !== undefined && data.max_leverage !== null
      && (!Number.isSafeInteger(data.max_leverage) || (data.max_leverage as number) <= 0)) {
      throw new Error('0xArchive returned invalid instrument maximum leverage.');
    }
    if (data.instrument_type !== undefined && data.instrument_type !== null
      && data.instrument_type !== 'perp' && data.instrument_type !== 'spot') {
      throw new Error('0xArchive returned an invalid instrument type.');
    }

    return {
      symbol: data.name,
      szDecimals: data.sz_decimals as number,
      maxLeverage: data.max_leverage === undefined || data.max_leverage === null
        ? null
        : data.max_leverage as number,
      isActive: data.is_active,
      instrumentType: data.instrument_type === undefined || data.instrument_type === null
        ? null
        : data.instrument_type as 'perp' | 'spot',
      provenance: {
        provider: '0xArchive',
        venue: 'hyperliquid',
        requestId: parsed.requestId,
        fetchedAt: this.#clock().toISOString(),
      },
    };
  }

  async #request(url: URL, signal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.#apiKey,
        },
        signal: requestSignal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      timeoutSignal.throwIfAborted();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new Error('0xArchive market data network request failed.');
    }

    if (!response.ok) {
      if (response.status === 401) throw new Error('0xArchive did not accept the API key (HTTP 401). Check the key saved for Hyperliquid history.');
      let reason = '';
      try {
        const body = JSON.parse(await response.text()) as { error?: unknown };
        if (typeof body.error === 'string') reason = `: ${body.error.replaceAll(this.#apiKey, '***').slice(0, 300)}`;
      } catch {
        // no readable reason
      }
      throw new Error(`0xArchive market data request failed with HTTP ${response.status}${reason}`);
    }

    try {
      return await response.text();
    } catch (error) {
      signal?.throwIfAborted();
      timeoutSignal.throwIfAborted();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new Error('0xArchive market data response could not be read.');
    }
  }
}
