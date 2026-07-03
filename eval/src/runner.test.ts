import { describe, it, expect } from 'vitest';
import { loadGolden } from './runner.js';

describe('loadGolden', () => {
  it('loads and validates the fast subset (CDCP1 + ZXQR7)', async () => {
    const targets = await loadGolden('fast');
    const names = targets.map((t) => t.target).sort();
    expect(names).toEqual(['CDCP1', 'ZXQR7']);
  });

  it('loads all golden targets for the full subset', async () => {
    const targets = await loadGolden('full');
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });
});
