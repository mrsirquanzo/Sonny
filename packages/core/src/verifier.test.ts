import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Claim, Evidence } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from './evidenceStore.js';
import { verifyClaims } from './verifier.js';
import type { StructuredModel } from './model.js';

const ev = (id: string, snippet: string): Evidence => ({ id, kind: 'publication', source: 'PubMed', title: 't', snippet, url: 'u', raw: {}, retrievedAt: 'now' });
const claim = (id: string, text: string): Claim => ({ id, text, citations: ['PMID:1'], confidence: 0.9 });

const fakeModel: StructuredModel = {
  async generateStructured({ prompt, schema }) {
    const status = prompt.includes('cures everything') ? 'overreach' : 'supported';
    return schema.parse({ claimId: 'will-be-overwritten', status, rationale: 'r' }) as z.infer<typeof schema>;
  },
};

describe('verifyClaims', () => {
  it('produces one verdict per claim, keyed to the claim id', async () => {
    const s = new EvidenceStore(); s.register(ev('PMID:1', 'evidence text'));
    const verdicts = await verifyClaims([claim('c1', 'normal claim'), claim('c2', 'drug cures everything')], s, fakeModel);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ claimId: 'c1', status: 'supported' });
    expect(verdicts[1]).toMatchObject({ claimId: 'c2', status: 'overreach' });
  });

  it('shows the verifier the full-text passage when present, not just the snippet', async () => {
    const store = new EvidenceStore();
    store.register({
      id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC',
      snippet: 'abstract line', passage: 'CDCP1 promotes EMT in nasopharyngeal carcinoma cells.',
      locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now',
    });
    let seenPrompt = '';
    const model: StructuredModel = {
      async generateStructured({ prompt }) {
        seenPrompt = prompt;
        return { claimId: 'x', status: 'supported', rationale: 'ok' } as never;
      },
    };
    const claims: Claim[] = [{ id: 'c1', text: 'CDCP1 drives EMT', citations: ['PMID:1'], confidence: 0.8 }];
    await verifyClaims(claims, store, model);
    expect(seenPrompt).toContain('CDCP1 promotes EMT in nasopharyngeal carcinoma cells.');
    expect(seenPrompt).toContain('Results');
  });
});
