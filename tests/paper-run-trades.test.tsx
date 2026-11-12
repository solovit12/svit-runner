import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaperStrategyPanels, PaperTradeGroups } from '../apps/web/src/components/PaperRunTrades';
import type { PaperExperimentTrades, PaperStrategyPanel } from '../packages/shared/src/paper-experiment-contracts';

const panel: PaperStrategyPanel = {
  key: 'BRENTOIL/WTI', title: 'BRENTOIL/WTI · long BRENTOIL, short WTI', at: 1, markets: ['BRENTOIL', 'WTI'],
  lines: ['stop at −150 bp: 163.8 bp away'],
  progress: { label: 'to take-profit', value: 13.8, target: 25, unit: 'bp', leftPercent: 0.112, leftUsd: 2.24, usd: 2.76 },
};

const trades: PaperExperimentTrades = { coverage: 'durable_journal', truncated: false, groups: [{
  id: 'g1', name: 'BRENTOIL/WTI', openedAt: '2026-11-12T08:08:48.100Z', closedAt: '2026-11-12T10:24:49.300Z',
  realizedPnl: 1.86, fees: 0, legs: [
    { venue: 'Lighter', market: 'BRENTOIL', side: 'long', openedAt: '2026-11-12T08:08:48.100Z', closedAt: '2026-11-12T10:24:49.200Z',
      quantity: 21.8674, entryPrice: 91.46, exitPrice: 90.32, entryValue: 1999.99, realizedPnl: -24.93, fees: 0, fills: 3 },
    { venue: 'Lighter', market: 'WTI', side: 'short', openedAt: '2026-11-12T08:08:48.200Z', closedAt: '2026-11-12T10:24:49.300Z',
      quantity: 23.221, entryPrice: 86.1265, exitPrice: 84.973, entryValue: 1999.94, realizedPnl: 26.79, fees: 0, fills: 3 },
  ] }] };

describe('run page: strategy panels and trades by position', () => {
  it('shows the way to the take-profit with what is left in percent and in dollars', () => {
    const html = renderToStaticMarkup(createElement(PaperStrategyPanels, { panels: [panel] }));
    expect(html).toContain('BRENTOIL/WTI · long BRENTOIL, short WTI');
    expect(html).toContain('aria-valuenow="55"');
    expect(html).toContain('width:55.2%');
    expect(html).toContain('0.11 %');
    expect(html).toContain('≈ 2.24 USDC');
    expect(html).toContain('+2.76 USDC');
    expect(html).toContain('stop at −150 bp: 163.8 bp away');
    expect(renderToStaticMarkup(createElement(PaperStrategyPanels, { panels: [] }))).toBe('');
  });

  it('draws a move against the trade as the way to the stop, not in lengths of the take-profit', () => {
    // -46.4 bp of a 105 bp take-profit, the stop at -615 bp: 8 % of the way to the stop, not 44 %.
    const html = renderToStaticMarkup(createElement(PaperStrategyPanels, { panels: [{ ...panel,
      progress: { ...panel.progress!, value: -46.4, target: 105, stop: -615 } }] }));
    expect(html).toContain('paper-progress-back');
    expect(html).toMatch(/width:7\.5\d*%/);
    expect(html).toContain('stop at −615 bp: 8 % of the way');
    const noStop = renderToStaticMarkup(createElement(PaperStrategyPanels, { panels: [{ ...panel,
      progress: { ...panel.progress!, value: -5 } }] }));
    expect(noStop).toContain('width:0%');
    expect(noStop).toContain('against the trade');
  });

  it('lists a pair with its legs and their own results', () => {
    const html = renderToStaticMarkup(createElement(PaperTradeGroups, { trades, live: true, nowMs: Date.parse('2026-11-12T11:00:00Z') }));
    expect(html).toContain('Trades by position');
    expect(html).toContain('Closed: 1 · wins 1 · result <b class="paper-pnl-up">+1.86 USDC</b>');
    expect(html).toContain('held 2 h 16 min');
    expect(html).toContain('<td class="paper-pnl-down">−24.93 USDC</td>');
    expect(html).toContain('<td class="paper-pnl-up">+26.79 USDC</td>');
    expect(html.indexOf('paper-side-long">BRENTOIL')).toBeLessThan(html.indexOf('paper-side-short">WTI'));
    expect(html.indexOf('paper-side-long">BRENTOIL')).toBeGreaterThan(0);
  });
});
