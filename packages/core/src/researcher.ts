import { z } from 'zod';
import { ClaimsSchema, type Claim } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

export interface ThreadBrief { id: string; title: string; objective: string; promptHint: string }

export interface ResearchQuestion { question: string; searchQuery: string }

const QuestionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    searchQuery: z.string().min(1),
  })).min(1).max(5),
});

export async function planResearchQuestions(
  brief: ThreadBrief, target: string, model: StructuredModel,
): Promise<ResearchQuestion[]> {
  const { questions } = await model.generateStructured({
    system: `You are the ${brief.title} research specialist. ${brief.promptHint}\nPlan the specific, answerable research questions you must investigate to assess this target at expert depth.\nFor each item return:\n- question: a precise, answerable research question\n- searchQuery: 3-8 keyword terms that MUST include the target gene symbol and key entities. NO full sentences, NO punctuation - this is sent directly to a PubMed/Europe PMC search API.`,
    prompt: `BRIEF: ${brief.title}\nTARGET: ${target}\nOBJECTIVE: ${brief.objective}\nList up to 5 research questions, most important first. Each must have a question and a concise keyword searchQuery.`,
    schema: QuestionsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return questions;
}

export async function extractClaims(
  question: string, evidenceList: string, model: StructuredModel,
): Promise<Claim[]> {
  const { claims } = await model.generateStructured({
    system: `You are a rigorous biomedical research specialist. Answer the research question using ONLY the provided evidence passages. Every claim MUST cite the evidence id(s) it rests on, copied verbatim. If the evidence conflicts, write a reconciliation claim that names the tension and states which way it leans and why. Do not state anything the evidence does not support.`,
    prompt: `RESEARCH QUESTION: ${question}\n\nEVIDENCE:\n${evidenceList}\n\nReturn claims c1, c2, ... each with citations and a confidence in [0,1].`,
    schema: ClaimsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return claims;
}

import type { Evidence, TraceEvent } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { Tool } from '@sonny/mcp-gateway';

export interface ResearchBudget { maxRounds: number }
export interface ThreadFindings { takeaway: string; claims: Claim[]; openQuestions: string[] }

const ReflectSchema = z.object({
  done: z.boolean(),
  followups: z.array(z.object({
    question: z.string().min(1),
    searchQuery: z.string().min(1),
  })).max(3),
  takeaway: z.string(),
});

export async function reflectOnGaps(
  brief: ThreadBrief, claims: Claim[], model: StructuredModel,
): Promise<{ done: boolean; followups: ResearchQuestion[]; takeaway: string }> {
  return model.generateStructured({
    system: `You are the ${brief.title} research lead reviewing your own progress. Decide whether the thread is sufficiently covered for expert-level assessment. If a critical question remains unanswered, or a source raised a new high-value thread (e.g. a resistance mechanism), list up to 3 follow-up questions. Each follow-up needs:\n- question: a precise research question\n- searchQuery: 3-8 keyword terms (NO sentences, NO punctuation) sent directly to PubMed/Europe PMC\nOtherwise set done=true. Always write a one-line takeaway summarizing the thread so far.`,
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
  model: StructuredModel; emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<ThreadFindings> {
  const { brief, target, tools, store, model, emit, budget } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) throw new Error('runResearcher requires europepmc_search and pmc_fulltext tools');

  emit({ type: 'specialist_start', specialist: brief.id });
  let openQuestions: ResearchQuestion[] = await planResearchQuestions(brief, target, model);
  emit({ type: 'research_plan', specialist: brief.id, questions: openQuestions.map((q) => q.question) });

  const claims: Claim[] = [];
  let takeaway = '';

  for (let round = 0; round < budget.maxRounds && openQuestions.length > 0; round++) {
    const item = openQuestions[0];

    emit({ type: 'tool_call', tool: search.name, args: { query: item.searchQuery } });
    const hits = await search.call({ query: item.searchQuery });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
    for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

    // Read the full text of the top open-access hit that has a PMC id.
    const top = hits.find((h) => (h.raw as { pmcid?: string; isOpenAccess?: boolean })?.pmcid && (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      const passages = await fulltext.call({ pmcid });
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        emit({ type: 'evidence_registered', id: p.id, title: p.title });
        emit({ type: 'research_read', specialist: brief.id, sourceId: p.id, locator: p.locator ?? p.title });
      }
    }

    const evidenceList = store.all().map(evidenceLine).join('\n');
    const drafted = await extractClaims(item.question, evidenceList, model);
    for (const c of drafted) { claims.push(c); emit({ type: 'claim_drafted', claim: c }); }

    const reflection = await reflectOnGaps(brief, claims, model);
    takeaway = reflection.takeaway;
    emit({ type: 'research_reflect', specialist: brief.id, note: reflection.takeaway, followups: reflection.followups.map((f) => f.question) });
    openQuestions = reflection.done ? [] : reflection.followups;
  }

  return { takeaway, claims, openQuestions: openQuestions.map((q) => q.question) };
}
