import type { BacktestMetrics } from '../../../../packages/shared/src/contracts';

const n = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const metricDefinitions: Array<{ key: keyof BacktestMetrics; en: string; suffix?: string }> = [
  { key: 'totalProfit', en: 'Total PnL', suffix: 'currency' },
  { key: 'totalProfitPercent', en: 'Total PnL', suffix: '%' },
  { key: 'netProfit', en: 'Closed PnL', suffix: 'currency' },
  { key: 'openProfit', en: 'Open PnL', suffix: 'currency' },
  { key: 'maxDrawdown', en: 'Max DD', suffix: 'currency' },
  { key: 'winRatePercent', en: 'Win Rate', suffix: '%' },
  { key: 'profitFactor', en: 'Profit Factor' },
  { key: 'totalTrades', en: 'Trades' },
  { key: 'averageTrade', en: 'Average Trade', suffix: 'currency' },
  { key: 'commissionPaid', en: 'Fees', suffix: 'currency' },
];

/** Money values in the run's currency: USDT on Binance, USDC on Hyperliquid. */
export function Metrics({ metrics, currency = 'USDT' }: { metrics: BacktestMetrics | null; currency?: string }) {
  return (
    <section className="metrics-grid" aria-label="Backtest metrics">
      {metricDefinitions.map(({ key, en, suffix }) => {
        const value = metrics?.[key];
        const negative = typeof value === 'number' && value < 0;
        return (
          <article className="metric" key={String(key)}>
            <span>{en}</span>
            <strong className={negative ? 'negative' : key === 'totalProfit' ? 'positive' : ''}>
              {value == null ? '—' : `${n.format(value)}${suffix === 'currency' ? ` ${currency}` : suffix || ''}`}
            </strong>
          </article>
        );
      })}
    </section>
  );
}
