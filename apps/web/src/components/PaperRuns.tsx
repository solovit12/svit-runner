import { AlertTriangle, ArrowLeft, ArrowRight, Clock3, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  deletePaperExperiment, listPaperExperiments, loadLiveAccounts, loadPaperCapabilities, loadPaperExperiment, loadPaperExperimentActivity,
  loadPaperExperimentTrades, stopPaperExperiment,
  type PaperCapabilities, type PaperExperimentActivity, type PaperExperimentDetail, type PaperExperimentStatus,
  type PaperExperimentSummary, type PaperExperimentTrades,
} from '../lib/api';
import { PaperStrategyPanels, PaperTradeGroups } from './PaperRunTrades';
import { formatDate, pnlClass } from '../lib/format';
import { runIdFromPath, runPath } from '../lib/run-paths';
import { NativeRunNotice } from './NativeRunNotice';
import { InfoTooltip } from './TranslatedText';
import { XyzHoursNotice } from './XyzHoursNotice';
import { isXyzMarket } from '../lib/stock-hours';
import type { PaperExperimentRuntimeView, PaperRunTradeStats } from '../../../../packages/shared/src/paper-experiment-contracts';

const statusLabel: Record<PaperExperimentStatus, string> = {
  preparing: 'Preparing',
  waiting_for_data: 'Waiting for data',
  warming_up: 'Warming up',
  running: 'Running',
  recovering: 'Running · data gap',
  stopping: 'Stopping',
  completed: 'Completed',
  interrupted: 'Interrupted',
};

const FILLS_PER_PAGE = 20;
const EVENTS_COLLAPSED = 5;

