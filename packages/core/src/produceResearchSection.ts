import type { Claim, Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag, createSourceIdentityResolver } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget, type ResearchContext } from './researcher.js';
import type { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';

export async function produceResearchSection(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
  auditStore?: RetrievalAuditStore;
}): Promise<Section> {
  const { brief, target, tools, store, specialistModel, verifierModel, emit, budget, context, auditStore } = opts;
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, verifierModel, emit, budget, context, auditStore });

  const { shippable } = groundClaims(findings.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  // Reconcile the ledger BEFORE attaching it. The ledger marked questions
  // answered on grounding, which is all `runResearcher` can test; a question
  // whose answering claims the verifier then rejected must not ship as
  // answered. The supported set is the SAME predicate as `section.claims`, so
  // ledger status and shipped claims cannot disagree.
  findings.ledger.applyVerification(new Set(supported.map((c) => c.id)));
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    kind: 'research', id: brief.id, title: brief.title, takeaway: findings.takeaway,
    // Section identity comes from the brief that produced it, so an axis can
    // never acquire a scope its rubric was not built under.
    ...(brief.scope ? { scope: brief.scope } : {}),
    claims: supported, sources, rag: computeRag(shippable, verdicts, createSourceIdentityResolver(store.all())),
    critiques: findings.critiques,
    // Named on the artifact, not dropped. A silently truncated investigation
    // reads as a complete one.
    questionLedger: findings.ledger.all(),
  };
  emit({ type: 'section_complete', section });
  return section;
}
