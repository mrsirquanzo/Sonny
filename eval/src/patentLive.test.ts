import { describe, it, expect } from 'vitest';
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';

const caps = detectLiveCapabilities();

describe('patentLive (opt-in)', () => {
  it.skipIf(!liveEnabled(caps))('runs the live pipeline over verified goldens and meets thresholds', async () => {
    const { runLivePatent } = await import('./patentLive.js');
    const { loadGoldens } = await import('./goldenLoader.js');
    const verified = loadGoldens().filter((l) => l.groundTruthVerified);
    for (const l of verified) {
      const file = process.env[`SONNY_GOLDEN_FILE_${l.golden.name}`];
      if (!file) continue;
      const report = await runLivePatent(l.golden, file, caps);
      expect(report.metrics.residueFidelity).toBeGreaterThanOrEqual(0.99);
      expect(report.metrics.extractionRecall).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('module exports runLivePatent and it never asserts on its own', async () => {
    const mod = await import('./patentLive.js');
    expect(typeof mod.runLivePatent).toBe('function');
  });
});
