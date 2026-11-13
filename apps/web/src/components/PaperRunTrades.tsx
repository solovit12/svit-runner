import { useState } from 'react';
import type { PaperExperimentTrades, PaperStrategyPanel, PaperTradeGroup } from '../lib/api';
import { formatDate, pnlClass } from '../lib/format';
import { InfoTooltip } from './TranslatedText';

const GROUPS_SHOWN = 10;

function signed(value: number, digits = 2): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
}

function price(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumSignificantDigits: 7 });
}

function lasted(from: string | null, to: string | null, nowMs: number): string {
  if (!from) return '—';
  const minutes = Math.max(0, Math.round(((to ? Date.parse(to) : nowMs) - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The strategy's own panels (ctx.status): for a pair, how far it still is from its take-profit. */
export function PaperStrategyPanels({ panels }: { panels: readonly PaperStrategyPanel[] | undefined }) {
  if (!panels?.length) return null;
  return <div className="paper-strategy-panels" aria-label="Strategy status">
    {panels.map((panel) => {
      const progress = panel.progress;
      const share = progress ? progress.value / progress.target : 0;
      const filled = Math.max(0, Math.min(1, share));
      // Against the trade: the way to the stop (where it closes at a loss), not lengths of the take-profit.
      const toStop = progress && progress.value < 0 && progress.stop !== undefined
        ? Math.max(0, Math.min(1, progress.value / progress.stop)) : null;
      return <div className="paper-strategy-panel" key={panel.key}>
        <strong>{panel.title}</strong>
        {progress && <>
          <div className="paper-progress" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(filled * 100)}>
            <span className={share < 0 ? 'paper-progress-back' : ''} style={{ width: `${share < 0 ? (toStop ?? 0) * 100 : filled * 100}%` }} />
          </div>
          <p className="paper-progress-text">
            {share < 0
              ? <span>against the trade: <b className="paper-pnl-down">{signed(progress.value, 1)} {progress.unit}</b>{progress.stop !== undefined
                ? <> · stop at {signed(progress.stop, 0)} {progress.unit}: {Math.round((toStop ?? 0) * 100)} % of the way</> : ''} · {progress.label} {progress.target.toFixed(1)} {progress.unit}</span>
              : <span>{progress.label}: <b className={pnlClass(progress.value)}>{signed(progress.value, 1)}</b> of {progress.target.toFixed(1)} {progress.unit} · {Math.round(share * 100)} %</span>}
            {(progress.leftPercent !== undefined || progress.leftUsd !== undefined) && <span>left:
              {progress.leftPercent !== undefined && <b> {progress.leftPercent.toFixed(2)} %</b>}
              {progress.leftUsd !== undefined && <b> ≈ {progress.leftUsd.toFixed(2)} USDC</b>}</span>}
            {progress.usd !== undefined && <span>now <b className={pnlClass(progress.usd)}>{signed(progress.usd)} USDC</b></span>}
          </p>
        </>}
        {panel.lines.length > 0 && <ul>{panel.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
      </div>;
    })}
  </div>;
}

function GroupRows({ group, nowMs }: { group: PaperTradeGroup; nowMs: number }) {
  const pair = group.legs.length > 1;
  return <tbody>
    <tr className="paper-trade-group">
      <td colSpan={9}>
        <strong>{group.name}</strong>
        <span>{pair ? 'pair' : 'position'} · opened {formatDate(group.openedAt)}</span>
        <span>{group.closedAt ? `closed ${formatDate(group.closedAt)}` : <b className="paper-trade-open">open</b>}</span>
        <span>held {lasted(group.openedAt, group.closedAt, nowMs)}</span>
        {group.closedAt !== null && group.realizedPnl !== null && <span>result <b className={pnlClass(group.realizedPnl)}>{signed(group.realizedPnl)} USDC</b></span>}
        {group.fees > 0 && <span>fees <b>{group.fees.toFixed(2)} USDC</b></span>}
      </td>
    </tr>
    {group.legs.map((leg) => <tr key={`${leg.market}:${leg.openedAt}`}>
      <td><strong className={leg.side === 'long' ? 'paper-side-long' : 'paper-side-short'}>{leg.market}</strong></td>
      <td>{leg.side}</td>
      <td>{leg.quantity.toLocaleString(undefined, { maximumSignificantDigits: 8 })}</td>
      <td>{price(leg.entryPrice)}</td>
      <td>{leg.closedAt ? price(leg.exitPrice) : '—'}</td>
      <td>{leg.entryValue.toFixed(2)} USDC</td>
      <td className={pnlClass(leg.realizedPnl)}>{leg.closedAt === null && !leg.realizedPnl ? 'open' : leg.realizedPnl === null ? '—' : `${signed(leg.realizedPnl)} USDC`}</td>
      <td>{leg.fills}</td>
      <td>{leg.closedAt ? formatDate(leg.closedAt) : '—'}</td>
    </tr>)}
  </tbody>;
}

/** Fills grouped by position: each leg from its entry to flat, the legs of one pair together. */
export function PaperTradeGroups({ trades, live = false, nowMs = Date.now() }: {
  trades: PaperExperimentTrades | null; live?: boolean; nowMs?: number;
}) {
  const [shown, setShown] = useState(GROUPS_SHOWN);
  const groups = trades?.groups ?? [];
  const closed = groups.filter((group) => group.closedAt !== null && group.realizedPnl !== null);
  const total = closed.reduce((sum, group) => sum + (group.realizedPnl ?? 0), 0);
  const wins = closed.filter((group) => (group.realizedPnl ?? 0) > 0).length;
  return <section className="paper-activity-panel" aria-labelledby="paper-trade-groups-title">
    <div className="paper-card-title"><div><span className="eyebrow">EXECUTION HISTORY</span>
      <h2 id="paper-trade-groups-title">Trades by position <InfoTooltip label="trades by position"
        en={`Every ${live ? 'real' : 'virtual'} fill belongs to a position of its market, from the first entry until the market is flat again. The legs of one pair (opened within a minute, the pairs of the strategy) are shown together with their sum. Result = realized PnL of the exit fills; fees as charged; funding is not included.`}
        ru={`Каждое ${live ? 'реальное' : 'условное'} исполнение относится к позиции своего рынка — от первого входа до момента, когда позиция снова пуста. Ноги одной пары (открытые в пределах минуты, пары стратегии) показаны вместе и с суммой. Результат — реализованный PnL выходов; комиссии как списаны; funding не входит.`} /></h2>
      <p>{trades === null ? 'Loading…' : closed.length
        ? <>Closed: {closed.length} · wins {wins} · result <b className={pnlClass(total)}>{signed(total)} USDC</b>{trades.truncated ? ' · the oldest are not listed' : ''}</>
        : 'No closed positions yet'}</p></div></div>
    {trades !== null && trades.coverage !== 'durable_journal' && <p className="paper-activity-warning" role="status">
      The run journal could not be read completely; positions may be missing.</p>}
    {groups.length > 0 && <div className="table-wrap"><table className="paper-run-table paper-trade-table">
      <thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Exit</th><th>Value</th><th>Result</th><th>Fills</th><th>Closed</th></tr></thead>
      {groups.slice(0, shown).map((group) => <GroupRows key={group.id} group={group} nowMs={nowMs} />)}
    </table></div>}
    {groups.length > shown && <button type="button" className="paper-text-button paper-events-toggle"
      onClick={() => setShown((value) => value + GROUPS_SHOWN)}>Show {Math.min(GROUPS_SHOWN, groups.length - shown)} more</button>}
  </section>;
}
