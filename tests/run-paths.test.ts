import { describe, expect, it } from 'vitest';
import { isRunSetupPath, isRunsPath, newRunsAddress, runIdFromPath, runPath } from '../apps/web/src/lib/run-paths';

describe('runs page addresses', () => {
  it('lives under /runs and keeps the old /paper addresses working', () => {
    expect(runPath()).toBe('/runs');
    expect(runPath('run-1')).toBe('/runs/run-1');
    expect(runIdFromPath('/runs/abc')).toBe('abc');
    expect(runIdFromPath('/paper/abc')).toBe('abc');
    expect(runIdFromPath('/runs/new')).toBeNull();
    expect(runIdFromPath('/paper/setup')).toBeNull();
    expect(runIdFromPath('/runs')).toBeNull();
    expect(isRunSetupPath('/runs/new') && isRunSetupPath('/paper/setup')).toBe(true);
    expect(isRunsPath('/runs') && isRunsPath('/paper/abc') && !isRunsPath('/paperwork') && !isRunsPath('/')).toBe(true);
    expect(newRunsAddress('/paper')).toBe('/runs');
    expect(newRunsAddress('/paper/setup')).toBe('/runs/new');
    expect(newRunsAddress('/paper/abc')).toBe('/runs/abc');
    expect(newRunsAddress('/runs/abc')).toBeNull();
    expect(newRunsAddress('/accounts')).toBeNull();
  });
});