function signedNumber(value: number, digits = 2): string {
  const text = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}`;
}

function percent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '—';
}

/** A stopped Live run: whether every position is closed on its exchanges, from the engine's own outcome. */
export function LiveStopOutcome({ detail }: { detail: Pick<PaperExperimentDetail, 'live' | 'status' | 'reason'>
  & Partial<Pick<PaperExperimentDetail, 'tracks'>> }) {
  if (!detail.live || !['completed', 'interrupted'].includes(detail.status) || !detail.reason) return null;
  const outcome = detail.reason.match(/LIVE: (every position of this run is closed|positions still open|the engine did not confirm)[^]*$/)?.[0];
  if (!outcome) return null;
  if (outcome.startsWith('LIVE: every position')) {
    return <div className="paper-live-outcome paper-live-outcome-closed" role="status"><ShieldCheck size={18} />
      <div><strong>Every position of this run is closed on {liveExchangesOf(detail)}.</strong></div></div>;
  }
  return <div className="paper-live-outcome paper-live-outcome-open" role="alert"><AlertTriangle size={18} />
    <div><strong>Positions may still be open on {liveExchangesOf(detail)}.</strong><span> {outcome.replace(/^LIVE: /, '')}</span></div></div>;
}

/** The exchanges a Live run trades on, as its messages name them ("Lighter", "Lighter and Hyperliquid"). */
function liveExchangesOf(detail: Partial<Pick<PaperExperimentDetail, 'tracks'>>): string {
  return exchangeNames((detail.tracks ?? []).map((track) => track.venue));
}

function exchangeNames(venues: readonly string[] | undefined): string {
  return [...new Set(venues ?? [])].sort((a, b) => (a === 'Lighter' ? -1 : b === 'Lighter' ? 1 : 0)).join(' and ') || 'Lighter';
}

/** The run a Stop button asks about. */
export interface StopTarget {
  readonly id: string;
  readonly strategyName: string;
  readonly live: boolean;
  readonly exchanges: string;
}

function stopTargetOf(run: PaperExperimentSummary): StopTarget {
  return { id: run.id, strategyName: run.strategyName, live: Boolean(run.live), exchanges: exchangeNames(run.venues) };
}

function canStopRun(status: PaperExperimentStatus): boolean {
  return !['completed', 'interrupted'].includes(status);
}

/**
 * Order of the runs list: running LIVE runs first, then running Paper runs, each newest start
 * first; then the finished runs in the server's order (newest launch first). Finished LIVE runs
 * stay among the finished ones (more than 20 on the server); their red tint marks them.
 */
export function runListOrder(runs: readonly PaperExperimentSummary[]): PaperExperimentSummary[] {
  const group = (run: PaperExperimentSummary) => canStopRun(run.status) ? (run.live ? 0 : 1) : 2;
  const started = (run: PaperExperimentSummary) => Date.parse(run.startedAt ?? run.createdAt) || 0;
  return runs.map((run, index) => ({ run, index })).sort((left, right) => group(left.run) - group(right.run)
    || (group(left.run) < 2 ? started(right.run) - started(left.run) : 0)
    || left.index - right.index).map(({ run }) => run);
}

/** "Are you sure?" before a run is stopped, from the runs list or a run page. */
export function StopRunDialog({ run, busy, onCancel, onConfirm }: {
  run: StopTarget;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return <div className="strategy-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="strategy-dialog paper-stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="paper-stop-title" aria-describedby="paper-stop-text">
      <header className="strategy-dialog-heading"><h3 id="paper-stop-title">{run.live ? 'Stop this LIVE run?' : 'Stop this run?'}</h3></header>
      <div className="paper-stop-dialog-body">
        <p id="paper-stop-text">Are you sure you want to stop <strong>{run.strategyName}</strong>?</p>
        <p className="paper-stop-dialog-id">Run {run.id}</p>
        <p>{run.live
          ? <>Every open position of this run is closed at market on {run.exchanges}. Real money.</>
          : <>The run ends and cannot be continued. Its trades and results stay in the history.</>}</p>
        <div className="strategy-dialog-actions">
          <button type="button" autoFocus onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="paper-stop-confirm" onClick={onConfirm} disabled={busy}>{busy ? 'Stopping…' : run.live ? 'Yes, stop and close all' : 'Yes, stop'}</button>
        </div>
      </div>
    </section>
  </div>;
}

/** "Are you sure?" before a finished run and all its data are deleted from the server. */
export function DeleteRunDialog({ run, busy, onCancel, onConfirm }: {
  run: StopTarget;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return <div className="strategy-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="strategy-dialog paper-stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="paper-delete-title" aria-describedby="paper-delete-text">
      <header className="strategy-dialog-heading"><h3 id="paper-delete-title">{run.live ? 'Delete this LIVE run?' : 'Delete this run?'}</h3></header>
      <div className="paper-stop-dialog-body">
        <p id="paper-delete-text">Are you sure you want to delete <strong>{run.strategyName}</strong>?</p>
        <p className="paper-stop-dialog-id">Run {run.id}</p>
        <p>Its trades, events, results and journal are deleted from the server for good. This cannot be undone.</p>
        {run.live && <p>The real trades stay in your {run.exchanges} account history; only this server's record goes.</p>}
        <div className="strategy-dialog-actions">
          <button type="button" autoFocus onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="paper-stop-confirm" onClick={onConfirm} disabled={busy}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
        </div>
      </div>
    </section>
  </div>;
}

/** What this run trades and under which rules: markets, money, fees, strategy parameters, execution. */
export function PaperRunRules({ detail, inOverview = false }: { detail: PaperExperimentDetail; inOverview?: boolean }) {
  const settings = detail.settings as unknown as Record<string, unknown>;
  const fee = (venue: 'lighter' | 'hyperliquid', kind: 'Maker' | 'Taker') =>
    settings[`${venue}${kind}FeePercent`] ?? settings[`${venue}FeePercent`];
  const venues = [...new Set(detail.tracks.map((track) => track.venue))];
  const params = settings.params && typeof settings.params === 'object' ? Object.entries(settings.params as Record<string, unknown>) : [];
  const size = settings.orderSizePercent ?? settings.orderSizePercentOfRealizedEquity;
  const capital = settings.capitalPerVenue ?? settings.capitalPerTrack;
  const Wrapper = inOverview ? 'div' : 'section';
  return <Wrapper className={inOverview ? 'paper-rules-block' : 'paper-activity-panel'} aria-labelledby="paper-rules-title">
    {inOverview
      ? <h3 id="paper-rules-title">How this run trades</h3>
      : <div className="paper-card-title"><div><span className="eyebrow">RULES</span><h2 id="paper-rules-title">How this run trades</h2></div></div>}
    <div className="table-wrap"><table className="paper-run-table paper-rules-table">
      <thead><tr><th>Exchange</th><th>Markets</th><th>Start balance</th><th>Maker fee</th><th>Taker fee</th></tr></thead>
      <tbody>{venues.map((venue) => {
        const key = venue === 'Lighter' ? 'lighter' : 'hyperliquid';
        const maker = fee(key, 'Maker');
        return <tr key={venue}><td><strong>{venue}</strong></td><td>{detail.tracks.filter((track) => track.venue === venue).map((track) => track.market).join(', ')}</td>
          <td>{detail.live ? `real ${venue} balance` : typeof capital === 'number' ? `${capital.toLocaleString()} USDC` : '—'}</td>
          <td>{settings[`${key}MakerFeePercent`] === undefined ? 'same as taker' : percent(maker)}</td><td>{percent(fee(key, 'Taker'))}</td></tr>;
      })}</tbody>
    </table></div>
    <ul className="paper-rules-list">
      <li><span>Order size</span> {detail.live && (settings.live as { minimumOrderSize?: boolean } | undefined)?.minimumOrderSize
        ? "each entry is the market's minimum order on its exchange plus 15%" : typeof size === 'number' ? `${size}% of the exchange balance per entry` : '—'}</li>
      <li><span>Bars</span> {detail.settings.timeframe} candles of each exchange</li>
      {params.length > 0 && <li><span>Strategy parameters</span> {params.map(([name, value]) => `${name} = ${String(value)}`).join(' · ')}</li>}
      {detail.live && <li><span>LIVE limits</span> {(() => {
        const live = settings.live as { dailyLossLimitPercent?: number; maxLeverage: number; exchangeStopPercent: number;
          exchangeStopFrom: 'strategy_stop' | 'entry_price'; maxSlippagePercent?: number; maxPositionUsdc?: number };
        return `${liveExchangesOf(detail)} mainnet, limits on each exchange; exchange-side stop ${live.exchangeStopPercent}% beyond the ${live.exchangeStopFrom === 'entry_price'
          ? 'entry price' : "strategy's stop (entry price if none)"}; max slippage ${live.maxSlippagePercent ?? 3}%; daily loss limit ${live.dailyLossLimitPercent === undefined ? 'off' : `${live.dailyLossLimitPercent}% of the day's starting equity (day from 06:00 UTC)`}; account leverage at most ${live.maxLeverage}x; max position ${live.maxPositionUsdc === undefined ? 'off' : `${live.maxPositionUsdc} USDC per market`}`;
      })()}</li>}
      {detail.live
        ? <li><span>Execution</span> real orders on {liveExchangesOf(detail)}, sent at once with no modeled delay; take-profits and stops are held by the engine and sent when the price reaches them, and each open position also has a reduce-only stop on its exchange; positions are compared with each exchange account every 10 s. A problem on one exchange stops only that exchange. Stop closes every position at market. Real money.</li>
        : <li><span>Execution</span> market orders 200 ms after the decision; limit orders when the price reaches them; stops and stop-losses trigger on the live best price and execute 300 ms later; partial fills are real. Every Paper order takes liquidity from the order book, so the taker fee is charged on every fill (the maker fee is listed for reference). Funding is not counted. Virtual money only.</li>}
    </ul>
  </Wrapper>;
}

/** The two facts an observer needs about the machinery: are prices live, and are orders working. */
export function PaperRunHealth({ detail }: { detail: PaperExperimentDetail }) {
  const tracks = detail.runtime?.tracks ?? [];
  if (!detail.runtime || ['completed', 'interrupted'].includes(detail.status)) return null;
  const stale = tracks.filter((track) => !track.priceReady);
  const working = tracks.reduce((sum, track) => sum + track.pendingOrders, 0);
  return <>
    <div><span>Live prices</span><strong className={stale.length ? 'paper-pnl-down' : 'paper-pnl-up'} title={stale.map((track) => `${track.venue} ${track.market}`).join(', ')}>{tracks.length ? (stale.length ? `${tracks.length - stale.length} of ${tracks.length} markets — waiting: ${stale.map((track) => `${track.venue} ${track.market}`).join(', ')}` : `All ${tracks.length} markets`) : 'Not reported'}</strong></div>
    <div><span>Working orders</span><strong>{working}</strong></div>
  </>;
}

/** Open positions by exchange, with each exchange's balance and PnL as its group row. */
type DataGapTrack = NonNullable<PaperExperimentRuntimeView['tracks']>[number] & { dataGap: NonNullable<NonNullable<PaperExperimentRuntimeView['tracks']>[number]['dataGap']> };

/** Markets of a live run that wait for fresh exchange data after a gap. */
function dataGapTracks(detail: PaperExperimentDetail): DataGapTrack[] {
  if (!detail.runtime || ['completed', 'interrupted'].includes(detail.status)) return [];
  return (detail.runtime.tracks ?? []).filter((track): track is DataGapTrack => track.dataGap !== undefined);
}

function minutesSince(ms: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  return minutes < 1 ? 'under a minute' : minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Shown above the portfolio only while some markets have no fresh data; the others keep trading. */
export function PaperRunDataGaps({ detail, nowMs = Date.now() }: { detail: PaperExperimentDetail; nowMs?: number }) {
  const gaps = dataGapTracks(detail);
  if (gaps.length === 0) return null;
  const positions = new Set((detail.runtime?.accounts ?? []).flatMap((account) =>
    account.positions.map((position) => `${account.venue}:${position.market}`)));
  return <section className="paper-data-gaps" role="status" aria-labelledby="paper-data-gaps-title">
    <AlertTriangle size={18} />
    <div>
      <strong id="paper-data-gaps-title">No fresh market data · {gaps.length} {gaps.length === 1 ? 'market' : 'markets'} <InfoTooltip label="markets without fresh data" en="After a lost connection a market resumes only with a fresh complete order book from its exchange. Until then it places no orders, and exits of its open position wait. Once the connection is back, the order book is requested again after 10 s, 30 s and 1 min, then every 5 minutes. Other markets are not paused." ru="После обрыва рынок продолжает торговлю только со свежим полным стаканом от биржи. До этого он не выставляет заявки, а выходы из его открытой позиции ждут. Когда связь вернулась, стакан запрашивается заново через 10 с, 30 с, 1 мин, далее раз в 5 минут. Остальные рынки не останавливаются." /></strong>
      <ul>{gaps.map((track) => <li key={`${track.venue}:${track.market}`}>
        <b>{track.venue} {track.market}</b> — {minutesSince(track.dataGap.sinceMs, nowMs)} without data · {track.dataGap.connected
          ? `connection restored; order book requested again${track.dataGap.resubscribes ? ` ${track.dataGap.resubscribes} ${track.dataGap.resubscribes === 1 ? 'time' : 'times'}` : ''}`
          : `waiting for ${track.venue} to reconnect`}{positions.has(`${track.venue}:${track.market}`) ? ' · open position: its exits wait for data' : ''}
      </li>)}</ul>
      <small>Other markets keep trading. A market resumes by itself as soon as its exchange sends a fresh order book.</small>
    </div>
  </section>;
}

export function PaperPositionsTable({ detail, accountNames = {} }: {
  detail: PaperExperimentDetail;
  /** LIVE account id -> its name (Accounts page), to name the account each exchange trades. */
  accountNames?: Readonly<Record<string, string>>;
}) {
  const waiting = new Set(dataGapTracks(detail).map((track) => `${track.venue}:${track.market}`));
  const runtime = detail.runtime;
  if (!runtime) return <section className="paper-activity-panel"><div className="paper-card-title"><div><span className="eyebrow">PORTFOLIO</span><h2>Open positions</h2></div></div><p className="paper-activity-empty">No account snapshot yet.</p></section>;
  // A Live run trades the real account of each of its exchanges; its start balance is not the virtual one.
  const live = Boolean(detail.live);
  const groups = detail.accounts.filter((account) => !live || detail.tracks.some((track) => track.venue === account.venue)).map((account) => {
    const observed = runtime.accounts.find((entry) => entry.venue === account.venue && entry.accountId === account.accountId);
    const cash = Number(observed?.cashBalance ?? account.startingCash);
    const positions = observed?.positions ?? [];
    const unrealized = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl ?? 0), 0);
    const equity = cash + unrealized;
    // Live: from the real balance at the start; older Live runs did not record it.
    const start = live ? (observed?.startBalance === undefined ? null : Number(observed.startBalance)) : account.startingCash;
    const realized = start === null ? null : cash - start;
    const total = start === null ? null : equity - start;
    return { account, positions, cash, unrealized, equity, realized, total, start, halted: live ? observed?.halted : undefined };
  });
  return <section className="paper-activity-panel" aria-labelledby="paper-positions-title">
    <div className="paper-card-title"><div><span className="eyebrow">PORTFOLIO</span><h2 id="paper-positions-title">Open positions <InfoTooltip label="open positions" en="Virtual positions at the last account snapshot (refreshed every few seconds while positions are open). UPNL uses the mid price and excludes the exit fee. Realized PnL is the change of the exchange balance (closed trades and all fees); Total adds the open positions. Leverage is position value divided by the exchange equity: Paper positions use the account's own cash, so there is no liquidation price." ru="Виртуальные позиции по последнему снимку счёта (обновляется каждые несколько секунд, пока позиции открыты). UPNL считается по средней цене и без комиссии выхода. Реализованный PnL — изменение баланса биржи (закрытые сделки и все комиссии); Итого добавляет открытые позиции. Плечо — стоимость позиции, делённая на капитал биржи: в Paper позиции открываются на собственные средства счёта, поэтому цены ликвидации нет." /></h2><p>Updated {formatDate(runtime.observedAt)}</p></div></div>
    <div className="table-wrap"><table className="paper-run-table paper-positions-table">
      <thead><tr><th>Exchange</th><th>Symbol</th><th>UPNL</th><th>Avg entry</th><th>Mark</th><th>Leverage</th><th>Size</th><th>Opened</th></tr></thead>
      {groups.map(({ account, positions, cash, unrealized, equity, realized, total, start, halted }) => <tbody key={account.accountId}>
        <tr className="paper-positions-venue"><td colSpan={8}>
          <strong>{account.venue}</strong>
          <span>Balance <b>{cash.toLocaleString(undefined, { maximumFractionDigits: 2 })} {account.currency}</b></span>
          {realized !== null && <span>Realized <b className={pnlClass(realized)}>{signedNumber(realized)}</b></span>}
          <span>Unrealized <b className={pnlClass(unrealized)}>{signedNumber(unrealized)}</b></span>
          {total !== null && start !== null && <span>Total PnL <b className={pnlClass(total)}>{signedNumber(total)} ({signedNumber(start ? total / start * 100 : 0)}%)</b></span>}
          {live && <span className="paper-live-badge">LIVE — real {account.venue} account{(() => {
            const id = (detail.settings as { live?: { accounts?: Record<string, string> } } | undefined)?.live?.accounts?.[account.venue.toLowerCase()];
            return id && accountNames[id] ? ` “${accountNames[id]}”` : '';
          })()}</span>}
          {halted && <span className="paper-live-halted" role="status" title={halted}>Stopped: {halted}</span>}
        </td></tr>
        {positions.length === 0
          ? <tr><td colSpan={8} className="paper-positions-none">No open positions</td></tr>
          : positions.map((position) => {
            const size = Number(position.remainingBaseQuantity);
            const mark = position.markPrice === undefined ? null : Number(position.markPrice);
            const upnl = position.unrealizedPnl === undefined ? null : Number(position.unrealizedPnl);
            const leverage = mark !== null && equity > 0 ? size * mark / equity : null;
            return <tr key={`${position.market}:${position.side}`}>
              <td>{account.venue}</td>
              <td><strong className={position.side === 'long' ? 'paper-side-long' : 'paper-side-short'} title={position.side === 'long' ? 'Long' : 'Short'}>{position.market}</strong>{waiting.has(`${account.venue}:${position.market}`) && <small className="paper-gap-tag" title="No fresh market data: exits of this position wait">no data</small>}</td>
              <td className={upnl === null ? '' : pnlClass(upnl)}>{upnl === null ? '—' : `${signedNumber(upnl)} ${account.currency}`}</td>
              <td>{position.avgEntryPrice ?? '—'}</td>
              <td>{position.markPrice ?? '—'}</td>
              <td>{leverage === null ? '—' : `${leverage.toFixed(2)}x`}</td>
              <td>{position.remainingBaseQuantity}</td>
              <td>{formatDate(position.openedAt ?? null)}</td>
            </tr>;
          })}
      </tbody>)}
    </table></div>
    {!['completed', 'interrupted'].includes(detail.status) && <PaperStrategyPanels panels={runtime.panels} />}
  </section>;
}

export function PaperRunTrackTable({ detail }: { detail: PaperExperimentDetail }) {
  return <div className="table-wrap"><table className="paper-run-table"><thead><tr><th>Exchange</th><th>Market</th><th>Shared account</th><th>Status</th><th>Price readiness</th><th>Pending orders</th><th>Last control update</th><th>Public frames</th><th>Signals</th><th>Order intents</th><th>Fills</th></tr></thead><tbody>{detail.tracks.map(track => {
    const observed = detail.runtime?.tracks?.find(row => row.venue === track.venue && row.market === track.market)
      ?? (detail.tracks.filter(row => row.venue === track.venue).length === 1
        ? detail.runtime?.accounts.find(row => row.accountId === track.accountId && row.runId === track.runId) : undefined);
    return <tr key={track.trackId}><td>{track.venue}</td><td>{track.market}</td><td title={track.accountId}>{track.accountId.slice(0, 12)}…</td><td><strong>{statusLabel[track.status]}</strong></td><td>{observed?.priceReady === undefined ? 'Not reported' : observed.priceReady ? 'Ready' : 'Waiting for fresh price'}</td><td>{observed?.pendingOrders ?? '—'}</td><td>{formatDate(track.updatedAt)}</td><td>{track.events}</td><td>{track.signals}</td><td>{track.intents}</td><td>{track.fills}</td></tr>;
  })}</tbody></table></div>;
}

/** Do not infer an engine for historical runs whose owner never reported one. */
export function PaperRunEngineLabel({ engine, live = false, exchanges = 'Lighter' }: {
  engine?: PaperExperimentRuntimeView['engine']; live?: boolean; exchanges?: string;
}) {
  if (engine !== 'nautilus') return null;
  if (live) return <div><span>Engine <InfoTooltip label="Live execution engine" en={`Nautilus sends this run's real orders to your ${exchanges} account and reads the real balance and positions.`} ru={`Nautilus отправляет настоящие заявки этого прогона на ваш счёт ${exchanges} и читает настоящие баланс и позиции.`} /></span><strong>Nautilus · LIVE on {exchanges}</strong></div>;
  return <div><span>Paper engine <InfoTooltip label="Paper execution engine" en="Nautilus Sandbox simulates orders and keeps the virtual account for this run. It does not place real exchange orders. The saved Pine code remains a historical backtest reference; funding is excluded." ru="Nautilus Sandbox моделирует заявки и ведёт виртуальный счёт этого прогона. Реальные заявки на биржу не отправляются. Сохранённый Pine-код остаётся историческим ориентиром бэктеста; funding не учитывается." /></span><strong>Nautilus Sandbox</strong></div>;
}

