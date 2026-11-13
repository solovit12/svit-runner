/** Shared display helpers of the runs pages. */

/** A server time in the viewer's local format; "—" when there is none. */
export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Green for a gain, red for a loss, nothing for zero or an unknown value. */
export function pnlClass(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : value > 0 ? 'paper-pnl-up' : value < 0 ? 'paper-pnl-down' : '';
}
