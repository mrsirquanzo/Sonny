import { describe, it, expect } from 'vitest';
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';

describe('detectLiveCapabilities', () => {
  it('reports all capabilities present', () => {
    const caps = detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k', SONNY_EPO_KEY: 'a', SONNY_EPO_SECRET: 'b', SONNY_ANARCI: '1' } as NodeJS.ProcessEnv);
    expect(caps).toMatchObject({ live: true, anthropic: true, epo: true, anarci: true });
    expect(caps.reasons).toEqual([]);
  });

  it('lists reasons for each missing capability', () => {
    const caps = detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(caps.epo).toBe(false);
    expect(caps.anarci).toBe(false);
    expect(caps.reasons.join(' ')).toContain('EPO');
    expect(caps.reasons.join(' ')).toContain('ANARCI');
  });

  it('liveEnabled requires live + anthropic', () => {
    expect(liveEnabled(detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv))).toBe(true);
    expect(liveEnabled(detectLiveCapabilities({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv))).toBe(false);
    expect(liveEnabled(detectLiveCapabilities({ SONNY_LIVE: '1' } as NodeJS.ProcessEnv))).toBe(false);
  });
});
