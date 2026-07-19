import { z } from 'zod';
import { ClaimsSchema, type Claim } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
import { snowballCitations } from './snowball.js';
import { retrieveResearchHits } from './hybridRetrieval.js';

export interface ThreadBrief { id: string; title: string; objective: string; promptHint: string }

export interface ResearchQuestion { question: string; concept: string }

export interface ResearchContext { indication?: string; modality?: string }

function researchScope(target: string, context?: ResearchContext): string {
  if (!context) return '';
  const indication = context.indication ?? 'not specified';
  const modality = context.modality ?? 'not specified';
  return `This evaluation is scoped to INDICATION: ${indication} and MODALITY: ${modality}. Prioritise questions and claims that bear on whether ${target} is a viable ${modality} target in ${indication}. Do not drift to other indications except as brief comparison.`;
}

function withResearchScope(text: string, target: string, context?: ResearchContext): string {
  const scope = researchScope(target, context);
  return scope ? `${text}\n${scope}` : text;
}

const QuestionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    concept: z.string().min(1),
  })).min(1).max(5),
});

export async function planResearchQuestions(
  brief: ThreadBrief, target: string, model: StructuredModel, context?: ResearchContext,
): Promise<ResearchQuestion[]> {
  const { questions } = await model.generateStructured({
    system: withResearchScope(`You are the ${brief.title} research specialist. ${brief.promptHint}\nPlan the specific, answerable research questions you must investigate to assess this target at expert depth.\nFor each item return:\n- question: a precise, answerable research question\n- concept: ONE short topic facet of 1-2 words that narrows the search (examples: 'ADC', 'oncology', 'signaling', 'metastasis', 'resistance'). Do NOT include the target gene symbol - it is added automatically. Do NOT write a sentence or a list of keywords, just the single concept.`, target, context),
    prompt: `BRIEF: ${brief.title}\nTARGET: ${target}\nOBJECTIVE: ${brief.objective}\nList up to 5 research questions, most important first. Each must have a question and a single short concept.`,
    schema: QuestionsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return questions;
}

export async function extractClaims(
  question: string, evidenceList: string, model: StructuredModel, context?: ResearchContext,
): Promise<Claim[]> {
  const { claims } = await model.generateStructured({
    system: withResearchScope(`You are a rigorous biomedical research specialist. Answer the research question using ONLY the provided evidence passages. Every claim MUST cite the evidence id(s) it rests on, copied verbatim. If the evidence conflicts, write a reconciliation claim that names the tension and states which way it leans and why. Do not state anything the evidence does not support.`, 'this target', context),
    prompt: `RESEARCH QUESTION: ${question}\n\nEVIDENCE:\n${evidenceList}\n\nReturn claims c1, c2, ... each with citations and a confidence in [0,1].`,
    schema: ClaimsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return claims;
}

import type { Evidence, TraceEvent, MethodologicalCritique } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { safeToolCall } from './safeToolCall.js';
import { runSkepticAudit } from './critique/skepticAudit.js';
import { researchFigures } from './figureStep.js';

export interface ResearchBudget { maxRounds: number }
export interface ThreadFindings { takeaway: string; claims: Claim[]; openQuestions: string[]; critiques: MethodologicalCritique[] }

const ReflectSchema = z.object({
  done: z.boolean(),
  followups: z.array(z.object({
    question: z.string().min(1),
    concept: z.string().min(1),
  })).max(3),
  takeaway: z.string(),
});

export async function reflectOnGaps(
  brief: ThreadBrief, claims: Claim[], model: StructuredModel, context?: ResearchContext,
): Promise<{ done: boolean; followups: ResearchQuestion[]; takeaway: string }> {
  return model.generateStructured({
    system: withResearchScope(`You are the ${brief.title} research lead reviewing your own progress. Decide whether the thread is sufficiently covered for expert-level assessment. If a critical question remains unanswered, or a source raised a new high-value thread (e.g. a resistance mechanism), list up to 3 follow-up questions. Each follow-up needs:\n- question: a precise research question\n- concept: ONE short topic facet of 1-2 words (no sentence, no keyword list) and do NOT include the target gene symbol - it is added automatically\nOtherwise set done=true. Always write a one-line takeaway summarizing the thread so far.`, 'this target', context),
    prompt: `OBJECTIVE: ${brief.objective}\n\nCLAIMS SO FAR:\n${claims.map((c) => `- ${c.text}`).join('\n') || '(none yet)'}`,
    schema: ReflectSchema,
    model: MODEL_ROUTER.specialist,
  });
}

function evidenceLine(e: Evidence): string {
  return `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} - ${e.passage ?? e.snippet}`;
}

export async function runResearcher(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  model: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
}): Promise<ThreadFindings> {
  const { brief, target, tools, store, model, verifierModel, emit, budget, context } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) throw new Error('runResearcher requires europepmc_search and pmc_fulltext tools');

  emit({ type: 'specialist_start', specialist: brief.id });
  const terms = targetTerms(store, target);
  let openQuestions: ResearchQuestion[] = await planResearchQuestions(brief, target, model, context);
  emit({ type: 'research_plan', specialist: brief.id, questions: openQuestions.map((q) => q.question) });

  const claims: Claim[] = [];
  let takeaway = '';
  let snowballed = false;
  const critiques: MethodologicalCritique[] = [];
  const audited: { ids: Set<string>; redFlags: MethodologicalCritique['redFlags'] }[] = [];

  for (let round = 0; round < budget.maxRounds && openQuestions.length > 0; round++) {
    const item = openQuestions[0];

    const hits = await retrieveResearchHits({
      specialist: brief.id,
      target,
      question: item.question,
      concept: item.concept,
      terms,
      search,
      model,
      emit,
    });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
    for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

    // Deep-read the top open-access hit whose TITLE names the target. Strict: if none
    // qualifies, read no full text this round rather than deep-read a tangential paper.
    const top = hits.find((h) =>
      titleMentionsTarget(h, terms) &&
      (h.raw as { pmcid?: string })?.pmcid &&
      (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      // Gate the sections: a title-relevant paper still carries off-topic sections.
      const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        emit({ type: 'evidence_registered', id: p.id, title: p.title });
        emit({ type: 'research_read', specialist: brief.id, sourceId: p.id, locator: p.locator ?? p.title });
      }
      try {
        const critique = await runSkepticAudit(top, verifierModel);
        critiques.push(critique);
        emit({ type: 'methodological_critique', specialist: brief.id, critique });
        if (critique.redFlags.length) {
          audited.push({ ids: new Set<string>([top.id, ...passages.map((p) => p.id)]), redFlags: critique.redFlags });
        }
      } catch (err) {
        emit({ type: 'error', message: `skeptic audit failed: ${String(err)}` });
      }
      // Figures: additive, gated, and degrades text-only. Captions land in the
      // store here and flow into extractClaims via store.all() below.
      // Opt-in (=== 'on') until Slice 4b lands the real sidecar: with no sidecar,
      // running this would duplicate the efetch, register captions unconditionally,
      // and emit a failing localhost POST on every deep-read. Slice 4b flips the default.
      if (process.env.SONNY_FIGURES === 'on') {
        await researchFigures({ pmcid, question: item.question, store, emit, specialist: brief.id });
      }
      if (!snowballed) {
        snowballed = true;
        await snowballCitations({ seed: top, terms, tools, store, emit });
      }
    }

    const evidenceList = store.all().map(evidenceLine).join('\n');
    const drafted = await extractClaims(item.question, evidenceList, model, context);
    for (const c of drafted) {
      const flags = audited.filter((a) => c.citations.some((id) => a.ids.has(id))).flatMap((a) => a.redFlags);
      if (flags.length) c.redFlags = flags;
      claims.push(c);
      emit({ type: 'claim_drafted', claim: c });
    }

    const reflection = await reflectOnGaps(brief, claims, model, context);
    takeaway = reflection.takeaway;
    emit({ type: 'research_reflect', specialist: brief.id, note: reflection.takeaway, followups: reflection.followups.map((f) => f.question) });
    openQuestions = reflection.done ? [] : reflection.followups;
  }

  return { takeaway, claims, openQuestions: openQuestions.map((q) => q.question), critiques };
}