function formatDuration(item: PaperExperimentSummary): string {
  if (!item.startedAt || (!item.endedAt && ['completed', 'interrupted'].includes(item.status))) return '—';
  const elapsed = Math.max(0, Date.parse(item.endedAt ?? new Date().toISOString()) - Date.parse(item.startedAt));
  if (!Number.isFinite(elapsed)) return '—';
  const minutes = Math.floor(elapsed / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainingMinutes}m` : `${minutes}m`;
}

function visibleStatus(item: PaperExperimentSummary): string {
  return item.status === 'stopping' && /^(Paper runtime stop failed:|Cannot confirm failed-start cleanup:)/.test(item.reason ?? '')
    ? 'Stop needs attention'
    : statusLabel[item.status];
}

function marketNames(markets: readonly string[] | undefined): string {
  if (!markets?.length) return '—';
  return markets.length <= 3 ? markets.join(', ') : `${markets.slice(0, 3).join(', ')} +${markets.length - 3}`;
}

function idFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  return runIdFromPath(window.location.pathname);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function paramsCell(params: PaperExperimentSummary['params']) {
  const entries = Object.entries(params ?? {});
  if (!entries.length) return '—';
  return <span className="paper-history-params">{entries.map(([name, value]) => <span key={name}>{name} = {String(value)}</span>)}</span>;
}

/** One column of the runs list; Actions is not one of them (it never collapses). */
interface HistoryColumn {
  readonly key: string;
  readonly title: string;
  readonly tip?: ReactNode;
  readonly className?: string;
  readonly cell: (item: PaperExperimentSummary) => ReactNode;
}

/** Collapsed columns of the runs list, remembered in this browser only (a screen recording hides them). */
export const COLLAPSED_COLUMNS_KEY = 'psr.runs.collapsedColumns.v1';

function readCollapsedColumns(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(COLLAPSED_COLUMNS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsedColumns(keys: readonly string[]): void {
  try { globalThis.localStorage?.setItem(COLLAPSED_COLUMNS_KEY, JSON.stringify(keys)); } catch { /* a convenience only */ }
}

/** "≈" when the oldest fills of a very long run were left out or a position has no realized PnL. */
function approx(stats: PaperRunTradeStats): string {
  return stats.partial ? '≈' : '';
}

export function closedPositionsText(stats: PaperRunTradeStats | undefined): string {
  return stats ? `${approx(stats)}${stats.closed}` : '—';
}

export function winRateText(stats: PaperRunTradeStats | undefined): string {
  if (!stats || stats.closed === 0) return '—';
  return `${approx(stats)}${(stats.wins / stats.closed * 100).toFixed(1)}%`;
}

export function profitFactorText(stats: PaperRunTradeStats | undefined): string {
  if (!stats || stats.closed === 0) return '—';
  if (stats.grossLoss <= 0) return stats.grossProfit > 0 ? '∞' : '—';
  return `${approx(stats)}${(stats.grossProfit / stats.grossLoss).toFixed(2)}`;
}

/** Each exchange's account now (balance plus open positions); a Paper run with no snapshot yet still has its start. */
function balanceCell(item: PaperExperimentSummary): ReactNode {
  const usdc = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  const rows = (item.pnl ?? []).filter((row) => row.balance !== undefined);
  if (rows.length) {
    return rows.map((row) => <div key={row.venue}><span>{row.venue}</span> {row.balance === null || row.balance === undefined ? '—' : usdc(row.balance)}</div>);
  }
  if (item.live) return '—';
  if (item.capitalPerVenue == null) return '—';
  const venues = item.venues ?? [];
  return venues.length > 1
    ? venues.map((venue) => <div key={venue}><span>{venue}</span> {usdc(item.capitalPerVenue!)}</div>)
    : usdc(item.capitalPerVenue);
}

const PARTIAL_TITLE = 'The oldest fills of a very long run, or a position without realized PnL, are left out';

const HISTORY_COLUMNS: readonly HistoryColumn[] = [
  { key: 'strategy', title: 'Strategy', className: 'paper-history-strategy',
    cell: (item) => <><strong>{item.strategyName}</strong>{item.live && <> <span className="paper-live-badge">LIVE</span></>}</> },
  { key: 'status', title: 'Status', cell: (item) => <strong>{visibleStatus(item)}</strong> },
  { key: 'pnl', title: 'Total PnL', className: 'paper-history-pnl',
    tip: <InfoTooltip label="total PnL" en="Each exchange's account equity (balance plus open positions) against its start: the virtual starting balance in Paper, the real balance at the start in LIVE. From the last account snapshot; fees included, funding not." ru="Капитал счёта каждой биржи (баланс плюс открытые позиции) против старта: виртуального стартового баланса в Paper, настоящего баланса на старте в LIVE. По последнему снимку счёта; комиссии учтены, funding — нет." />,
    cell: (item) => item.pnl?.length
      ? item.pnl.map((row) => <div key={row.venue}><span>{row.venue}</span> {row.total === null ? '—'
        : <b className={pnlClass(row.total)}>{signedNumber(row.total)}{row.percent === null ? '' : ` (${signedNumber(row.percent)}%)`}</b>}</div>)
      : '—' },
  { key: 'closed', title: 'Closed positions', className: 'paper-history-number',
    tip: <InfoTooltip label="closed positions" en="Positions the run has closed, on all its exchanges: one market from its entry until it is flat again. A pair strategy (a pairs parameter or a pair tracker on the run page) counts both legs of a pair opened together as one position, as in Trades by position; every other strategy counts each position on its own." ru="Закрытые позиции прогона на всех его биржах: одна монета от входа до полного выхода. У парной стратегии (есть параметр pairs или трекер пары на странице прогона) обе ноги пары, открытые вместе, — одна позиция, как в «Trades by position»; у остальных стратегий каждая позиция считается отдельно." />,
    cell: (item) => <span title={item.trades?.partial ? PARTIAL_TITLE : undefined}>{closedPositionsText(item.trades)}</span> },
  { key: 'winRate', title: 'Win rate', className: 'paper-history-number',
    tip: <InfoTooltip label="win rate" en="Share of the closed positions whose realized PnL (fees included) is above zero. In a pair strategy a pair is one position: it wins when both legs together earned." ru="Доля закрытых позиций, у которых реализованный PnL (с комиссиями) больше нуля. У парной стратегии пара — одна позиция: она в плюсе, если обе ноги вместе заработали." />,
    cell: (item) => <span title={item.trades?.partial ? PARTIAL_TITLE : undefined}>{winRateText(item.trades)}</span> },
  { key: 'profitFactor', title: 'Profit factor', className: 'paper-history-number',
    tip: <InfoTooltip label="profit factor" en="Profit of the winning positions divided by the loss of the losing ones (realized, fees included). Above 1: the run earned more than it lost. ∞: no losing position yet. A pair counts as one position, as in Closed positions." ru="Прибыль прибыльных позиций, делённая на убыток убыточных (реализованные, с комиссиями). Больше 1 — прогон заработал больше, чем потерял. ∞ — убыточных позиций ещё нет. Пара — одна позиция, как в Closed positions." />,
    cell: (item) => <span title={item.trades?.partial ? PARTIAL_TITLE : undefined}>{profitFactorText(item.trades)}</span> },
  { key: 'params', title: 'Strategy parameters', className: 'paper-history-params-cell',
    tip: <InfoTooltip label="strategy parameters" en="The parameters a Python strategy was started with; runs of one strategy differ only here. Pine runs have none." ru="Параметры, с которыми запущена Python-стратегия; прогоны одной стратегии отличаются только здесь. У Pine-прогонов их нет." />,
    cell: (item) => paramsCell(item.params) },
  { key: 'venues', title: 'Venues', className: 'paper-history-venues', cell: (item) => item.venues?.join(', ') || '—' },
  { key: 'markets', title: 'Markets', cell: (item) => marketNames(item.markets) },
  { key: 'timeframe', title: 'Timeframe', cell: (item) => item.timeframe ?? '—' },
  { key: 'tracks', title: 'Tracks', cell: (item) => item.trackCount },
  { key: 'capital', title: 'Balance', className: 'paper-history-pnl',
    tip: <InfoTooltip label="balance per exchange" en="Each exchange's account now: balance plus open positions, from the last account snapshot (at the stop for a finished run). The real account in LIVE, the virtual one in Paper." ru="Счёт каждой биржи сейчас: баланс плюс открытые позиции, по последнему снимку счёта (у остановленного прогона — на момент остановки). В LIVE — настоящий счёт, в Paper — виртуальный." />,
    cell: balanceCell },
  { key: 'started', title: 'Started', cell: (item) => formatDate(item.startedAt) },
  { key: 'duration', title: 'Duration',
    tip: <InfoTooltip label="paper run duration" en="Elapsed time from the start until the end of the run. For an active run this grows while the page refreshes. A run that never started has no duration." ru="Время от начала до окончания сеанса. У активного сеанса оно увеличивается при обновлении страницы. Если сеанс не начался, длительности нет." />,
    cell: (item) => formatDuration(item) },
  { key: 'ended', title: 'Ended', cell: (item) => formatDate(item.endedAt) },
];

export function PaperRunHistory({ experiments, onOpen, onStop, stopBusyId = null, onDelete, deleteBusyId = null,
  onDuplicate, duplicateBusyId = null }: {
  experiments: readonly PaperExperimentSummary[];
  onOpen: (id: string) => void;
  /** Asks to stop a run; the caller shows "are you sure". */
  onStop?: (run: StopTarget) => void;
  stopBusyId?: string | null;
  /** Asks to delete a finished run; the caller shows "are you sure". */
  onDelete?: (run: StopTarget) => void;
  deleteBusyId?: string | null;
  /** Opens the launch page with this run's settings (any run, active or finished). */
  onDuplicate?: (id: string) => void;
  duplicateBusyId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsedColumns);
  const hidden = new Set(collapsed.filter((key) => HISTORY_COLUMNS.some((column) => column.key === key)));
  const change = (next: readonly string[]) => { setCollapsed(next); saveCollapsedColumns(next); };
  const toggle = (key: string) => change(hidden.has(key) ? [...hidden].filter((other) => other !== key) : [...hidden, key]);
  return <section className="paper-card">
    <div className="paper-card-title"><div><span className="eyebrow">HISTORY</span><h2>Server experiments</h2></div>
      <div className="paper-row-actions">{hidden.size > 0 && <button type="button" className="paper-text-button" onClick={() => change([])}>
        Show all columns ({hidden.size} hidden)</button>}<span className="paper-count-chip">{experiments.length} recorded</span></div></div>
    <div className="table-wrap"><table className="paper-run-table paper-history-table">
      <thead><tr>{HISTORY_COLUMNS.map((column) => hidden.has(column.key)
        ? <th key={column.key} className="paper-col-collapsed"><button type="button" className="paper-col-toggle paper-col-expand"
          aria-label={`Show column ${column.title}`} title={`Show ${column.title}`} onClick={() => toggle(column.key)}>{column.title}</button></th>
        : <th key={column.key}>{column.title}{column.tip && <> {column.tip}</>}<button type="button" className="paper-col-toggle"
          aria-label={`Hide column ${column.title}`} title="Collapse this column: its values are hidden" onClick={() => toggle(column.key)}>‹</button></th>)}
        <th>Actions</th></tr></thead>
      <tbody>{runListOrder(experiments).map((item) => <tr key={item.id} className={`paper-history-row${!item.live ? ''
        : canStopRun(item.status) ? ' paper-history-row-live' : ' paper-history-row-live-ended'}`}
        tabIndex={0} aria-label={`Open ${item.live ? 'LIVE ' : ''}run of ${item.strategyName}`}
        onClick={() => onOpen(item.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item.id); } }}>
        {HISTORY_COLUMNS.map((column) => hidden.has(column.key)
          ? <td key={column.key} className="paper-col-collapsed" aria-hidden="true" />
          : <td key={column.key} className={column.className}>{column.cell(item)}</td>)}
        <td><div className="paper-row-actions">{onStop && canStopRun(item.status) && <button type="button" className="paper-text-button paper-stop-button" disabled={stopBusyId !== null}
          aria-label={`Stop run ${item.id} of ${item.strategyName}`}
          onClick={(event) => { event.stopPropagation(); onStop(stopTargetOf(item)); }}
          onKeyDown={(event) => event.stopPropagation()}>{stopBusyId === item.id ? 'Stopping…' : item.status === 'stopping' ? 'Retry stop' : 'Stop'}</button>}
          {onDelete && !canStopRun(item.status) && <button type="button" className="paper-text-button paper-stop-button" disabled={deleteBusyId !== null}
            aria-label={`Delete run ${item.id} of ${item.strategyName}`}
            onClick={(event) => { event.stopPropagation(); onDelete(stopTargetOf(item)); }}
            onKeyDown={(event) => event.stopPropagation()}>{deleteBusyId === item.id ? 'Deleting…' : 'Delete'}</button>}
          {onDuplicate && <button type="button" className="paper-text-button" disabled={duplicateBusyId !== null}
            aria-label={`Run a duplicate of run ${item.id} of ${item.strategyName}`} title="Opens the launch page with this run's settings"
            onClick={(event) => { event.stopPropagation(); onDuplicate(item.id); }}
            onKeyDown={(event) => event.stopPropagation()}>{duplicateBusyId === item.id ? 'Opening…' : 'Run Duplicate'}</button>}</div></td></tr>)}</tbody>
    </table></div>
  </section>;
}

export function PaperRunActivity({ activity, loading, refreshFailed, pageIndex, onPrevious, onNext, initiallyExpanded = false, live = false, exchanges = 'Lighter' }: {
  /** A Live run: the trades are real fills on its exchanges. */
  live?: boolean;
  exchanges?: string;
  activity: PaperExperimentActivity | null;
  loading: boolean;
  refreshFailed: boolean;
  pageIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const fills = activity?.fills ?? [];
  const events = activity?.events ?? [];
  const shownEvents = expanded ? events : events.slice(0, EVENTS_COLLAPSED);
  const first = pageIndex * FILLS_PER_PAGE + 1;
  const last = pageIndex * FILLS_PER_PAGE + fills.length;
  return <>
    <section className="paper-activity-panel" aria-labelledby="paper-events-title">
      <div className="paper-card-title"><div><span className="eyebrow">ACTIVITY</span><h2 id="paper-events-title">Recent events <InfoTooltip label="paper activity events" en="Key recorded control changes and virtual Broker actions, newest first. This is a short event summary, not the raw service log. Technical error details stay in the server log." ru="Основные изменения состояния и действия условного брокера, начиная с новых. Это краткая сводка событий, а не полный технический лог сервиса. Подробности ошибок остаются в журнале сервера." /></h2><p>Key recorded events · newest first</p></div></div>
      {refreshFailed && <p className="paper-activity-warning" role="status">Activity could not be refreshed. The events below may be out of date.</p>}
      {activity?.coverage !== 'durable_journal' && activity && <p className="paper-activity-warning" role="status">{activity.coverage === 'partial' ? 'Some journal history is unavailable; events and trades may be incomplete.' : 'Only run status is available; the virtual trade journals could not be read.'}</p>}
      {loading ? <p className="paper-activity-empty">Loading activity…</p>
        : !activity ? <p className="paper-activity-empty">Activity is unavailable.</p>
          : activity.events.length === 0 ? <p className="paper-activity-empty">No recorded events yet.</p>
            : <ol className="paper-activity-list">{shownEvents.map((event) => <li key={event.id}><time dateTime={event.at ?? undefined}>{formatDate(event.at)}</time><span className="paper-activity-venue">{event.venue ? `${event.venue}${event.market ? ` · ${event.market}` : ''}` : 'Server'}</span><span>{event.message}</span></li>)}</ol>}
      {events.length > EVENTS_COLLAPSED && <button type="button" className="paper-text-button paper-events-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? `Show the latest ${EVENTS_COLLAPSED} only` : `Show all ${events.length} events`}</button>}
    </section>
    <details className="paper-activity-panel paper-fills-details" aria-labelledby="paper-fills-title">
      <summary><span className="eyebrow">ALL FILLS</span> every fill as a separate row{activity?.totalFills ? ` · ${activity.totalFills}` : ''}</summary>
      <div className="paper-card-title"><div><span className="eyebrow">EXECUTION HISTORY</span><h2 id="paper-fills-title">{live ? <>Trades on {exchanges} <InfoTooltip label="Live trades" en={`Every real fill of this run on ${exchanges}, 20 at a time. Entry and exit fills are separate rows. Fees are the ones the exchange charged; funding is not included in the realized PnL.`} ru={`Все настоящие исполнения этого прогона на ${exchanges}, по 20 на странице. Вход и выход — отдельные строки. Комиссии — те, что взяла биржа; funding в реализованный PnL не входит.`} /></> : <>Virtual trades <InfoTooltip label="paper virtual trades" en="Every committed virtual fill can be browsed here, 20 at a time. Entry and exit fills are separate rows. They are simulations, not real exchange orders. Realized PnL is shown only when the execution engine supplies it; funding is excluded." ru="Здесь можно просмотреть все записанные условные исполнения по 20 на странице. Вход и выход показаны отдельными строками. Это симуляция, а не реальные заявки на бирже. Реализованный PnL показан только там, где движок передал его; funding не учитывается." /></>}</h2><p>{!activity ? 'Loading saved fills…' : activity.totalFills === null ? 'Saved fills from available journals' : `${activity.totalFills} committed virtual fills`}</p></div></div>
      {loading ? <p className="paper-activity-empty">{live ? 'Loading trades…' : 'Loading virtual trades…'}</p>
        : !activity ? <p className="paper-activity-empty">{live ? 'Trade history is unavailable.' : 'Virtual trade history is unavailable.'}</p>
          : fills.length === 0 ? <p className="paper-activity-empty">{activity.coverage === 'durable_journal'
            ? (live ? 'No trades were executed on Lighter in this run.' : 'No virtual trades were executed in this run.')
            : (live ? 'No trades found in the available journal history.' : 'No virtual trades found in the available journal history.')}</p>
            : <div className="table-wrap"><table className="paper-run-table paper-fill-table"><thead><tr><th>Time</th><th>Exchange</th><th>Market</th><th>Action</th><th>Side</th><th>Position</th><th>Quantity</th><th>Price</th><th>Value</th><th>Fee</th><th>Realized PnL</th></tr></thead><tbody>{fills.map((fill) => <tr key={fill.id}><td>{formatDate(fill.at)}</td><td>{fill.venue}</td><td>{fill.market}</td><td className="paper-fill-kind">{fill.kind}</td><td>{fill.side}</td><td>{fill.positionSide}</td><td>{fill.quantity}</td><td>{fill.price === null ? '—' : `${fill.price} USDC`}</td><td>{fill.quote} USDC</td><td>{fill.fee === null ? '—' : `${fill.fee} USDC`}</td><td>{fill.realizedPnl === null ? '—' : `${fill.realizedPnl} USDC`}</td></tr>)}</tbody></table></div>}
      {(pageIndex > 0 || activity?.nextFillsCursor) && <div className="paper-fill-pagination"><span>{activity ? `${fills.length ? `${first}–${last}` : '0'}${activity.totalFills === null ? ' shown' : ` of ${activity.totalFills}`}` : 'Page unavailable'}</span><button type="button" className="paper-text-button" disabled={pageIndex === 0} onClick={onPrevious}>Previous</button><button type="button" className="paper-text-button" disabled={!activity?.nextFillsCursor} onClick={onNext}>Next</button></div>}
    </details>
  </>;
}

export function PaperRuns({ onPrepare, onDuplicate }: {
  onPrepare: () => void;
  /** Run Duplicate: opens the launch page with this run's settings; rejects with the reason it could not. */
  onDuplicate?: (id: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(idFromPath);
  const [capabilities, setCapabilities] = useState<PaperCapabilities | null>(null);
  const [experiments, setExperiments] = useState<PaperExperimentSummary[] | null>(null);
  const [detail, setDetail] = useState<PaperExperimentDetail | null>(null);
  // LIVE runs name the account each exchange trades (Accounts page).
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  const liveRun = Boolean(detail?.live);
  useEffect(() => {
    if (!liveRun) return;
    const controller = new AbortController();
    loadLiveAccounts(controller.signal)
      .then((view) => setAccountNames(Object.fromEntries(view.accounts.map((account) => [account.id, account.name]))))
      .catch(() => { /* names are optional */ });
    return () => controller.abort();
  }, [liveRun]);
  const [activity, setActivity] = useState<PaperExperimentActivity | null>(null);
  const [trades, setTrades] = useState<PaperExperimentTrades | null>(null);
  const [activityRefreshFailed, setActivityRefreshFailed] = useState(false);
  const [fillPageCursors, setFillPageCursors] = useState<(string | null)[]>([null]);
  const [fillPageIndex, setFillPageIndex] = useState(0);
  const [refreshError, setRefreshError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [stopBusyId, setStopBusyId] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<StopTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StopTarget | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [duplicateBusyId, setDuplicateBusyId] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState('');
  const [stopError, setStopError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const syncPath = () => { setSelectedId(idFromPath()); setDetail(null); setActivity(null); setTrades(null); setFillPageCursors([null]); setFillPageIndex(0); };
    window.addEventListener('popstate', syncPath);
    window.addEventListener('paper-route-changed', syncPath);
    return () => { window.removeEventListener('popstate', syncPath); window.removeEventListener('paper-route-changed', syncPath); };
  }, []);

  const fillsCursor = fillPageCursors[fillPageIndex] ?? null;
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const [capabilityResult, listResult, detailResult, activityResult, tradesResult] = await Promise.allSettled([
        loadPaperCapabilities(controller.signal),
        selectedId ? Promise.resolve(null) : listPaperExperiments(controller.signal),
        selectedId ? loadPaperExperiment(selectedId, controller.signal) : Promise.resolve(null),
        selectedId ? loadPaperExperimentActivity(selectedId, {
          limit: FILLS_PER_PAGE,
          fillsCursor: fillsCursor ?? undefined,
        }, controller.signal) : Promise.resolve(null),
        selectedId ? loadPaperExperimentTrades(selectedId, controller.signal) : Promise.resolve(null),
      ]);
      if (!active) return;
      if (capabilityResult.status === 'fulfilled') setCapabilities(capabilityResult.value);
      if (listResult.status === 'fulfilled' && listResult.value !== null) setExperiments(listResult.value);
      if (detailResult.status === 'fulfilled') setDetail(detailResult.value);
      if (selectedId) {
        if (activityResult.status === 'fulfilled') setActivity(activityResult.value);
        if (tradesResult.status === 'fulfilled') setTrades(tradesResult.value);
        setActivityRefreshFailed(activityResult.status === 'rejected');
      }
      const failures = [capabilityResult, listResult, detailResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => errorMessage(result.reason));
      setRefreshError(failures.join(' '));
      if (failures.length === 0) setLastRefreshedAt(new Date().toISOString());
      inFlight = false;
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 5000);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [selectedId, refreshToken, fillPageIndex, fillsCursor]);

  const openRun = (id: string | null) => {
    window.history.pushState(null, '', runPath(id));
    setSelectedId(id);
    setDetail(null);
    setActivity(null);
    setTrades(null);
    setActivityRefreshFailed(false);
    setFillPageCursors([null]);
    setFillPageIndex(0);
    setRefreshError('');
  };

  const nextFillPage = () => {
    if (!activity?.nextFillsCursor) return;
    const nextCursor = activity.nextFillsCursor;
    setFillPageCursors((current) => [...current.slice(0, fillPageIndex + 1), nextCursor]);
    setFillPageIndex((index) => index + 1);
    setActivity(null);
    setActivityRefreshFailed(false);
  };

  const previousFillPage = () => {
    if (fillPageIndex === 0) return;
    setFillPageIndex((index) => index - 1);
    setActivity(null);
    setActivityRefreshFailed(false);
  };

  /** Runs after "Yes, stop" in the dialog, from the runs list or this run's page. */
  const stopRun = async (target: StopTarget) => {
    if (stopBusyId) return;
    setStopBusyId(target.id);
    setStopError('');
    try {
      const stopped = await stopPaperExperiment(target.id);
      if (selectedId === target.id) setDetail(stopped);
      setRefreshToken((value) => value + 1);
    } catch (reason) {
      setStopError(errorMessage(reason));
    } finally {
      setStopBusyId(null);
      setConfirmStop(null);
    }
  };

  /** Runs after "Yes, delete" in the dialog: the run and its data are gone from the server. */
  const deleteRun = async (target: StopTarget) => {
    if (deleteBusyId) return;
    setDeleteBusyId(target.id);
    setDeleteError('');
    try {
      await deletePaperExperiment(target.id);
      setExperiments((current) => current?.filter((item) => item.id !== target.id) ?? current);
      setRefreshToken((value) => value + 1);
    } catch (reason) {
      setDeleteError(errorMessage(reason));
    } finally {
      setDeleteBusyId(null);
      setConfirmDelete(null);
    }
  };

  const duplicateRun = async (id: string) => {
    if (!onDuplicate || duplicateBusyId) return;
    setDuplicateBusyId(id);
    setDuplicateError('');
    try {
      await onDuplicate(id);
    } catch (reason) {
      setDuplicateError(errorMessage(reason));
    } finally {
      setDuplicateBusyId(null);
    }
  };

  const canStop = detail && canStopRun(detail.status);
  return (
    <section className="paper-page" aria-labelledby="paper-runs-title">
      <div className="paper-page-heading">
        <div><span className="eyebrow">RUNS</span><h1 id="paper-runs-title">Runs <InfoTooltip label="runs page" en="Paper and LIVE runs kept by the server; the status refreshes every five seconds. Each exchange of a run has one shared account (virtual in Paper, yours in LIVE). Closing the browser does not stop a run." ru="Прогоны Paper и LIVE, которые ведёт сервер; статус обновляется каждые пять секунд. У каждой биржи прогона один общий счёт (виртуальный в Paper, ваш в LIVE). Закрытие браузера не останавливает прогон." /></h1></div>
        <button className="paper-text-button" type="button" onClick={onPrepare}>Prepare Run <ArrowRight size={15} /></button>
      </div>
      {capabilities && !capabilities.available && (capabilities.activeExperiments ?? 0) >= capabilities.maxConcurrentExperiments
        ? <div className="paper-slots-note" role="status"><Clock3 size={16} /><span>{capabilities.activeExperiments} of {capabilities.maxConcurrentExperiments} runs are active. To start a new one, stop one of them.</span></div>
        : capabilities && !capabilities.available && <div className="paper-preview-notice" role="status"><AlertTriangle size={18} /><div><strong>New launches unavailable.</strong><span> {capabilities.reason || 'The server has not enabled Paper admission.'}</span></div></div>}
      {refreshError && <div className="paper-preview-notice" role="alert"><AlertTriangle size={18} /><div><strong>Status refresh failed.</strong><span> Try Refresh now. {lastRefreshedAt && `Last complete refresh: ${formatDate(lastRefreshedAt)}.`}</span></div></div>}
      {duplicateError && <div className="paper-preview-notice" role="alert"><AlertTriangle size={18} /><div><strong>The run's settings could not be copied.</strong><span> {duplicateError}</span></div></div>}
      {deleteError && <div className="paper-preview-notice" role="alert"><AlertTriangle size={18} /><div><strong>The run was not deleted.</strong><span> {deleteError}</span></div></div>}
      {stopError && <div className="paper-preview-notice" role="alert"><AlertTriangle size={18} /><div><strong>Stop was not confirmed by the server.</strong><span> This run may still occupy the active slot. Refresh its status before trying again.</span></div></div>}
      <div className="paper-runs-toolbar"><span>{lastRefreshedAt ? `Last updated ${formatDate(lastRefreshedAt)} · automatic refresh every 5 seconds` : 'Waiting for the first server response…'}</span><button className="paper-text-button" type="button" onClick={() => setRefreshToken((value) => value + 1)}>Refresh now</button></div>

      {selectedId && <section className="paper-card paper-run-detail">
        <button type="button" className="paper-text-button" onClick={() => openRun(null)}><ArrowLeft size={15} />All runs</button>
        {!detail ? <p>{refreshError ? 'Run details are unavailable.' : 'Loading run details…'}</p> : <>
          <PaperRunDataGaps detail={detail} />
          {!['completed', 'interrupted'].includes(detail.status) && <XyzHoursNotice onlyWhenClosed
            markets={[...new Set(detail.tracks.filter((track) => track.venue === 'Hyperliquid' && isXyzMarket(track.market)).map((track) => track.market))]} />}
          <PaperPositionsTable detail={detail} accountNames={accountNames} />
          <section className="paper-activity-panel paper-run-overview" aria-labelledby="paper-run-title">
            <div className="paper-run-detail-header"><div><span className="eyebrow">EXPERIMENT / {detail.id}</span><h2 id="paper-run-title">{detail.strategyName}{detail.live && <> <span className="paper-live-badge">LIVE — real money · {liveExchangesOf(detail)}</span></>}</h2><p>Status: <strong>{visibleStatus(detail)}</strong>{visibleStatus(detail) === 'Stop needs attention' && <> <InfoTooltip label="stop needs attention" en="The server could not confirm that shutdown finished. This experiment may still block a new launch. Try Retry stop after the runtime issue is resolved." ru="Сервер не смог подтвердить завершение остановки. Этот эксперимент может блокировать новый запуск. После устранения проблемы можно повторить остановку." /></>}</p></div>{canStop && <button className="paper-text-button paper-stop-button" type="button" disabled={stopBusyId !== null}
              onClick={() => setConfirmStop({ id: detail.id, strategyName: detail.strategyName, live: Boolean(detail.live), exchanges: liveExchangesOf(detail) })}>{stopBusyId === detail.id ? 'Stopping…' : detail.status === 'stopping' ? 'Retry stop' : detail.live ? 'Stop and close all' : 'Stop experiment'}</button>}</div>
            {canStop && <NativeRunNotice detail={detail} />}
            <LiveStopOutcome detail={detail} />
            <div className="paper-run-summary"><div><span>Started</span><strong>{formatDate(detail.startedAt)}</strong></div>{detail.endedAt ? <div><span>Ended</span><strong>{formatDate(detail.endedAt)}</strong></div> : <div><span>Running for</span><strong>{formatDuration(detail)}</strong></div>}<div><span>Timeframe</span><strong>{detail.settings.timeframe}</strong></div><PaperRunHealth detail={detail} /></div>
            <PaperRunRules detail={detail} inOverview />
          </section>
          <PaperTradeGroups trades={trades} live={Boolean(detail.live)} />
          <PaperRunActivity live={Boolean(detail.live)} exchanges={liveExchangesOf(detail)} activity={activity} loading={activity === null && !activityRefreshFailed} refreshFailed={activityRefreshFailed} pageIndex={fillPageIndex} onPrevious={previousFillPage} onNext={nextFillPage} />
          <details className="paper-tech-details"><summary>Technical details</summary>
          <div className="paper-account-grid">{detail.accounts.filter((account) => !detail.live || detail.tracks.some((track) => track.venue === account.venue)).map((account) => {
            const accountTracks = detail.tracks.filter((track) => track.accountId === account.accountId);
            const runtime = detail.runtime;
            const observed = runtime?.accounts.find((entry) => entry.accountId === account.accountId && entry.runId === account.runId && entry.venue === account.venue);
            return <div key={account.accountId}>
              <span>{account.venue} shared account · {accountTracks.length} {accountTracks.length === 1 ? 'market' : 'markets'}</span>
              <strong>{detail.live ? 'Real Lighter account' : `${account.startingCash.toLocaleString()} ${account.currency} starting cash`}</strong>
              <ul className="paper-account-markets">{accountTracks.map((track) => <li key={track.trackId}><span>{track.market}</span><strong>{statusLabel[track.status]}</strong></li>)}</ul>
              {runtime && observed ? <>
                <small>Owner snapshot: {formatDate(runtime.observedAt)} · {statusLabel[runtime.stage]}{refreshError ? ' · refresh failed; values may be old' : ''}</small>
                <div className="paper-account-metrics">
                  <div><span>{detail.live ? 'Lighter balance at snapshot' : 'Virtual cash at snapshot'}</span><strong>{observed.cashBalance} {account.currency}</strong></div>
                  <div><span>Pending orders</span><strong>{observed.pendingOrders}</strong></div>
                  <div><span>Broker revision</span><strong>{observed.brokerRevision}</strong></div>
                  <div><span>Public frames</span><strong>{observed.publicFrames}</strong></div>
                  <div><span>Signals / intents / fills</span><strong>{observed.signals} / {observed.intents} / {observed.fills}</strong></div>
                  <div><span>Rejected signals</span><strong>{observed.rejectedSignals}</strong></div>
                  {typeof observed.priceReady === 'boolean' && <div><span>Price for new decisions <InfoTooltip label={`${account.venue} price readiness`} en="Ready means all selected markets at this exchange pass their one-second quote and book checks at the snapshot time. The market table shows each market separately. Waiting does not by itself mean the exchange feed disconnected." ru="Ready означает, что все выбранные рынки биржи прошли секундную проверку котировки и стакана в момент снимка. В таблице показана готовность каждого рынка. Ожидание само по себе не означает отключение потока биржи." /></span><strong>{observed.priceReady ? 'Ready' : 'Waiting for fresh price'}</strong></div>}
                  {typeof observed.stalePriceObservationsSkipped === 'number' && <div><span>{runtime.engine === 'nautilus' ? 'Skipped observations' : 'Stale observations skipped'} <InfoTooltip label={`${account.venue} skipped observations`} en={runtime.engine === 'nautilus' ? 'Counts observations skipped by runtime checks across the selected markets. The durable run log records specific reasons such as stale quotes, stale books or waiting for a closed hour. This is not a count or duration of exchange outages.' : 'Price observations ignored because the one-second quote gate had expired while the virtual account was empty. This is a count of observations, not a count or duration of exchange outages.'} ru={runtime.engine === 'nautilus' ? 'Число наблюдений выбранных рынков, пропущенных проверками исполнителя. В журнале сохраняются причины: старая котировка, старый стакан или ожидание закрытого часа. Это не число и не длительность отключений биржи.' : 'Наблюдения цены, пропущенные после истечения секундного срока свежести котировки при пустом виртуальном счёте. Это число наблюдений, а не количество или длительность отключений биржи.'} /></span><strong>{observed.stalePriceObservationsSkipped}</strong></div>}
                </div>
                <small>Open positions: {observed.positions.length} · see Open positions above.</small>
              </> : <small>Current cash, positions and pending orders: no available owner snapshot. Saved virtual trades are listed below.</small>}
              {observed?.priceReady === undefined && <small>Price readiness: not reported by server</small>}
              <small title={account.accountId}>Account {account.accountId.slice(0, 12)}… · run {account.runId.slice(0, 12)}…</small>
            </div>;
          })}</div>
          <div className="paper-run-summary"><PaperRunEngineLabel engine={detail.runtime?.engine} live={Boolean(detail.live)} exchanges={liveExchangesOf(detail)} /><div><span>Strategy code SHA-256</span><strong title={detail.sourceSha256}>{detail.sourceSha256.slice(0, 12)}…</strong></div></div>
          <PaperRunTrackTable detail={detail} />
          <p className="paper-card-footnote">Status and counters are the server's last report{refreshError ? ', not a live reading while refresh is failing' : ''}. Starting cash is the initial balance; an owner snapshot is shown only when available. <InfoTooltip label="reported paper metrics" en="Public frames count accepted public observations, not proof of fresh data. Current Nautilus rows report each market separately; account counters combine the selected markets. Historical owners may repeat venue counters across rows. Price readiness is sampled at snapshot time, and skipped observations are not source-gap counts. Signals, approved order intents, fills and rejected signals come from committed virtual Broker journal operations, not real exchange trades. Nautilus keeps its last committed virtual cash, positions and pending orders snapshot after Stop or process death; older runs may have no retained snapshot. Last control update is not the time of the latest market event. The event list contains key milestones, and all recorded virtual fills can be browsed below. Funding is excluded from this pilot." ru="Public frames — принятые публичные наблюдения, а не доказательство свежести данных. Текущий Nautilus показывает каждый рынок отдельно; счётчики счёта объединяют выбранные рынки. В старых прогонах биржевые счётчики могут повторяться в строках рынков. Готовность цены показана на момент снимка; пропуски наблюдений не равны разрывам потока. Сигналы, одобренные намерения отправить заявку, исполнения и отклонённые сигналы взяты из записанных операций виртуального брокера, а не из реальных сделок на бирже. Nautilus сохраняет последний записанный снимок условного остатка, открытых позиций и ожидающих заявок после Stop или гибели процесса; у старых прогонов сохранённого снимка может не быть. Последнее обновление управления не означает время последнего рыночного события. Список событий содержит основные этапы, а все записанные условные исполнения можно просмотреть ниже. Funding в этом пилоте не учитывается." /></p>
          </details>
        </>}
      </section>}

      {!selectedId && (experiments === null ? <div className="paper-empty-runs"><Clock3 size={26} /><h2>{refreshError ? 'Cannot load server runs' : 'Loading server runs…'}</h2></div>
        : experiments.length === 0 ? <div className="paper-empty-runs"><ShieldCheck size={26} /><h2>No paper runs recorded <InfoTooltip label="empty paper runs" en="The server returned an empty experiment list. Saving a strategy or a Paper draft does not create a run." ru="Сервер вернул пустой список экспериментов. Сохранение стратегии или черновика Paper не создаёт сеанс." /></h2><button type="button" className="paper-text-button" onClick={onPrepare}>Prepare an experiment <ArrowRight size={15} /></button></div>
          : <PaperRunHistory experiments={experiments} onOpen={(id) => openRun(id)} onStop={setConfirmStop} stopBusyId={stopBusyId}
            onDelete={setConfirmDelete} deleteBusyId={deleteBusyId}
            {...(onDuplicate ? { onDuplicate: (id: string) => { void duplicateRun(id); } } : {})} duplicateBusyId={duplicateBusyId} />)}
      {confirmStop && <StopRunDialog run={confirmStop} busy={stopBusyId === confirmStop.id}
        onCancel={() => setConfirmStop(null)} onConfirm={() => { void stopRun(confirmStop); }} />}
      {confirmDelete && <DeleteRunDialog run={confirmDelete} busy={deleteBusyId === confirmDelete.id}
        onCancel={() => setConfirmDelete(null)} onConfirm={() => { void deleteRun(confirmDelete); }} />}
    </section>
  );
}
