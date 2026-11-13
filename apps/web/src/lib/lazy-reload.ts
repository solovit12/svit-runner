import { lazy, type ComponentType } from 'react';

/** When the page last reloaded itself for a newer build of the site (this tab only). */
const RELOADED_AT_KEY = 'psr.reloadedForNewBuildAt';
/** A second failure this soon after a reload is a real error (offline, blocked), not an old tab. */
const RELOAD_PAUSE_MS = 30_000;

/**
 * A tab opened before an update still runs the old build; the parts it loads later (the code
 * editor, the chart) no longer exist on the server. Reload the page once to get the new build.
 * Returns false when it already reloaded a moment ago, so the error is shown instead of a loop.
 */
export function reloadForNewBuild(now = Date.now()): boolean {
  let last = 0;
  try { last = Number(globalThis.sessionStorage?.getItem(RELOADED_AT_KEY) ?? 0) || 0; } catch { /* storage blocked */ }
  if (now - last < RELOAD_PAUSE_MS) return false;
  try { globalThis.sessionStorage?.setItem(RELOADED_AT_KEY, String(now)); } catch { /* reload anyway */ }
  globalThis.location?.reload();
  return true;
}

/** React.lazy that reloads the page once when the part it loads is gone after an update. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component, as React.lazy itself
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().catch((error: unknown) => {
    if (reloadForNewBuild()) return new Promise<{ default: T }>(() => undefined);   // the page is reloading
    throw error;
  }));
}
