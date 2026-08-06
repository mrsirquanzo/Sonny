import { z } from 'zod';
import { type Claim } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
import { snowballCitations } from './snowball.js';
import { retrieveResearchHits } from './hybridRetrieval.js';

export interface ThreadBrief {
  /** Section identity for this thread. Attached by composeRoster. */
  scope?: import('@mrsirquanzo/sonny-shared').SectionScope;
  /** Execution context; its kind MUST match scope.kind. */
  context?: import('@mrsirquanzo/sonny-shared').SpecialistExecutionContext; id: string; title: string; objective: string; promptHint: string }

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
  /**
   * What the curated databases already answer.
   *
   * Structured evidence is seeded before specialists run, so a question the
   * cards already answer spends a whole round re-deriving a fact Sonny holds.
   * Showing the specialist what is known is the difference between planning
   * five questions and planning five USEFUL ones.
   */
  knownFacts: readonly string[] = [],
): Promise<ResearchQuestion[]> {
  const { questions } = await model.generateStructured({
    system: withResearchScope(
      `You are the ${brief.title} research specialist. ${brief.promptHint}\n`
      + `Plan the specific, answerable research questions you must investigate to assess this target at expert depth.\n`
      + `A good question is DECISION-RELEVANT and DISCRIMINATING: its answer would change the assessment, and different answers point to different conclusions. `
      + `"What is known about X" is a bad question - it cannot come back negative. "Does X hold in the population this programme targets" is a good one.\n`
      + `Prefer questions the published literature can actually settle. A question no paper could answer will burn a round and return nothing.\n`
      + `Do NOT ask what the ALREADY KNOWN facts below already answer; go past them.\n`
      + `For each item return:\n- question: a precise, answerable research question\n`
      + `- concept: ONE short topic facet of 1-2 words that narrows the search (examples: 'ADC', 'oncology', 'signaling', 'metastasis', 'resistance'). Do NOT include the target gene symbol - it is added automatically. Do NOT write a sentence or a list of keywords, just the single concept.`,
      target, context),
    prompt: `BRIEF: ${brief.title}\nTARGET: ${target}\nOBJECTIVE: ${brief.objective}\n`
      + (knownFacts.length ? `\nALREADY KNOWN from curated databases - do not re-ask these:\n${knownFacts.map((f) => `- ${f}`).join('\n')}\n` : '')
      + `\nList up to 5 research questions, most important first. Each must have a question and a single short concept.`,
    schema: QuestionsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return questions;
}

// Lenient extraction schema: the writer only supplies text/citations/confidence.
// The claim `id` is assigned deterministically below rather than required from
// the model - small open models (e.g. gpt-oss) frequently omit `id` (or emit it
// where a strict schema forbids extras), which 400s the whole section. Not
// requiring it removes that failure mode entirely.
const ExtractedClaimsSchema = z.object({
  claims: z.array(z.object({
    text: z.string().min(1),
    citations: z.array(z.string()).default([]),
    confidence: z.number().default(0.7),
  })).default([]),
});

/**
 * Scope for globally unique claim ids.
 *
 * `c1, c2, ...` per call collided across rounds and specialists, and verdicts
 * match by claim id (`produceResearchSection.ts`, `rag.ts`, `weighing.ts`), so
 * a collision misattributes a verdict to the wrong claim. Ids encode the
 * section and round; the model is never asked for one (the prompt forbids an
 * id field because small models 400 on strict schemas).
 */
export interface ClaimIdScope { sectionKey: string; round: number }

export function claimId(scope: ClaimIdScope | undefined, index: number): string {
  return scope ? `${scope.sectionKey}#r${scope.round}c${index}` : `c${index}`;
}

export async function extractClaims(
  question: string, evidenceList: string, model: StructuredModel, context?: ResearchContext,
  idScope?: ClaimIdScope,
): Promise<Claim[]> {
  const { claims } = await model.generateStructured({
    system: withResearchScope(`You are a rigorous biomedical research specialist. Answer the research question using ONLY the provided evidence passages. Every claim MUST cite the evidence id(s) it rests on, copied verbatim. When the evidence includes CURATED DATABASE records (Open Targets, UniProt) that bear on the question - cell-surface localisation, normal-tissue expression and selectivity, tractability, or safety liabilities - you MUST use and cite them by their id, not only the literature. If the evidence conflicts, write a reconciliation claim that names the tension and states which way it leans and why. Do not state anything the evidence does not support.`, 'this target', context),
    prompt: `RESEARCH QUESTION: ${question}\n\nEVIDENCE:\n${evidenceList}\n\nReturn a list of claims. Each claim has: text, citations (evidence ids, copied verbatim), and a confidence in [0,1]. Do not include an id field.`,
    schema: ExtractedClaimsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return (claims ?? []).map((c, i) => ({
    id: claimId(idScope, i + 1),
    text: c.text,
    citations: c.citations ?? [],
    confidence: Math.max(0, Math.min(1, c.confidence ?? 0.7)),
  }));
}

import type { Evidence, TraceEvent, MethodologicalCritique } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { safeToolCall } from './safeToolCall.js';
import { QuestionLedger } from './questionLedger.js';
import { buildRetrievalAudit } from './retrievalAuditing.js';
import type { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';
import { groundClaims } from './grounding.js';
import { runSkepticAudit } from './critique/skepticAudit.js';
import { researchFigures } from './figureStep.js';

export interface ResearchBudget { maxRounds: number }

/**
 * Rounds a specialist may spend, one question per round.
 *
 * 10, up from 4. A specialist plans up to five questions and each may take up to
 * MAX_ATTEMPTS_PER_QUESTION attempts, so 4 rounds could not work through even
 * the initial plan - it shipped with most questions labelled `open` and never
 * attempted. Ten lets the plan complete and leaves room for follow-ups.
 *
 * This is the main cost lever in the pipeline: rounds multiply searches, deep
 * reads, and model calls per specialist, and there are six specialists.
 * Override with SONNY_MAX_ROUNDS.
 */
export const DEFAULT_MAX_ROUNDS = 10;

export function defaultResearchBudget(): ResearchBudget {
  const configured = Number(process.env.SONNY_MAX_ROUNDS);
  return { maxRounds: Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_MAX_ROUNDS };
}
export interface ThreadFindings {
  takeaway: string; claims: Claim[]; openQuestions: string[]; critiques: MethodologicalCritique[];
  /** The live ledger. `produceResearchSection` must call `applyVerification` on
   *  it after verifying claims, so a snapshot would not be enough. */
  ledger: QuestionLedger;
}

/** Sources whose cards are deterministic facts, shown to the planner. */
const CURATED_SOURCES_FOR_PLANNING = new Set(['Open Targets', 'UniProt']);

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
  /** The question just pursued. Reflection judged progress without knowing what
   *  it had asked, which is most of why its `done` was unreliable. */
  pursuedQuestion?: string,
  /** Questions already queued. Follow-ups duplicating these are discarded by the
   *  ledger, so proposing them wastes the three slots this call has. */
  alreadyQueued: readonly string[] = [],
): Promise<{ done: boolean; followups: ResearchQuestion[]; takeaway: string }> {
  return model.generateStructured({
    system: withResearchScope(
      `You are the ${brief.title} research lead reviewing your own progress. `
      + `Propose up to 3 follow-up questions that attack the WEAKEST part of what you have found so far - a claim resting on one source, a mechanism asserted but not demonstrated, a result that would not replicate in the relevant population. `
      + `A follow-up that merely restates a claim you already hold adds nothing.\n`
      + `Each follow-up needs:\n- question: a precise research question\n`
      + `- concept: ONE short topic facet of 1-2 words (no sentence, no keyword list) and do NOT include the target gene symbol - it is added automatically\n`
      + `Set done=true only when the remaining questions would not change the assessment. Always write a one-line takeaway summarizing the thread so far.`,
      'this target', context),
    prompt: `OBJECTIVE: ${brief.objective}`
      + (pursuedQuestion ? `\nQUESTION JUST PURSUED: ${pursuedQuestion}` : '')
      + `\n\nCLAIMS SO FAR:\n${claims.map((c) => `- ${c.text}`).join('\n') || '(none yet)'}`
      + (alreadyQueued.length ? `\n\nALREADY QUEUED - do not repeat:\n${alreadyQueued.map((q) => `- ${q}`).join('\n')}` : ''),
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
  /** Optional so existing callers and tests keep working. When absent no audits
   *  are recorded, and an absence conclusion will correctly fail its coverage
   *  check rather than pass unsubstantiated. */
  auditStore?: RetrievalAuditStore;
}): Promise<ThreadFindings> {
  const { brief, target, tools, store, model, verifierModel, emit, budget, context, auditStore } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  // Only required when rounds will actually run. A zero-budget thread performs
  // no retrieval, so demanding search tools up front made it impossible to
  // construct a section without them.
  if (budget.maxRounds > 0 && (!search || !fulltext)) {
    throw new Error('runResearcher requires europepmc_search and pmc_fulltext tools');
  }
  // Safe: the loop below never executes when maxRounds is 0, and the guard
  // above rejects a missing tool whenever it does.
  const searchTool = search!;
  const fulltextTool = fulltext!;

  emit({ type: 'specialist_start', specialist: brief.id });
  const terms = targetTerms(store, target);
  // A zero-budget thread can never research anything, so planning questions for
  // it spends a model call to produce a list nothing will consume.
  // The ledger replaces a queue that was REASSIGNED every round. Previously
  // `openQuestions = reflection.followups` discarded planned questions 2..N
  // after round 0, so of up to five planned questions only the first was ever
  // pursued and the rest vanished without trace.
  const ledger = new QuestionLedger(brief.id);
  if (budget.maxRounds > 0) {
    // Curated cards are seeded before specialists run, so the plan can be made
    // against what Sonny already holds rather than in ignorance of it.
    const knownFacts = store.all()
      .filter((e) => CURATED_SOURCES_FOR_PLANNING.has(e.source))
      .map((e) => (e.snippet ?? e.title ?? '').trim())
      .filter(Boolean);
    ledger.add(await planResearchQuestions(brief, target, model, context, knownFacts), 'planned');
  }
  emit({ type: 'research_plan', specialist: brief.id, questions: ledger.all().map((q) => q.question) });

  const claims: Claim[] = [];
  let takeaway = '';
  let snowballed = false;
  const critiques: MethodologicalCritique[] = [];
  const audited: { ids: Set<string>; redFlags: MethodologicalCritique['redFlags'] }[] = [];

  for (let round = 0; round < budget.maxRounds; round++) {
    const item = ledger.next();
    if (!item) break;

    // Audits for THIS attempt. An absence conclusion may only rest on searches
    // recorded for its own section, so they are collected per attempt and
    // handed to the ledger with the claims they produced.
    const attemptAudits: string[] = [];
    const hits = await retrieveResearchHits({
      specialist: brief.id,
      target,
      question: item.question,
      concept: item.concept,
      terms,
      search: searchTool,
      model,
      emit,
      onSearch: (observation) => {
        const audit = buildRetrievalAudit({
          axis: brief.id,
          sectionKey: brief.id,
          toolName: searchTool.name,
          renderedQuery: observation.renderedQuery,
          normalizedQueryTerms: [...terms, item.concept],
          rawResultCount: observation.rawResultCount,
          relevantResultCount: observation.relevantResultCount,
          executedAt: new Date().toISOString(),
          failed: observation.status === 'failed',
        });
        if (!audit) return;
        auditStore?.register(audit);
        attemptAudits.push(audit.id);
      },
    });
    emit({ type: 'tool_result', tool: searchTool.name, count: hits.length });
    for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }
    // This question's own evidence, collected locally (not store.all()) so the
    // extraction request stays small and relevant. The full store is retained
    // for citation resolution; we only narrow what the extractor is shown.
    const roundLiterature: Evidence[] = [...hits];

    // Deep-read the top open-access hit whose TITLE names the target. Strict: if none
    // qualifies, read no full text this round rather than deep-read a tangential paper.
    const top = hits.find((h) =>
      titleMentionsTarget(h, terms) &&
      (h.raw as { pmcid?: string })?.pmcid &&
      (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltextTool.name, args: { pmcid } });
      // Gate the sections: a title-relevant paper still carries off-topic sections.
      const passages = relevanceGate(await safeToolCall({ tool: fulltextTool, args: { pmcid }, emit }), terms);
      emit({ type: 'tool_result', tool: fulltextTool.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        roundLiterature.push(p);
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

    // Build the extraction context from THIS question's evidence only: the small
    // set of curated database cards (always relevant, seeded once) plus the
    // literature retrieved for this question. This replaces sending the entire
    // accumulated store on every call - which made requests balloon to ~130k
    // tokens, exhausting rate limits and inflating cost. Curated cards are
    // surfaced first so the localisation / expression / tractability / safety
    // signals are actually used.
    const STRUCTURED_KINDS = new Set(['target', 'disease', 'drug', 'trial', 'patent', 'dataset']);
    const isCurated = (e: Evidence) => STRUCTURED_KINDS.has(e.kind);
    const curated = store.all().filter(isCurated);
    const seen = new Set<string>();
    const literature = roundLiterature.filter((e) => !isCurated(e) && !seen.has(e.id) && seen.add(e.id));
    const evidenceList = [
      curated.length ? 'CURATED DATABASE EVIDENCE (authoritative for cell-surface localisation, normal-tissue & tumor expression, tractability, safety, clinical precedent/trials, and patent/IP - cite these ids where relevant):' : '',
      ...curated.map(evidenceLine),
      curated.length ? '\nLITERATURE EVIDENCE:' : '',
      ...literature.map(evidenceLine),
    ].filter(Boolean).join('\n');
    const drafted = await extractClaims(item.question, evidenceList, model, context, { sectionKey: brief.id, round });
    // `usableRetrieval` drives exhaustion: a question whose searches keep
    // returning nothing is unanswerable from these sources, which is a finding.
    // Drafting claims that fail to ground is a different problem and is caught
    // by grounding, so it does not count toward exhaustion.
    ledger.recordAttempt(item.id, {
      claimIds: drafted.map((c) => c.id),
      retrievalAuditIds: attemptAudits,
      usableRetrieval: roundLiterature.length > 0,
      round,
    });
    for (const c of drafted) {
      const flags = audited.filter((a) => c.citations.some((id) => a.ids.has(id))).flatMap((a) => a.redFlags);
      if (flags.length) c.redFlags = flags;
      claims.push(c);
      emit({ type: 'claim_drafted', claim: c });
    }

    // Sufficiency is decided in code, not by the model: a question with at
    // least one grounded answering claim is answered. `reflectOnGaps` still
    // proposes follow-ups and writes the takeaway, but its `done` no longer
    // terminates the loop - a specialist whose search returned nothing could
    // read its existing claims and declare itself finished.
    ledger.applyGrounding(new Set(groundClaims(claims, store).shippable.map((c) => c.id)));

    const reflection = await reflectOnGaps(brief, claims, model, context, item.question, ledger.open().map((q) => q.question));
    takeaway = reflection.takeaway;
    emit({ type: 'research_reflect', specialist: brief.id, note: reflection.takeaway, followups: reflection.followups.map((f) => f.question) });
    // Merge, never replace. Deduped in the ledger, so a reflection re-proposing
    // an existing question cannot reset its attempts or revive an exhausted one.
    if (!reflection.done) ledger.add(reflection.followups, 'followup');
  }

  return { takeaway, claims, openQuestions: ledger.unanswered().map((q) => q.question), ledger, critiques };
}
