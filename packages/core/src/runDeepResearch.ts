import type { Claim, Evidence, Section, TraceEvent, KOLCluster, ContradictionFlag } from '@mrsirquanzo/sonny-shared';
import { verifyEvidenceMetadata, type Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget, ResearchContext } from './researcher.js';
import { produceResearchSection } from './produceResearchSection.js';
import { seedStructuredEvidence } from './leadSeed.js';
import { resolveQueryScope } from './parseQuery.js';
import { orientWithReview } from './orientation.js';
import { assessCompleteness, fillGap, mergeGapClaims, type ResearchGap } from './completeness.js';
import { weighAcrossThreads } from './weighing.js';
import { assessDevelopability } from './critique/developability.js';
import { detectContradictions } from './critique/consistency.js';
import { mapSpecialtyLabs } from './kolDetector.js';
import { createSourceIdentityResolver } from './rag.js';
import { consolidateSectionClaims } from './consolidateClaims.js';
import { mergeStructuredClaims } from './structuredClaims.js';
import { composeRoster, isAntibodyModality } from './planner.js';

export interface DeepResearchResult {
  target: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[];
  kolCluster: KOLCluster;
  contradictions: ContradictionFlag[];
}

function placeholderSection(brief: ThreadBrief, reason: string): Section {
  return { kind: 'research', id: brief.id, title: brief.title, takeaway: `Research could not complete: ${reason}`, claims: [], sources: [], rag: 'red' };
}

function scopeGapModel(model: StructuredModel, target: string, context?: ResearchContext): StructuredModel {
  if (!context) return model;
  const indication = context.indication ?? 'not specified';
  const modality = context.modality ?? 'not specified';
  const scope = `This evaluation is scoped to INDICATION: ${indication} and MODALITY: ${modality}. Prioritise questions and claims that bear on whether ${target} is a viable ${modality} target in ${indication}. Do not drift to other indications except as brief comparison.`;
  return {
    generateStructured: (request) => model.generateStructured({ ...request, system: `${request.system}\n${scope}` }),
  };
}

