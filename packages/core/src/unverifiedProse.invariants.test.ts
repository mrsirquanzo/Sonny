import { describe, it, expect } from 'vitest';
import type { Section, Claim, Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { produceResearchSection } from './produceResearchSection.js';
import { runResearcher } from './researcher.js';
import { weighAcrossThreads } from './weighing.js';
import { synthesizeRecommendation } from './synthesize.js';
import { groundNarrative } from './narrativeGrounding.js';

/**
 * The prose leak.
 *
 * Claims are gated by `groundClaims` + `verifyClaims`, but the dossier also
 * ships free prose - section takeaways, the cross-thread takeaway, the memo
 * framing, bottom line, executive read, and case points. Every test here fixes
 * one route by which an assertion that FAILED that gate reached the reader
 * anyway.
 */

// The rejected assertion. It never appears in a shipped artifact.
const REJECTED = 'CDCP1 cures pancreatic cancer in all patients.';
const SUPPORTED = 'CDCP1 promotes EMT in vitro.';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

const searchTool = tool('europepmc_search', [
  { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
    passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
]);
const fulltextTool = tool('pmc_fulltext', [
  { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
    snippet: 'Results', passage: 'CDCP1 promotes EMT.', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
]);

const isEntailmentJudge = (system: string) => system.includes('SENTENCE');
const isTakeawayWriter = (system: string) => system.includes('takeaway for the');
const isClaimVerifier = (system: string) => system.includes('adversarial scientific reviewer');

// These tests target prose grounding, not the coverage gate. Without an
// explicit verdict they would abstain before the memo is ever written.
const PROCEED = { proceed: true, reasons: [] };

describe('a claim that fails verification cannot survive as a section takeaway', () => {
  it('writes the takeaway from the supported claims only, and never shows the writer the rejected one', async () => {
    let takeawayPrompt = '';
    const specialistModel: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('Plan the specific')) {
          return { questions: [{ question: 'What is the MOA?', concept: 'mechanism' }] } as never;
        }
        if (o.system.includes('rigorous biomedical')) {
          return { claims: [
            { text: SUPPORTED, citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 },
            { text: REJECTED, citations: ['PMCID:PMC1#sec-1'], confidence: 0.9 },
          ] } as never;
        }
        if (isTakeawayWriter(o.system)) {
          takeawayPrompt = o.prompt;
          return { takeaway: SUPPORTED } as never;
        }
        // Mid-research reflection, written over drafts the verifier has not seen yet.
        return { done: true, followups: [], takeaway: REJECTED } as never;
      },
    };
    const verifierModel: StructuredModel = {
      async generateStructured(o) {
        if (isEntailmentJudge(o.system)) return { entailed: true, rationale: '' } as never;
        if (isClaimVerifier(o.system)) {
          const status = o.prompt.includes(REJECTED) ? 'overreach' : 'supported';
          return { claimId: 'x', status, rationale: 'r' } as never;
        }
        return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never;
      },
    };

    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [searchTool, fulltextTool], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {}, budget: { maxRounds: 1 },
    });

    expect(section.claims.map((c) => c.text)).toEqual([SUPPORTED]);
    expect(takeawayPrompt).toContain(SUPPORTED);
    expect(takeawayPrompt).not.toContain(REJECTED);   // the writer never saw it
    expect(section.takeaway).not.toContain('cures');  // and it is not in the shipped prose
    expect(section.takeaway).toBe(SUPPORTED);
  });

  it('degrades to a verified claim verbatim when the written takeaway is not entailed', async () => {
    const specialistModel: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', concept: 'mechanism' }] } as never;
        if (o.system.includes('rigorous biomedical')) {
          return { claims: [{ text: SUPPORTED, citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] } as never;
        }
        // The writer overreaches past the one finding it was given.
        if (isTakeawayWriter(o.system)) return { takeaway: REJECTED } as never;
        return { done: true, followups: [], takeaway: 'note' } as never;
      },
    };
    const verifierModel: StructuredModel = {
      async generateStructured(o) {
        if (isEntailmentJudge(o.system)) return { entailed: false, rationale: 'overreaches' } as never;
        if (isClaimVerifier(o.system)) return { claimId: 'x', status: 'supported', rationale: 'r' } as never;
        return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never;
      },
    };

    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [searchTool, fulltextTool], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {}, budget: { maxRounds: 1 },
    });

    expect(section.takeaway).toBe(SUPPORTED); // the verified claim, not the unentailed synthesis
  });

  it('says so plainly when nothing survived verification', async () => {
    const specialistModel: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', concept: 'mechanism' }] } as never;
        if (o.system.includes('rigorous biomedical')) {
          return { claims: [{ text: REJECTED, citations: ['PMCID:PMC1#sec-1'], confidence: 0.9 }] } as never;
        }
        if (isTakeawayWriter(o.system)) throw new Error('must not write a takeaway with no supported claims');
        return { done: true, followups: [], takeaway: REJECTED } as never;
      },
    };
    const verifierModel: StructuredModel = {
      async generateStructured(o) {
        if (isClaimVerifier(o.system)) return { claimId: 'x', status: 'unsupported', rationale: 'r' } as never;
        return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never;
      },
    };

    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [searchTool, fulltextTool], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {}, budget: { maxRounds: 1 },
    });

    expect(section.claims).toEqual([]);
    expect(section.takeaway).toBe('No claim in this section survived verification.');
  });
});

