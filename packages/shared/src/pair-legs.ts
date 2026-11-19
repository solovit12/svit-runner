/**
 * Pairs of a pair strategy, and whether its legs fit a Paper exchange balance.
 *
 * Paper trades the virtual account's own cash: the engine gives it leverage 1, so every open leg is
 * paid in full from that exchange's balance. A pair opens both legs in the same instant, and the
 * capital check sees only the positions already open, so two pairs of 3,000 per leg on one exchange
 * send 12,000 of orders against a 10,000 balance: the fourth leg is refused and the run stops
 * (run ea8bf612, 2026-11-13). The launch page warns about this before the run starts.
 */

/** Every leg size a pair strategy may use; the largest one decides what must fit. */
const LEG_SIZE_PARAMS = ['leg_usdc', 'leg_usdc_cme_closed'] as const;
const LEGS_PER_PAIR = 2;

/** "BRENTOIL/WTI, XAU/XAG" -> [["BRENTOIL", "WTI"], ["XAU", "XAG"]]; anything else -> []. */
export function pairsFrom(value: unknown): string[][] {
  if (typeof value !== 'string' || value.length > 2_000) return [];
  return value.split(/[,;\n]/).map((item) => item.trim().split('/').map((market) => market.trim()))
    .filter((pair) => pair.length === 2 && pair.every((market) => /^[A-Za-z0-9:._-]{1,40}$/.test(market)));
}

export interface PairLegRoom {
  /** The exchange whose balance is too small. */
  readonly venue: string;
  /** Pairs that can be open on it at once (its own pairs, capped by "Pairs open at once"). */
  readonly pairs: number;
  readonly legUsdc: number;
  /** What those pairs need: pairs x 2 legs x leg size. */
  readonly needed: number;
  readonly balance: number;
}

function positive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The exchanges whose balance cannot hold every leg this pair strategy may open at once.
 * Empty for a LIVE run (the real account and its leverage decide), for a strategy without pairs
 * or a leg size in USDC, and whenever the legs fit.
 */
export function pairLegRoom(settings: {
  readonly params?: Readonly<Record<string, unknown>> | null;
  readonly tracks: readonly { readonly venue: string; readonly market: string }[];
  readonly capitalPerVenue?: number | null;
  readonly live?: unknown;
}): PairLegRoom[] {
  const params = settings.params;
  const balance = positive(settings.capitalPerVenue);
  if (!params || settings.live || balance === null) return [];
  const legUsdc = Math.max(...LEG_SIZE_PARAMS.map((name) => positive(params[name]) ?? 0));
  const pairs = pairsFrom(params['pairs']);
  if (legUsdc <= 0 || pairs.length === 0) return [];
  const venueOf = new Map(settings.tracks.map((track) => [track.market, track.venue]));
  const perVenue = new Map<string, number>();
  for (const [first, second] of pairs) {
    const venue = venueOf.get(first!);
    // Only a pair whose both legs are selected on one exchange opens there.
    if (venue !== undefined && venue === venueOf.get(second!)) perVenue.set(venue, (perVenue.get(venue) ?? 0) + 1);
  }
  const atOnce = positive(params['max_open_pairs']);
  return [...perVenue].map(([venue, count]) => {
    const pairsOpen = atOnce === null ? count : Math.min(atOnce, count);
    return { venue, pairs: pairsOpen, legUsdc, needed: pairsOpen * LEGS_PER_PAIR * legUsdc, balance };
  }).filter((room) => room.needed > room.balance).sort((left, right) => left.venue.localeCompare(right.venue));
}