export async function runDeepResearch(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
}): Promise<DeepResearchResult> {
  const { literatureTools, structuredTools, specialistModel, verifierModel, leadModel, emit, budget } = opts;
  let roster = opts.roster;
  const store = new EvidenceStore();

  // Resolve the target symbol and scope from the request. When the caller passes
  // a free-form prompt (e.g. "assess CDCP1 as an ADC in NSCLC"), Sonny parses out
  // the bare target plus indication/modality itself, so structured tools key off
  // the gene symbol and specialists inherit the scope - no separate UI needed.
  // An explicit context (if supplied) always wins over parsed scope.
  const parsed = await resolveQueryScope({ rawQuery: opts.target, model: leadModel, emit });
  const target = parsed.target;
  const parsedContext: ResearchContext | undefined =
    parsed.indication || parsed.modality
      ? { ...(parsed.indication ? { indication: parsed.indication } : {}), ...(parsed.modality ? { modality: parsed.modality } : {}) }
      : undefined;
  const context = opts.context ?? parsedContext;

  if (context?.modality && !isAntibodyModality(context.modality)) {
    roster = await composeRoster({ target, context, model: leadModel, emit });
  }

  await seedStructuredEvidence({ target, tools: structuredTools, store, emit });

  try {
    await orientWithReview({ target, tools: literatureTools, store, emit });
  } catch (err) {
    emit({ type: 'error', message: `orientation failed: ${String(err)}` });
  }

  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  // Concurrency + per-section retry. Default: full parallelism (unchanged).
  // On a rate-limited / flaky-tool-caller backend (e.g. Groq gpt-oss), set
  // SONNY_SPECIALIST_CONCURRENCY=1 to run specialists sequentially (no 429
  // bursts) and SONNY_SECTION_RETRIES=2 to retry a section that fails outright,
  // so a stochastic failure doesn't leave a whole thread empty.
  const concurrency = Math.max(1, Number(process.env.SONNY_SPECIALIST_CONCURRENCY) || roster.length);
  const sectionRetries = Math.max(0, Number(process.env.SONNY_SECTION_RETRIES) || 0);
  const produceOne = async (brief: ThreadBrief): Promise<Section> => {
    let lastReason = 'unknown error';
    for (let attempt = 0; attempt <= sectionRetries; attempt++) {
      try {
        return await produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget, context });
      } catch (err) {
        lastReason = String((err as { message?: string })?.message ?? err);
        emit({ type: 'error', message: `specialist ${brief.id} attempt ${attempt + 1}/${sectionRetries + 1} failed: ${lastReason}` });
      }
    }
    return placeholderSection(brief, lastReason);
  };
  const sections: Section[] = new Array(roster.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < roster.length) {
      const i = cursor++;
      sections[i] = await produceOne(roster[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, roster.length) }, worker));

  let complete = true;
  let gaps: ResearchGap[] = [];
  try {
    ({ complete, gaps } = await assessCompleteness(sections, opts.leadModel));
  } catch (err) {
    emit({ type: 'error', message: `completeness assessment failed: ${String(err)}` });
  }
  emit({ type: 'completeness_verdict', complete, gaps: gaps.map((g) => g.question) });
  let finalSections = sections;
  if (!complete) {
    for (const gap of gaps) {
      const idx = finalSections.findIndex((s) => s.id === gap.specialistId);
      if (idx === -1) continue;
      try {
        const claims = await fillGap({
          gap, target, tools: literatureTools, store,
          specialistModel: scopeGapModel(specialistModel, target, context), verifierModel, emit,
        });
        const resolveSourceIdentity = createSourceIdentityResolver(store.all());
        finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims, resolveSourceIdentity) : s));
      } catch (err) {
        emit({ type: 'error', message: `gap-fill ${gap.specialistId} failed: ${String(err)}` });
      }
    }
  }

  // Consolidate duplicate facts across sections so each section adds new
  // information rather than restating the same claim (specialists run in
  // parallel and independently surface the same findings).
  try {
    finalSections = consolidateSectionClaims(finalSections).sections;
  } catch (err) {
    emit({ type: 'error', message: `claim consolidation failed: ${String(err)}` });
  }

  // Deterministically attach curated-database findings (surface localisation,
  // normal-tissue expression/selectivity, tractability, safety) as cited claims
  // in their owning sections. These are the ADC-critical answers a small writer
  // model tends to leave uncited; asserting them from the card guarantees they
  // appear, grounded to the source id.
  try {
    finalSections = mergeStructuredClaims(finalSections, store);
  } catch (err) {
    emit({ type: 'error', message: `structured-claim merge failed: ${String(err)}` });
  }

  try {
    const mi = finalSections.findIndex((s) => s.id === 'modality_developability');
    if (mi !== -1) {
      const risks = await assessDevelopability({ section: finalSections[mi], store, model: verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === mi ? { ...s, developabilityRisks: risks } : s));
    }
  } catch (err) {
    emit({ type: 'error', message: `developability assessment failed: ${String(err)}` });
  }

  let kolCluster: KOLCluster = { target, labs: [] };
  try {
    kolCluster = mapSpecialtyLabs(store, target);
    emit({ type: 'kol_cluster', cluster: kolCluster });
  } catch (err) {
    emit({ type: 'error', message: `kol mapping failed: ${String(err)}` });
  }

  let weighing = { takeaway: '', claims: [] as Claim[] };
  try {
    weighing = await weighAcrossThreads({ sections: finalSections, store, leadModel: opts.leadModel, verifierModel, emit });
  } catch (err) {
    emit({ type: 'error', message: `weighing failed: ${String(err)}` });
  }

  try {
    const baseOf = (id: string): string => id.replace(/#.*$/, '');
    const citedBaseIds = new Set<string>();
    for (const section of finalSections) {
      for (const claim of section.claims) {
        for (const citation of claim.citations) citedBaseIds.add(baseOf(citation));
      }
    }
    for (const claim of weighing.claims) {
      for (const citation of claim.citations) citedBaseIds.add(baseOf(citation));
    }

    const citedPublications = new Map<string, Evidence>();
    for (const evidence of store.all()) {
      const baseId = baseOf(evidence.id);
      if (evidence.kind === 'publication' && citedBaseIds.has(baseId) && !citedPublications.has(baseId)) {
        citedPublications.set(baseId, evidence);
      }
    }

    const references = [...citedPublications.entries()];
    let verificationCursor = 0;
    const verifyNext = async (): Promise<void> => {
      while (verificationCursor < references.length) {
        const [id, evidence] = references[verificationCursor++];
        const doi = evidence.metadata?.doi;
        if (!doi) {
          evidence.metadata = { ...evidence.metadata, crossrefVerified: false };
          emit({ type: 'reference_check', id, verified: false, note: 'no doi' });
          continue;
        }

        try {
          const result = await verifyEvidenceMetadata({ doi, title: evidence.title });
          evidence.metadata = {
            ...evidence.metadata,
            crossrefVerified: result.verified,
            ...(result.journal ? { journal: result.journal } : {}),
            ...(result.year ? { year: result.year } : {}),
          };
          emit({
            type: 'reference_check', id, doi, verified: result.verified,
            ...(result.note ? { note: result.note } : {}),
          });
        } catch {
          evidence.metadata = { ...evidence.metadata, crossrefVerified: false };
          emit({ type: 'reference_check', id, doi, verified: false, note: 'crossref verification failed' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, references.length) }, verifyNext));
  } catch (err) {
    emit({ type: 'error', message: `reference verification pass failed: ${String(err)}` });
  }

  const contradictions = await detectContradictions({
    claims: finalSections.flatMap((s) => s.claims), store, model: verifierModel, emit,
  });
  return { target, sections: finalSections, weighing, evidence: store.all(), kolCluster, contradictions };
}
