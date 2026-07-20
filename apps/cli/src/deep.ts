import { makeModel, currentBackend, resolveVerifier, pinVerifierModel, produceBriefing, RESEARCH_ROSTER, type ResearchContext } from '@mrsirquanzo/sonny-core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, uniProtTargetTool, clinicalTrialsTool, patentSearchTool, europePmcCitationsTool } from '@mrsirquanzo/sonny-mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string, context?: ResearchContext): Promise<void> {
  const t = target.trim() || 'CDCP1';
  process.stdout.write(`backend: ${currentBackend()}\n`);
  if (context?.indication || context?.modality) {
    process.stdout.write(`scope: indication=${context.indication ?? '-'} modality=${context.modality ?? '-'}\n`);
  }
  const verifier = resolveVerifier();
  process.stdout.write(`verifier: ${verifier.modelId} (decorrelated: ${verifier.decorrelated})\n`);
  if (!verifier.decorrelated) {
    process.stderr.write(`[sonny] WARNING: verifier shares the writer's model family on backend ${currentBackend()}; verification is not decorrelated.\n`);
  }
  const briefing = await produceBriefing({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
    structuredTools: [openTargetsTargetTool, uniProtTargetTool, clinicalTrialsTool, patentSearchTool],
    specialistModel: makeModel(), verifierModel: pinVerifierModel(verifier.model, verifier.modelId), leadModel: makeModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
    context,
  });

  const r = briefing.recommendation;
  const scope = context?.indication ? ` (${context.indication}${context.modality ? `, ${context.modality}` : ''})` : '';
  process.stdout.write(`\n\n=== TARGET ASSESSMENT: ${t}${scope} ===\n`);
  process.stdout.write(`\n${r.framing ?? briefing.executiveRead}\n`);

  for (const s of briefing.sections) {
    process.stdout.write(`\n[${s.rag.toUpperCase()}] ${s.title}\n  ${s.takeaway}\n`);
    for (const c of s.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }

  if (briefing.weighing.claims.length) {
    process.stdout.write(`\nCROSS-THREAD WEIGHING\n  ${briefing.weighing.takeaway}\n`);
    for (const c of briefing.weighing.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }

  process.stdout.write(`\nCASE FOR\n`);
  for (const p of r.bull) process.stdout.write(`  + ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  process.stdout.write(`\nCASE AGAINST\n`);
  for (const p of r.bear) process.stdout.write(`  - ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  if (r.bottomLine) process.stdout.write(`\nBOTTOM LINE\n  ${r.bottomLine}\n`);
  if (r.conditions.length) {
    process.stdout.write(`\nWHAT WOULD CHANGE THIS READ\n`);
    for (const c of r.conditions) process.stdout.write(`  * ${c}\n`);
  }
  process.stdout.write(`\n(the decision rests with the team; internal evidence posture: ${r.verdict})\n`);

  process.stdout.write(`\nREFERENCES (${briefing.references.length})\n`);
  for (const ref of briefing.references) {
    process.stdout.write(`  ${ref.id}  ${ref.title}  ${ref.url}\n`);
  }

  if (briefing.kolCluster && briefing.kolCluster.labs.length) {
    process.stdout.write(`\nKOL & INSTITUTIONAL TERRAIN\n`);
    for (const lab of briefing.kolCluster.labs) {
      process.stdout.write(`  ${lab.investigator}${lab.institution ? ` - ${lab.institution}` : ''}  (${lab.paperCount} papers)\n`);
    }
  }
}
