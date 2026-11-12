import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe } from './contracts.js';

/**
 * Where a Hyperliquid backtest takes its history, shared by the form and the server so both allow the same dates.
 * - 0xArchive (with the user's key): minute candles of the plan's window (free plan: the last 30 days), every
 *   timeframe built from them, so "Every minute" checks work on any timeframe.
 * - Hyperliquid's own API (no key): the most recent 5,000 candles of each timeframe, so the depth depends on the
 *   timeframe (15m ≈ 52 days, 1h ≈ 208 days); "Every minute" needs its 1m candles, about the last 3.5 days.
 * One run never mixes the two: their candles differ by a tick now and then.
 */
export const HYPERLIQUID_API_CANDLE_LIMIT = 5_000;
/** Markets offered for Hyperliquid backtests: the main perps and the HIP-3 exchanges XYZ, EntropyIO (io) and Paragon (para). */
export const HYPERLIQUID_BACKTEST_DEXES = ['', 'xyz', 'io', 'para'] as const;
export type HyperliquidBacktestDex = typeof HYPERLIQUID_BACKTEST_DEXES[number];
/** With a full-archive plan: before this day 0xArchive's trades are incomplete, so missing minutes cannot be rebuilt. */
export const OXARCHIVE_FULL_ARCHIVE_FROM = '2025-03-22';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Candles kept in reserve so dates allowed in the browser still hold when the server loads them. */
const API_RESERVE_CANDLES = 10;
/** 0xArchive's age boundary moves every second, and a run looks a few hours back for its first price. */
const OXARCHIVE_RESERVE_MS = 7 * 60 * MINUTE_MS;

/** What the server knows about the saved 0xArchive key; the key itself never leaves the server. */
export interface OxArchiveAccess {
  configured: boolean;
  /** Days of history the key's plan includes; null means the full archive. */
  historyDays: number | null;
}

export interface DataSourcesView {
  oxarchive: OxArchiveAccess & {
    /** When the key was last checked against 0xArchive (ISO), null if never. */
    checkedAt: string | null;
    /** The key comes from the server's environment, so it cannot be changed here. */
    fromEnvironment: boolean;
  };
}

export interface HyperliquidMarketOption {
  /** Name as Hyperliquid writes it: BTC, kPEPE, xyz:SP500. */
  symbol: string;
  dex: HyperliquidBacktestDex;
  maxLeverage: number;
  volume24hUsd: number;
}

export interface HyperliquidMarketList {
  exchange: 'Hyperliquid';
  fetchedAt: string;
  sourceStatus: 'live' | 'cached' | 'stale';
  markets: HyperliquidMarketOption[];
}

export type HyperliquidHistorySource = 'oxarchive' | 'hyperliquid';

export interface HyperliquidHistoryWindow {
  /** Earliest "From" date (UTC, YYYY-MM-DD) for this timeframe and bar detail. */
  earliestStart: string;
  /** Earliest "From" served by 0xArchive; null without a key. */
  oxarchiveFrom: string | null;
  /** Earliest "From" of Hyperliquid's own candles on this timeframe. */
  apiFrom: string;
  /** Earliest "From" of Hyperliquid's own 1m candles, which "Every minute" needs without a key. */
  apiMinuteFrom: string;
}

export interface BilingualText { en: string; ru: string }

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first UTC midnight at or after `ms`. */
function ceilUtcDay(ms: number): string {
  return utcDate(Math.ceil(ms / DAY_MS) * DAY_MS);
}

function apiEarliestOpen(timeframe: BacktestTimeframe, now: number): number {
  const interval = BACKTEST_TIMEFRAME_MS[timeframe];
  return Math.floor(now / interval) * interval - (HYPERLIQUID_API_CANDLE_LIMIT - 1 - API_RESERVE_CANDLES) * interval;
}

function oxarchiveEarliest(access: OxArchiveAccess, now: number): number | null {
  if (!access.configured) return null;
  if (access.historyDays === null) return Date.parse(`${OXARCHIVE_FULL_ARCHIVE_FROM}T00:00:00.000Z`);
  return now - access.historyDays * DAY_MS + OXARCHIVE_RESERVE_MS;
}

/** "Every minute" applies above 1m only; 1m always replays its own candles. */
function needsMinutes(timeframe: BacktestTimeframe, barDetail: 'high' | 'default'): boolean {
  return barDetail === 'high' && timeframe !== '1m';
}

