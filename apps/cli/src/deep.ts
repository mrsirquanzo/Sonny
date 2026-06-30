import { makeModel, currentBackend, produceBriefing, RESEARCH_ROSTER } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool, europePmcCitationsTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  process.stdout.write(`backend: ${currentBackend()}\n`);
  const briefing = await produceBriefing({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
    structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
    specialistModel: makeModel(), verifierModel: makeModel(), leadModel: makeModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });

  const r = briefing.recommendation;
  process.stdout.write(`\n\n=== ${r.verdict.toUpperCase()}: ${r.thesis} ===\n`);
  process.stdout.write(`\n${briefing.executiveRead}\n`);

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

  process.stdout.write(`\nBULL CASE\n`);
  for (const p of r.bull) process.stdout.write(`  + ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  process.stdout.write(`\nBEAR CASE\n`);
  for (const p of r.bear) process.stdout.write(`  - ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  if (r.conditions.length) {
    process.stdout.write(`\nCONDITIONS\n`);
    for (const c of r.conditions) process.stdout.write(`  * ${c}\n`);
  }

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
