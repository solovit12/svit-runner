import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import { reloadForNewBuild } from '../apps/web/src/lib/lazy-reload';

afterEach(() => vi.unstubAllGlobals());

describe('a tab opened before an update', () => {
  // 2026-11-13: Run Duplicate in a tab of the previous build asked for a chart file that the update removed.
  it('reloads the page once, and shows the error if the new page fails again right away', () => {
    const stored = new Map<string, string>();
    const reload = vi.fn();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
    vi.stubGlobal('location', { reload });
    expect(reloadForNewBuild(1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewBuild(1_010_000)).toBe(false);          // 10 s later: a real error, no reload loop
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewBuild(1_040_000)).toBe(true);           // later on: an update again
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!existsSync(path.join(process.cwd(), 'dist', 'web', 'index.html')))(
    'gets "not found" for a script of an older build instead of the page', async () => {
      const app = await buildApp();
      try {
        const gone = await app.inject({ method: 'GET', url: '/assets/PriceChart-old.js' });
        expect(gone.statusCode).toBe(404);
        expect(gone.headers['content-type']).toContain('text/plain');
        const page = await app.inject({ method: 'GET', url: '/runs' });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('<!doctype html>');
      } finally { await app.close(); }
    });
});