export function hyperliquidHistoryWindow(
  timeframe: BacktestTimeframe,
  barDetail: 'high' | 'default',
  access: OxArchiveAccess,
  now: number,
): HyperliquidHistoryWindow {
  const oxarchive = oxarchiveEarliest(access, now);
  const oxarchiveFrom = oxarchive === null ? null : ceilUtcDay(oxarchive);
  const apiFrom = ceilUtcDay(apiEarliestOpen(timeframe, now));
  const apiMinuteFrom = ceilUtcDay(apiEarliestOpen('1m', now));
  const own = needsMinutes(timeframe, barDetail) ? apiMinuteFrom : apiFrom;
  const earliestStart = oxarchiveFrom !== null && oxarchiveFrom < own ? oxarchiveFrom : own;
  return { earliestStart, oxarchiveFrom, apiFrom, apiMinuteFrom };
}

/**
 * The source of a run starting on `start` (YYYY-MM-DD), or why the date is too early. 0xArchive serves every run
 * inside its window; earlier runs use Hyperliquid's own candles if they reach that far back.
 */
export function hyperliquidHistorySource(
  start: string,
  timeframe: BacktestTimeframe,
  barDetail: 'high' | 'default',
  access: OxArchiveAccess,
  now: number,
): { source: HyperliquidHistorySource } | { error: BilingualText } {
  const window = hyperliquidHistoryWindow(timeframe, barDetail, access, now);
  if (window.oxarchiveFrom !== null && start >= window.oxarchiveFrom) return { source: 'oxarchive' };
  const minutes = needsMinutes(timeframe, barDetail);
  if (start >= (minutes ? window.apiMinuteFrom : window.apiFrom)) return { source: 'hyperliquid' };
  return { error: hyperliquidTooEarlyMessage(timeframe, minutes, window, access) };
}

function hyperliquidTooEarlyMessage(
  timeframe: BacktestTimeframe,
  minutes: boolean,
  window: HyperliquidHistoryWindow,
  access: OxArchiveAccess,
): BilingualText {
  const days = access.historyDays === null ? '' : ` (${access.historyDays} days)`;
  const daysRu = access.historyDays === null ? '' : ` (${access.historyDays} дн.)`;
  if (minutes && window.oxarchiveFrom !== null) {
    return {
      en: `Every-minute checks on Hyperliquid start on ${window.oxarchiveFrom}: that is how far back your 0xArchive plan reaches${days}. For earlier dates set Bar Detail to 4 points per bar: Hyperliquid keeps ${timeframe} candles from ${window.apiFrom}.`,
      ru: `Поминутная проверка на Hyperliquid доступна с ${window.oxarchiveFrom}: столько истории даёт ваш тариф 0xArchive${daysRu}. Для более ранних дат выберите Bar Detail «4 points per bar»: свечи ${timeframe} Hyperliquid хранит с ${window.apiFrom}.`,
    };
  }
  if (minutes) {
    return {
      en: `Every-minute checks on Hyperliquid need minute candles, and Hyperliquid keeps them only from ${window.apiMinuteFrom}. Add a free 0xArchive key for the last 30 days, or set Bar Detail to 4 points per bar: ${timeframe} candles reach back to ${window.apiFrom}.`,
      ru: `Для поминутной проверки на Hyperliquid нужны минутные свечи, а Hyperliquid хранит их только с ${window.apiMinuteFrom}. Добавьте бесплатный ключ 0xArchive — будут последние 30 дней — или выберите Bar Detail «4 points per bar»: свечи ${timeframe} есть с ${window.apiFrom}.`,
    };
  }
  return {
    en: `Hyperliquid keeps the last ${HYPERLIQUID_API_CANDLE_LIMIT.toLocaleString('en-US')} ${timeframe} candles, from ${window.earliestStart}. Choose a later start or a larger timeframe.`,
    ru: `Hyperliquid хранит последние ${HYPERLIQUID_API_CANDLE_LIMIT.toLocaleString('ru-RU')} свечей ${timeframe} — с ${window.earliestStart}. Выберите более позднее начало или больший таймфрейм.`,
  };
}

/** Hyperliquid writes market names as they are listed (kPEPE, xyz:SP500, io:ANTH); the main perps and HYPERLIQUID_BACKTEST_DEXES. */
export const HYPERLIQUID_SYMBOL = /^(?:(?:xyz|io|para):)?[A-Za-z0-9]{1,24}$/;