describe('reflection reasons over grounded claims only', () => {
  it('hides a claim whose citation does not resolve from the follow-up plan', async () => {
    let reflectPrompt = '';
    const model: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', concept: 'mechanism' }] } as never;
        if (o.system.includes('rigorous biomedical')) {
          return { claims: [
            { text: SUPPORTED, citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 },
            { text: REJECTED, citations: ['PMID:GHOST'], confidence: 0.9 },
          ] } as never;
        }
        reflectPrompt = o.prompt;
        return { done: true, followups: [], takeaway: 'note' } as never;
      },
    };
    const verifierModel: StructuredModel = {
      async generateStructured() { return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never; },
    };

    const events: TraceEvent[] = [];
    const findings = await runResearcher({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [searchTool, fulltextTool], store: new EvidenceStore(),
      model, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    expect(reflectPrompt).toContain(SUPPORTED);
    expect(reflectPrompt).not.toContain(REJECTED); // ungrounded draft never steered the plan
    expect(findings.reflectionNote).toBe('note');
  });
});

describe('weighing does not treat takeaways as facts', () => {
  const store = () => {
    const s = new EvidenceStore();
    s.register({ id: 'PMID:1', kind: 'publication', source: 'PMC', title: 'P', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
    return s;
  };
  const sections: Section[] = [{
    kind: 'research', id: 'a', title: 'A', takeaway: REJECTED,
    claims: [{ id: 'c1', text: SUPPORTED, citations: ['PMID:1'], confidence: 0.8 }],
    sources: ['PMID:1'], rag: 'amber',
  }];

  it('keeps section takeaways out of the digest the lead weighs', async () => {
    let leadPrompt = '';
    const leadModel: StructuredModel = {
      async generateStructured(o) { leadPrompt = o.prompt; return { takeaway: 'tk', claims: [] } as never; },
    };
    const verifierModel: StructuredModel = { async generateStructured() { return { entailed: true, rationale: '' } as never; } };
    await weighAcrossThreads({ sections, store: store(), leadModel, verifierModel, emit: () => {} });

    expect(leadPrompt).toContain(SUPPORTED);
    expect(leadPrompt).not.toContain(REJECTED);
  });

  it('degrades its own takeaway when the reconciliation it summarized was rejected', async () => {
    const leadModel: StructuredModel = {
      async generateStructured() {
        return { takeaway: REJECTED, claims: [
          { id: 'w1', text: REJECTED, citations: ['PMID:1'], confidence: 0.7 },
        ] } as never;
      },
    };
    const verifierModel: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('SENTENCE')) return { entailed: true, rationale: '' } as never;
        return { claimId: 'x', status: 'overreach', rationale: 'r' } as never;
      },
    };
    const out = await weighAcrossThreads({ sections, store: store(), leadModel, verifierModel, emit: () => {} });

    expect(out.claims).toEqual([]);
    expect(out.takeaway).toBe('No cross-thread reconciliation survived verification.');
  });
});

// ------------------------------------------------------------------ synthesis

