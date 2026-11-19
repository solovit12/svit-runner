/**
 * When each open pair of a pair strategy reaches its "close at the mean" rule.
 *
 * A pair strategy with `mean_after_hours` holds a pair that has not reached its take-profit for that
 * many hours; after them it closes the pair as soon as the ratio touches its mean again. The runs list
 * shows the wait, so the owner sees from the list alone how long a pair may still be held.
 *
 * The moment is counted from the exchange position's own open time, which is the entry fill: the
 * strategy counts from its entry decision a second or two earlier. Its run page says the same thing
 * in the strategy's own words ("closes at its mean after 6 h: in 4 h 21 min").
 */
import { pairsFrom } from '../../../../packages/shared/src/pair-legs.js';
import type { PaperExperimentDetail, PaperRunMeanExit } from '../../../../packages/shared/src/paper-experiment-contracts.js';

const HOUR_MS = 3_600_000;

/** Empty for a run without the rule, without a Python pair strategy, or with nothing open. */
export function meanExitsOf(detail: PaperExperimentDetail): PaperRunMeanExit[] {
  const hours = Number(detail.params?.['mean_after_hours']);
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const pairs = pairsFrom(detail.params?.['pairs']);
  const found: PaperRunMeanExit[] = [];
  // Both legs of a pair open on one exchange, so each exchange's positions are paired on their own.
  for (const account of detail.runtime?.accounts ?? []) {
    const open = (account.positions ?? [])
      .map((position) => ({ market: position.market, openedMs: Date.parse(position.openedAt ?? '') }))
      .filter((position) => Number.isFinite(position.openedMs));
    const paired = new Set<string>();
    for (const pair of pairs) {
      const legs = open.filter((position) => pair.includes(position.market));
      if (legs.length === 0) continue;
      for (const leg of legs) paired.add(leg.market);
      found.push({ label: pair.join('/'), at: new Date(Math.min(...legs.map((leg) => leg.openedMs)) + hours * HOUR_MS).toISOString() });
    }
    // A market the `pairs` parameter does not name still has the rule: it waits on its own.
    for (const position of open) {
      if (!paired.has(position.market)) found.push({ label: position.market, at: new Date(position.openedMs + hours * HOUR_MS).toISOString() });
    }
  }
  return found.sort((left, right) => left.at.localeCompare(right.at) || left.label.localeCompare(right.label));
}
