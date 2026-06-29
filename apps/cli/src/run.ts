import type { TraceEvent } from '@sonny/shared';
import { runDossier, AnthropicModel } from '@sonny/core';
import { openTargetsTargetTool, pubmedTool, clinicalTrialsTool } from '@sonny/mcp-gateway';

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
      case 'error': return `  ! ${e.message}`;
      case 'research_plan':
        return `  ▸ ${e.specialist} plan:\n` + e.questions.map((q) => `      ? ${q}`).join('\n');
      case 'research_read':
        return `      reading ${e.sourceId} (${e.locator})`;
      case 'research_reflect':
        return `      reflect: ${e.note}` + (e.followups.length ? `\n      follow-ups: ${e.followups.join('; ')}` : '');
      default: return `  [${e.type}]`;
    }
  }).join('\n');
}

export async function main(argv: string[]): Promise<void> {
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
