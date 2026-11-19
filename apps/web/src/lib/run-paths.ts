/**
 * Addresses of the runs pages. They were /paper, /paper/setup and /paper/<id> before 2026-11-12 (the page also
 * holds LIVE runs); the old addresses still open the same pages and are rewritten to the new ones.
 */
export const RUNS_PATH = '/runs';
export const RUN_SETUP_PATH = '/runs/new';

export function runPath(id?: string | null): string {
  return id ? `${RUNS_PATH}/${encodeURIComponent(id)}` : RUNS_PATH;
}

/**
 * A click the browser itself turns into a new tab or window: the middle button, or Cmd/Ctrl/Shift/Alt with the left
 * one. A link to a run must let such a click through instead of opening the run on the current page.
 */
export function opensInNewTab(event: { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
  return (event.button ?? 0) !== 0 || Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

export function isRunSetupPath(pathname: string): boolean {
  return pathname === RUN_SETUP_PATH || pathname === '/paper/setup';
}

export function isRunsPath(pathname: string): boolean {
  return /^\/(?:runs|paper)(?:\/|$)/.test(pathname);
}

/** The run id of /runs/<id> (or the old /paper/<id>); null for the list and the setup page. */
export function runIdFromPath(pathname: string): string | null {
  const match = /^\/(?:runs|paper)\/([^/]+)\/?$/.exec(pathname);
  if (!match || isRunSetupPath(pathname)) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}

/** The new address of an old /paper one (null when the address is not an old one). */
export function newRunsAddress(pathname: string): string | null {
  if (!/^\/paper(?:\/|$)/.test(pathname)) return null;
  if (isRunSetupPath(pathname)) return RUN_SETUP_PATH;
  const id = runIdFromPath(pathname);
  return id ? runPath(id) : RUNS_PATH;
}
