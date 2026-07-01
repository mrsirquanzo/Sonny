import { ClaimsSchema, type Claim, type TraceEvent, type Verdict } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SPECIALIST_SYSTEM = `You are a Target-Biology specialist. Using ONLY the provided evidence, write factual claims.
Every claim MUST cite the evidence id(s) it is based on (e.g. "ENSG00000146648", "PMID:123"). If the evidence does not
support a statement, do not make it. Return claims with ids c1, c2, ... and a confidence in [0,1].`;

function argsForTool(name: string, query: string, symbol: string): Record<string, unknown> {
  if (name === 'open_targets_search') return { symbol };
  if (name === 'pubmed_search') return { query: `${symbol} ${query}` };
  return { query };
}

export async function runOrchestration(opts: {
  query: string; symbol: string; tools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<{ section: string; shipped: Claim[]; verdicts: Verdict[] }> {
  const { query, symbol, tools, specialistModel, verifierModel, emit } = opts;
  const store = new EvidenceStore();

  emit({ type: 'plan', specialists: ['target_biology'], tools: tools.map((t) => t.name) });

  // Fan out over tools; one failure must not discard the rest.
  const settled = await Promise.allSettled(tools.map(async (t) => {
    const args = argsForTool(t.name, query, symbol);
    emit({ type: 'tool_call', tool: t.name, args });
    const evidence = await t.call(args);
    emit({ type: 'tool_result', tool: t.name, count: evidence.length });
    return evidence;
  }));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const e of r.value) { store.register(e); emit({ type: 'evidence_registered', id: e.id, title: e.title }); }
    } else {
      emit({ type: 'error', message: `tool ${tools[i].name} failed: ${String(r.reason)}` });
    }
  });

  const evidenceList = store.all().map((e) => `[${e.id}] ${e.title} — ${e.snippet}`).join('\n');
  const drafted = await specialistModel.generateStructured({
    system: SPECIALIST_SYSTEM,
    prompt: `QUESTION:\n${query}\n\nEVIDENCE:\n${evidenceList}`,
    schema: ClaimsSchema, model: MODEL_ROUTER.specialist,
  });
  for (const c of drafted.claims) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(drafted.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const section = supported.map((c) => `${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  emit({ type: 'synthesis', section });

  return { section, shipped: supported, verdicts };
}