const synthSections: Section[] = [{
  kind: 'research', id: 'a', title: 'A', takeaway: REJECTED,
  claims: [
    { id: 'c1', text: SUPPORTED, citations: ['PMID:1'], confidence: 0.9 },
    { id: 'c2', text: 'CDCP1 is expressed in tumor tissue.', citations: ['PMID:1'], confidence: 0.9 },
  ],
  sources: ['PMID:1'], rag: 'amber',
}];
const synthEvidence: Evidence[] = [
  { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
  // Present in the store but backing no verified claim.
  { id: 'PMID:UNUSED', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
];
const emptyWeighing = { takeaway: REJECTED, claims: [] as Claim[] };

function writer(draft: unknown, judge: (sentence: string) => boolean, onWrite?: (prompt: string) => void): StructuredModel {
  return {
    async generateStructured(o) {
      if (o.system.includes('SENTENCE')) {
        const sentence = o.prompt.split('\n')[1] ?? '';
        return { entailed: judge(sentence), rationale: '' } as never;
      }
      onWrite?.(o.prompt);
      return draft as never;
    },
  };
}

describe('a case point with no valid citation is dropped', () => {
  it('drops uncited points and points citing evidence that backs no verified claim', async () => {
    const model = writer({
      verdict: 'watch', thesis: 't', framing: 'f', bottomLine: 'bl', conditions: [], executiveRead: 'er',
      bull: [
        { point: 'Uncited assertion about efficacy.', citations: [] },
        { point: 'Cited assertion.', citations: ['PMID:1'] },
      ],
      bear: [
        { point: 'Decorated with an id that backs nothing.', citations: ['PMID:UNUSED'] },
        { point: 'Phantom id only.', citations: ['PMID:999'] },
      ],
    }, () => true);

    const { recommendation } = await synthesizeRecommendation({ abstention: PROCEED,
      target: 'CDCP1', sections: synthSections, weighing: emptyWeighing, evidence: synthEvidence, model,
    });

    expect(recommendation.bull).toEqual([{ point: 'Cited assertion.', citations: ['PMID:1'] }]);
    expect(recommendation.bear).toEqual([]);
  });
});

describe('memo prose is held to entailment against the verified findings', () => {
  it('drops the unentailed sentences and keeps the supported ones', async () => {
    const model = writer({
      verdict: 'watch', thesis: 't',
      framing: `${SUPPORTED} ${REJECTED}`,
      bull: [], bear: [], bottomLine: 'bl',
      conditions: ['Run a Phase 1 in PDAC.'],
      executiveRead: `${REJECTED} ${SUPPORTED}`,
    }, (sentence) => !sentence.includes('cures'));

    const { recommendation, executiveRead } = await synthesizeRecommendation({ abstention: PROCEED,
      target: 'CDCP1', sections: synthSections, weighing: emptyWeighing, evidence: synthEvidence, model,
    });

    expect(recommendation.framing).toBe(SUPPORTED);
    expect(recommendation.thesis).toBe(SUPPORTED);
    expect(executiveRead).toBe(SUPPORTED);
    expect(recommendation.conditions).toEqual(['Run a Phase 1 in PDAC.']); // a proposal is not stripped
  });

  it('keeps section takeaways out of the digest the memo is written from', async () => {
    let prompt = '';
    const model = writer(
      { verdict: 'watch', thesis: 't', framing: 'f', bull: [], bear: [], bottomLine: 'bl', conditions: [], executiveRead: 'er' },
      () => true,
      (p) => { prompt = p; },
    );
    await synthesizeRecommendation({ abstention: PROCEED,
      target: 'CDCP1', sections: synthSections, weighing: emptyWeighing, evidence: synthEvidence, model,
    });

    expect(prompt).toContain(SUPPORTED);
    expect(prompt).not.toContain(REJECTED);
  });

  it('fails closed: a judge that throws strips the prose rather than shipping it', async () => {
    const model: StructuredModel = {
      async generateStructured(o) {
        if (o.system.includes('SENTENCE')) throw new Error('judge unavailable');
        return {
          verdict: 'watch', thesis: 't', framing: REJECTED, bull: [], bear: [],
          bottomLine: REJECTED, conditions: [], executiveRead: REJECTED,
        } as never;
      },
    };
    const { recommendation, executiveRead } = await synthesizeRecommendation({ abstention: PROCEED,
      target: 'CDCP1', sections: synthSections, weighing: emptyWeighing, evidence: synthEvidence, model,
    });

    expect(recommendation.framing).not.toContain('cures');
    expect(recommendation.bottomLine).not.toContain('cures');
    expect(executiveRead).not.toContain('cures');
    // The degradation is stated, not silently a thinner version of the same read.
    expect(recommendation.framing).toContain('CDCP1');
  });
});

describe('groundNarrative', () => {
  it('spends no judge call when there is nothing verified to entail against', async () => {
    let calls = 0;
    const model: StructuredModel = { async generateStructured() { calls++; return { entailed: true } as never; } };
    const out = await groundNarrative({ text: 'Anything at all.', facts: [], model });
    expect(out.text).toBe('');
    expect(out.dropped).toEqual(['Anything at all.']);
    expect(calls).toBe(0);
  });

  it('treats a response without an explicit entailment as unsupported', async () => {
    const model: StructuredModel = { async generateStructured() { return {} as never; } };
    const out = await groundNarrative({ text: 'A claim.', facts: ['a fact'], model });
    expect(out.text).toBe('');
  });
});
