import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { HYPERLIQUID_SYMBOL, type HyperliquidMarketList, type HyperliquidMarketOption } from '../../../../packages/shared/src/hyperliquid-history';
import { loadHyperliquidMarkets } from '../lib/api';
import { InfoTooltip } from './TranslatedText';
import './BinanceMarketSelector.css';

export function filterHyperliquidMarkets(markets: HyperliquidMarketOption[], query: string): HyperliquidMarketOption[] {
  const needle = query.trim().toLowerCase();
  return needle ? markets.filter((market) => market.symbol.toLowerCase().includes(needle)) : markets;
}

/** A name typed exactly (kPEPE, xyz:SP500) that the list does not hold; the server checks it. */
export function canUseExactHyperliquidSymbol(query: string, markets: HyperliquidMarketOption[]): boolean {
  const symbol = query.trim();
  return HYPERLIQUID_SYMBOL.test(symbol) && !markets.some((market) => market.symbol.toLowerCase() === symbol.toLowerCase());
}

interface HyperliquidMarketSelectorProps {
  value: string;
  onChange: (symbol: string) => void;
  disabled?: boolean;
}

/** Hyperliquid's main perps and the XYZ exchange (stocks, indices, commodities), largest 24-hour turnover first. */
export function HyperliquidMarketSelector({ value, onChange, disabled = false }: HyperliquidMarketSelectorProps) {
  const id = useId();
  const listId = `${id}-markets`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState<HyperliquidMarketList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [openAbove, setOpenAbove] = useState(false);
  const [popoverHeight, setPopoverHeight] = useState(360);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadHyperliquidMarkets(controller.signal).then((response) => {
      setCatalog(response);
      setError(false);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [retry]);

  const markets = catalog?.markets ?? [];
  const filtered = useMemo(() => filterHyperliquidMarkets(markets, query), [markets, query]);
  // Offered only when the search finds nothing, so a half-typed name does not show up as a market.
  const exactChoice = filtered.length === 0 && canUseExactHyperliquidSymbol(query, markets);
  const choiceCount = filtered.length + (exactChoice ? 1 : 0);

  function choose(symbol: string) {
    onChange(symbol);
    setQuery('');
    setOpen(false);
    setActiveIndex(0);
  }

  function positionPopover() {
    const bounds = inputRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const below = window.innerHeight - bounds.bottom - 8;
    const above = bounds.top - 8;
    const placeAbove = below < 300 && above > below;
    setOpenAbove(placeAbove);
    setPopoverHeight(Math.max(120, Math.min(360, placeAbove ? above : below)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      positionPopover();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, Math.min(choiceCount - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (event.key === 'Enter' && open && choiceCount > 0) {
      event.preventDefault();
      const market = filtered[activeIndex];
      if (market) choose(market.symbol);
      else if (exactChoice) choose(query.trim());
    }
  }

  const fetchedAt = catalog ? new Date(catalog.fetchedAt).toLocaleString('en-GB', {
    timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short',
  }) : null;

  return (
    <div className="binance-market-selector">
      <div className="binance-market-label"><label htmlFor={id}>Symbol</label><InfoTooltip label="symbol list" en="Hyperliquid perpetuals: crypto on the main exchange and stocks, indices and commodities on XYZ (names start with xyz:), largest 24-hour turnover first." ru="Бессрочные контракты Hyperliquid: криптовалюты основной биржи и акции, индексы, сырьё на XYZ (названия начинаются с xyz:), сначала с наибольшим оборотом за 24 часа." /></div>
      <div className="binance-market-input-row">
        <input ref={inputRef} id={id} type="text" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open && choiceCount > 0 ? `${listId}-option-${activeIndex}` : undefined}
          value={open ? query : value} placeholder="Search BTC, HYPE, xyz:SP500…"
          onFocus={() => { positionPopover(); setQuery(''); setActiveIndex(0); setOpen(true); }}
          onChange={(event) => { positionPopover(); setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onBlur={() => { setOpen(false); setQuery(''); }} disabled={disabled} />
        <button type="button" aria-label="Browse Hyperliquid markets" disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { positionPopover(); setQuery(''); setActiveIndex(0); setOpen((current) => !current); inputRef.current?.focus(); }}>
          ▾
        </button>
      </div>
      {open && !disabled && (
        <div className={`binance-market-popover${openAbove ? ' above' : ''}`} style={{ maxHeight: popoverHeight }}>
          <div className="binance-market-popover-head">
            <strong>{catalog ? `${markets.length} Hyperliquid markets` : 'Hyperliquid perps'} · 24h turnover</strong>
            {catalog && <span>{catalog.sourceStatus === 'stale' || error ? 'Stale' : 'As of'} {fetchedAt} UTC</span>}
          </div>
          {loading && !catalog && <p role="status">Loading Hyperliquid markets…</p>}
          {error && <p role="alert">Market list unavailable. Enter an exact name such as BTC or xyz:SP500, or <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setRetry((current) => current + 1)}>retry</button>.</p>}
          {catalog?.sourceStatus === 'stale' && !error && <p role="status">Hyperliquid is unavailable; this list is an older snapshot.</p>}
          {!loading && !error && choiceCount === 0 && <p role="status">No matching market. Search another name.</p>}
          {choiceCount > 0 && <div id={listId} role="listbox" className="binance-market-options" aria-label="Hyperliquid markets">
            {filtered.map((market, index) => (
              <button key={market.symbol} id={`${listId}-option-${index}`} type="button" role="option"
                aria-selected={market.symbol === value} className={index === activeIndex ? 'active' : ''}
                onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(market.symbol)}>
                <span><b>{market.symbol}</b><small>{market.dex === 'xyz' ? 'XYZ: stocks, indices, commodities' : 'Main exchange'} · up to {market.maxLeverage}×</small></span>
                <span>{new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(market.volume24hUsd)} USDC</span>
              </button>
            ))}
            {exactChoice && <button id={`${listId}-option-${filtered.length}`} type="button" role="option"
              aria-selected={false} className={activeIndex === filtered.length ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(filtered.length)} onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(query.trim())}>
              <span><b>Use {query.trim()}</b><small>Not in the list; the server checks it</small></span>
            </button>}
          </div>}
        </div>
      )}
    </div>
  );
}
