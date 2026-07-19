import { z } from 'zod';
import type { Claim, Section, TraceEvent, Verdict } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import type { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag, type SourceIdentityResolver } from './rag.js';
import { extractClaims } from './researcher.js';
import { safeToolCall } from './safeToolCall.js';
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
import { buildSearchQuery } from './searchQuery.js';

export interface ResearchGap { specialistId: string; question: string; concept: string; reason: string }

const CompletenessSchema = z.object({
  complete: z.boolean(),
  gaps: z.array(z.object({
    specialistId: z.string().min(1),
    question: z.string().min(1),
    concept: z.string().min(1),
    reason: z.string().min(1),
  })).max(5),
});

export async function assessCompleteness(
  sections: Section[], model: StructuredModel,
): Promise<{ complete: boolean; gaps: ResearchGap[] }> {
  const summary = sections.map((s) =>
    `- [${s.rag}] ${s.id} (${s.title}): ${s.takeaway} (${s.claims.length} claims, ${s.sources.length} sources)`,
  ).join('\n');
  return model.generateStructured({
    system: `You are the lead reviewer of a target-assessment dossier. Judge whether the assessment is complete enough for an expert reader. A red or thin section, or an obvious unanswered question (e.g. resistance mechanisms, safety, a missing modality), is a gap. For each gap, name the existing section id it belongs to, a precise follow-up question, a single concept (ONE short topic facet of 1-2 words, no sentence, and do NOT include the target gene symbol - it is added automatically), and the reason. If the dossier is sufficient, set complete=true with no gaps.`,
    prompt: `SECTIONS:\n${summary}\n\nReturn complete and up to 5 gaps, each tagged to one of the section ids above.`,
    schema: CompletenessSchema,
    model: MODEL_ROUTER.specialist,
  });
}

export async function fillGap(opts: {
  gap: ResearchGap; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<Claim[]> {
  const { gap, target, tools, store, specialistModel, verifierModel, emit } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) throw new Error('fillGap requires europepmc_search and pmc_fulltext tools');

  emit({ type: 'gap_filler', specialist: gap.specialistId, question: gap.question });
  const terms = targetTerms(store);
  const query = buildSearchQuery(target, gap.concept);
  emit({ type: 'tool_call', tool: search.name, args: { query } });
  const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
  for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

  const top = hits.find((h) =>
    titleMentionsTarget(h, terms) &&
    (h.raw as { pmcid?: string })?.pmcid &&
    (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (top) {
    const pmcid = (top.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
    for (const p of passages) {
      store.register(p);
      emit({ type: 'evidence_registered', id: p.id, title: p.title });
      emit({ type: 'research_read', specialist: gap.specialistId, sourceId: p.id, locator: p.locator ?? p.title });
    }
  }

  const evidenceList = store.all().map((e) => `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} - ${e.passage ?? e.snippet}`).join('\n');
  const drafted = await extractClaims(gap.question, evidenceList, specialistModel);
  for (const c of drafted) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(drafted, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const vd of verdicts) emit({ type: 'verdict', verdict: vd });
  return shippable.filter((c) => verdicts.find((vd) => vd.claimId === c.id)?.status === 'supported');
}

export function mergeGapClaims(
  section: Section,
  newClaims: Claim[],
  resolveSourceIdentity: SourceIdentityResolver,
): Section {
  if (newClaims.length === 0) return section;
  const claims = [...section.claims, ...newClaims];
  const sources = [...new Set(claims.flatMap((c) => c.citations))];
  const verdicts: Verdict[] = claims.map((c) => ({ claimId: c.id, status: 'supported', rationale: '' }));
  return { ...section, claims, sources, rag: computeRag(claims, verdicts, resolveSourceIdentity) };
}
