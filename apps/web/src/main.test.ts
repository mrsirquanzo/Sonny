// Test that buildDeps returns correct shape AND makeRunner returns a function without throwing
// (no API key needed - models built lazily)
import { describe, it, expect } from 'vitest';
import { buildDeps } from './main.js';

describe('buildDeps', () => {
  it('returns publicDir and makeRunner', () => {
    const deps = buildDeps('/tmp/public');
    expect(deps.publicDir).toBe('/tmp/public');
    expect(typeof deps.makeRunner).toBe('function');
  });

  it('makeRunner returns a function without throwing (no API key needed)', () => {
    const deps = buildDeps('/tmp/public');
    const runner = deps.makeRunner('q', 'EGFR');
    expect(typeof runner).toBe('function');
  });
});
