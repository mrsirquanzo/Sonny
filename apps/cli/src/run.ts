import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { runDossier, AnthropicModel } from '@mrsirquanzo/sonny-core';
import { openTargetsTargetTool, pubmedTool, clinicalTrialsTool } from '@mrsirquanzo/sonny-mcp-gateway';
import { runExtractPatent } from './extractPatent.js';
import { runPatentWorkup } from './patentWorkup.js';

export function formatTrace(events: TraceEvent[]): string {
  return events.map((e) => {
    switch (e.type) {
      case 'plan': return `PLAN  specialists=${e.specialists.join(',')} tools=${e.tools.join(',')}`;
      case 'specialist_start': return `  ▸ ${e.specialist}`;
      case 'specialist_skipped': return `  (skipped ${e.specialist}: ${e.reason})`;
      case 'tool_call': return `  → ${e.tool}(${JSON.stringify(e.args)})`;
      case 'tool_result': return `  ← ${e.tool}: ${e.count} record(s)`;
      case 'evidence_registered': return `  • ${e.id}  ${e.title}`;
      case 'claim_drafted': return `  claim ${e.claim.id}: ${e.claim.text}`;
      case 'verdict': return `  verdict ${e.verdict.claimId}: ${e.verdict.status}`;
      case 'section_complete':
        return `\n[${e.section.rag.toUpperCase()}] ${e.section.title}\n  ${e.section.takeaway}\n` +
          e.section.claims.map((c) => `  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
      case 'recommendation':
        return `\nLEAD  recommendation: ${e.verdict}`;
      case 'error': return `  ! ${e.message}`;
      case 'lead_decompose':
        return `\nLEAD  dispatching: ${e.specialists.join(', ')}`;
      case 'completeness_verdict':
        return `LEAD  completeness: ${e.complete ? 'complete' : 'gaps -> ' + e.gaps.join('; ')}`;
      case 'gap_filler':
        return `  + gap-fill [${e.specialist}]: ${e.question}`;
      case 'research_plan':
        return `  ▸ ${e.specialist} plan:\n` + e.questions.map((q) => `      ? ${q}`).join('\n');
      case 'research_read':
        return `      reading ${e.sourceId} (${e.locator})`;
      case 'research_reflect':
        return `      reflect: ${e.note}` + (e.followups.length ? `\n      follow-ups: ${e.followups.join('; ')}` : '');
      case 'methodological_critique': {
        const f = e.critique.redFlags;
        return `      ⚖ skeptic [${e.critique.evidenceId}]: ${e.critique.studyDesign}` +
          (f.length ? ` - ${f.map((r) => `${r.biasRisk}:${r.category}`).join('; ')}` : ' - no flags');
      }
      case 'developability_assessment': {
        const r = e.risks.filter((x) => x.severity !== 'manageable');
        return `LEAD  developability: ` + (r.length ? r.map((x) => `${x.severity} ${x.category}`).join('; ') : 'no material risks');
      }
      case 'kol_cluster':
        return `\nLEAD  KOL terrain: ` + (e.cluster.labs.length ? e.cluster.labs.map((l) => l.investigator).join(', ') : 'no dominant labs');
      default: return `  [${e.type}]`;
    }
  }).join('\n');
}

export async function main(argv: string[]): Promise<void> {
  if (argv[2] === 'extract-patent') {
    const file = argv[3];
    if (!file) { console.error('usage: extract-patent <file>'); process.exit(1); return; }
    const out = await runExtractPatent(file);
    if (!out.ok) { console.error(out.error); process.exit(1); return; }
    console.log(JSON.stringify(out.data, null, 2));
    return;
  }
  if (argv[2] === 'patent-workup') {
    const file = argv[3];
    if (!file) { console.error('usage: patent-workup <file>'); process.exit(1); return; }
    const out = await runPatentWorkup(file);
    if (!out.ok) { console.error(out.error); process.exit(1); return; }
    console.log(JSON.stringify(out.workup, null, 2));
    return;
  }
  if (argv[2] === 'deep') {
    const { runDeep } = await import('./deep.js');
    await runDeep(argv.slice(3).join(' '));
    return;
  }
  const query = argv.slice(2).join(' ').trim() || 'CDCP1';
  const symbol = (query.match(/\b[A-Z0-9]{2,7}\b/)?.[0]) ?? query;
  const { verdict } = await runDossier({
    query, symbol, tools: [openTargetsTargetTool, pubmedTool, clinicalTrialsTool],
    plannerModel: new AnthropicModel(), specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
    emit: (e) => { process.stdout.write(formatTrace([e]) + '\n'); },
  });
  process.stdout.write(`\nVERDICT: ${verdict}\n`);
}
