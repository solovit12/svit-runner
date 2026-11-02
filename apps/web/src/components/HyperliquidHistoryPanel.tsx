import { useState } from 'react';
import { Database } from 'lucide-react';
import type { BacktestTimeframe } from '../../../../packages/shared/src/contracts';
import { hyperliquidHistoryWindow, type DataSourcesView } from '../../../../packages/shared/src/hyperliquid-history';
import { removeOxArchiveKey, saveOxArchiveKey } from '../lib/api';
import { InfoTooltip } from './TranslatedText';

/**
 * How far back a Hyperliquid backtest can start, and the optional 0xArchive key that extends "Every minute" checks
 * from Hyperliquid's last ~3 days to the key's plan (the free plan: the last 30 days).
 */
export function HyperliquidHistoryPanel({ timeframe, barDetail, dataSources, onDataSources, disabled = false, nowMs = Date.now() }: {
  timeframe: BacktestTimeframe;
  barDetail: 'high' | 'default';
  dataSources: DataSourcesView | null;
  onDataSources: (view: DataSourcesView) => void;
  disabled?: boolean;
  nowMs?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const oxarchive = dataSources?.oxarchive ?? { configured: false, historyDays: null, checkedAt: null, fromEnvironment: false };
  const history = hyperliquidHistoryWindow(timeframe, barDetail, oxarchive, nowMs);
  const minuteFrom = history.oxarchiveFrom ?? history.apiMinuteFrom;
  const plan = oxarchive.historyDays === null ? 'full archive' : `${oxarchive.historyDays} days`;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      onDataSources(await saveOxArchiveKey(key.trim()));
      setKey('');
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      onDataSources(await removeOxArchiveKey());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div className="hl-history-panel" role="note">
    <Database size={16} />
    <div>
      <strong>Hyperliquid history <InfoTooltip label="Hyperliquid history"
        en="Hyperliquid keeps the last 5,000 candles of every timeframe, so 4 points per bar reaches back further on larger timeframes. Every minute needs one-minute candles: Hyperliquid keeps about 3.5 days of them; a free 0xArchive key adds the last 30 days. Inside the key's window all candles come from 0xArchive; one run never mixes the two sources."
        ru="Hyperliquid хранит последние 5000 свечей каждого таймфрейма, поэтому в режиме «4 точки на свечу» на крупных таймфреймах история глубже. Поминутной проверке нужны минутные свечи: Hyperliquid хранит их примерно за 3,5 дня, бесплатный ключ 0xArchive добавляет последние 30 дней. Внутри окна ключа все свечи берутся из 0xArchive; один прогон никогда не смешивает два источника." /></strong>
      <span>4 points per bar: {timeframe} candles from {history.apiFrom}{history.oxarchiveFrom && history.oxarchiveFrom < history.apiFrom ? ` (from ${history.oxarchiveFrom} with 0xArchive)` : ''}. Every minute: from {minuteFrom}{oxarchive.configured ? ` with your 0xArchive key (${plan})` : ' — about the last 3 days'}.</span>
      {oxarchive.fromEnvironment ? (
        <span className="hl-history-key">0xArchive key: set in this server's settings file.</span>
      ) : oxarchive.configured && !editing ? (
        <span className="hl-history-key">0xArchive key saved{oxarchive.checkedAt ? `, checked ${oxarchive.checkedAt.slice(0, 10)}` : ''}.{' '}
          <button type="button" className="text-button" onClick={() => setEditing(true)} disabled={disabled || busy}>Replace</button>{' '}
          <button type="button" className="text-button" onClick={() => { void remove(); }} disabled={disabled || busy}>Remove</button>
        </span>
      ) : (
        <form className="hl-history-key" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <span>{oxarchive.configured ? 'New 0xArchive key:' : <>Every minute for the last 30 days: a free API key from <a href="https://www.0xarchive.io" target="_blank" rel="noreferrer">0xarchive.io</a></>}</span>
          <input type="password" autoComplete="off" spellCheck={false} placeholder="0xArchive API key" value={key}
            onChange={(event) => setKey(event.target.value)} disabled={disabled || busy} aria-label="0xArchive API key" />
          <button type="submit" disabled={disabled || busy || key.trim().length < 16}>{busy ? 'Checking…' : 'Save key'}</button>
          {editing && <button type="button" className="text-button" onClick={() => { setEditing(false); setKey(''); setError(''); }} disabled={busy}>Cancel</button>}
        </form>
      )}
      {error && <span className="hl-history-error" role="alert">{error}</span>}
    </div>
  </div>;
}
