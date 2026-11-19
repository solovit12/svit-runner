import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PairLegRoomNotice } from '../apps/web/src/components/PairLegRoomNotice';
import { pairLegRoom, pairsFrom } from '../packages/shared/src/pair-legs';

/** Run ea8bf612 (2026-11-13): four legs of 3,000 against a 10,000 Paper balance stopped the run. */
const RUN = {
  params: {
    pairs: 'BRENTOIL/WTI, XAU/XAG, xyz:BRENTOIL/xyz:CL, xyz:GOLD/xyz:SILVER',
    leg_usdc: 3000, leg_usdc_cme_closed: 3000, max_open_pairs: 2, entry_bp: 8,
  },
  tracks: [
    { venue: 'Lighter', market: 'BRENTOIL' }, { venue: 'Lighter', market: 'WTI' },
    { venue: 'Lighter', market: 'XAU' }, { venue: 'Lighter', market: 'XAG' },
    { venue: 'Hyperliquid', market: 'xyz:BRENTOIL' }, { venue: 'Hyperliquid', market: 'xyz:CL' },
    { venue: 'Hyperliquid', market: 'xyz:GOLD' }, { venue: 'Hyperliquid', market: 'xyz:SILVER' },
  ],
  capitalPerVenue: 10_000,
};

describe('pair legs against the Paper balance', () => {
  it('reads the pairs of a pair strategy', () => {
    expect(pairsFrom('BRENTOIL/WTI, XAU/XAG')).toEqual([['BRENTOIL', 'WTI'], ['XAU', 'XAG']]);
    expect(pairsFrom('xyz:CRWV/xyz:NBIS')).toEqual([['xyz:CRWV', 'xyz:NBIS']]);
    expect(pairsFrom('BTC')).toEqual([]);
    expect(pairsFrom(42)).toEqual([]);
  });

  it('names every exchange whose balance cannot hold the legs that may open at once', () => {
    expect(pairLegRoom(RUN)).toEqual([
      { venue: 'Hyperliquid', pairs: 2, legUsdc: 3000, needed: 12_000, balance: 10_000 },
      { venue: 'Lighter', pairs: 2, legUsdc: 3000, needed: 12_000, balance: 10_000 },
    ]);
  });

  it('stays quiet when the legs fit', () => {
    expect(pairLegRoom({ ...RUN, capitalPerVenue: 12_000 })).toEqual([]);
    expect(pairLegRoom({ ...RUN, params: { ...RUN.params, leg_usdc: 2000, leg_usdc_cme_closed: 2000 } })).toEqual([]);
    // One pair at a time needs 6,000 of the 10,000.
    expect(pairLegRoom({ ...RUN, params: { ...RUN.params, max_open_pairs: 1 } })).toEqual([]);
  });

  it('counts the pairs of each exchange, not of the run', () => {
    // The runs of 2026-11-13: one pair per exchange, two legs of 3,000 out of 10,000.
    const oneEach = {
      ...RUN,
      params: { ...RUN.params, pairs: 'CRWV/NBIS, xyz:CRWV/xyz:NBIS' },
      tracks: [{ venue: 'Lighter', market: 'CRWV' }, { venue: 'Lighter', market: 'NBIS' },
        { venue: 'Hyperliquid', market: 'xyz:CRWV' }, { venue: 'Hyperliquid', market: 'xyz:NBIS' }],
    };
    expect(pairLegRoom(oneEach)).toEqual([]);
    expect(pairLegRoom({ ...oneEach, capitalPerVenue: 5_000 }).map((room) => room.venue))
      .toEqual(['Hyperliquid', 'Lighter']);
  });

  it('uses the largest leg size and ignores a pair whose legs are not both selected', () => {
    expect(pairLegRoom({ ...RUN, params: { ...RUN.params, leg_usdc: 1000, leg_usdc_cme_closed: 6000 } })[0])
      .toMatchObject({ legUsdc: 6000, needed: 24_000 });
    // XAG is not selected, so XAU/XAG cannot open: Lighter is left with one pair, which fits.
    const halfSelected = { ...RUN, tracks: RUN.tracks.filter((track) => track.market !== 'XAG') };
    expect(pairLegRoom({ ...halfSelected, params: { ...RUN.params, max_open_pairs: 9 } })
      .map((room) => [room.venue, room.pairs])).toEqual([['Hyperliquid', 2]]);
  });

  it('says nothing about a LIVE run or a strategy without pairs', () => {
    expect(pairLegRoom({ ...RUN, live: { maxLeverage: 5 } })).toEqual([]);
    expect(pairLegRoom({ ...RUN, params: { ...RUN.params, pairs: '' } })).toEqual([]);
    expect(pairLegRoom({ ...RUN, params: { entry_bp: 8 } })).toEqual([]);
    expect(pairLegRoom({ ...RUN, params: null })).toEqual([]);
    expect(pairLegRoom({ ...RUN, capitalPerVenue: Number.NaN })).toEqual([]);
  });

  it('shows the sum and what to change on the launch page', () => {
    const html = renderToStaticMarkup(createElement(PairLegRoomNotice, { settings: RUN }));
    expect(html).toContain('The balance is too small for these pairs');
    expect(html).toContain('Lighter: 2 pairs open at once × 2 legs × 3,000 USDC = 12,000 USDC, over the 10,000 USDC balance.');
    expect(html).toContain('Hyperliquid: 2 pairs open at once');
    expect(html).toContain('Raise the starting balance to at least 12,000 USDC');
    expect(renderToStaticMarkup(createElement(PairLegRoomNotice, { settings: { ...RUN, capitalPerVenue: 12_000 } }))).toBe('');
  });
});
