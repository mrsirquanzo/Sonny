import { z } from 'zod';
import { ClaimsSchema, type Claim, type Section, type TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag } from './rag.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import type { Specialist } from './specialists.js';

const SectionDraftSchema = z.object({ takeaway: z.string(), claims: ClaimsSchema.shape.claims });

function argsFor(toolName: string, query: string, symbol: string): Record<string, unknown> {
  if (toolName === 'open_targets_target') return { symbol };
  return { query: `${symbol} ${query}` }; // clinical_trials_search, pubmed_search, default
}

export async function produceSection(opts: {
  spec: Specialist;
  query: string;
  symbol: string;
  tools: Tool[];
  store: EvidenceStore;
  specialistModel: StructuredModel;
  verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<Section> {
  const { spec, query, symbol, tools, store, specialistModel, verifierModel, emit } = opts;
  emit({ type: 'specialist_start', specialist: spec.id });

  const chosen = tools.filter((t) => spec.toolNames.includes(t.name));
  const settled = await Promise.allSettled(chosen.map(async (t) => {
    const args = argsFor(t.name, query, symbol);
    emit({ type: 'tool_call', tool: t.name, args });
    const evidence = await t.call(args);
    emit({ type: 'tool_result', tool: t.name, count: evidence.length });
    return evidence;
  }));

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const e of r.value) {
        store.register(e);
        emit({ type: 'evidence_registered', id: e.id, title: e.title });
      }
    } else {
      emit({ type: 'error', message: `tool ${chosen[i].name} failed: ${String(r.reason)}` });
    }
  });

  const evidenceList = store.all().map((e) => `[${e.id}] (${e.kind}) ${e.title} — ${e.snippet}`).join('\n');
  const draft = await specialistModel.generateStructured({
    system: `You are the ${spec.title} specialist. ${spec.promptHint}\nUse ONLY the provided evidence. Every claim MUST cite the evidence id(s) it rests on. Provide a one-line takeaway and claims c1, c2, ... with confidence in [0,1].`,
    prompt: `QUESTION: ${query}\n\nEVIDENCE:\n${evidenceList}`,
    schema: SectionDraftSchema,
    model: MODEL_ROUTER.specialist,
  });

  for (const c of draft.claims) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(draft.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    id: spec.id,
    title: spec.title,
    takeaway: draft.takeaway,
    claims: supported,
    sources,
    rag: computeRag(shippable, verdicts),
  };
  emit({ type: 'section_complete', section });
  return section;
}
