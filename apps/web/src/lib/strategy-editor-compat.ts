import { HYPERLIQUID_SYMBOL } from '../../../../packages/shared/src/hyperliquid-history';
import type { StrategyBacktestSettings } from '../../../../packages/shared/src/strategy-catalog-contracts';

const EDITOR_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);

export function backtestSettingsSupportedByEditor(settings: StrategyBacktestSettings): boolean {
  const market = settings.exchange === 'Binance'
    ? /^[A-Z0-9]+USDT$/.test(settings.symbol) && (settings.baseCurrency === undefined || settings.baseCurrency === 'USDT')
    : HYPERLIQUID_SYMBOL.test(settings.symbol) && (settings.baseCurrency === undefined || settings.baseCurrency === 'USDC');
  return market
    && settings.marketType === 'Perpetual'
    && EDITOR_TIMEFRAMES.has(settings.timeframe)
    && settings.barIndexOffset === 0
    && settings.feeModel === 'manual'
    && settings.commissionType === 'percent'
    && (settings.barDetailization !== 'high' || settings.timeframe !== '1m')
    && settings.calcOnOrderFills === false
    && settings.calcOnEveryTick === false
    && settings.calcOnEveryHistoryTick === false
    && settings.limitOrderVerificationTicks === 0;
}
