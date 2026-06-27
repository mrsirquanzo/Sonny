import type { TraceEvent } from '@sonny/shared';
import { runOrchestration, AnthropicModel, MODEL_ROUTER } from '@sonny/core';
import { openTargetsTool, pubmedTool } from '@sonny/mcp-gateway';

export function formatTrace(events: TraceEvent[]): string {
  return events.map((e) => {
    switch (e.type) {
      case 'plan': return `PLAN  specialists=${e.specialists.join(',')} tools=${e.tools.join(',')}`;
      case 'tool_call': return `  → ${e.tool}(${JSON.stringify(e.args)})`;
      case 'tool_result': return `  ← ${e.tool}: ${e.count} record(s)`;
      case 'evidence_registered': return `  • ${e.id}  ${e.title}`;
      case 'claim_drafted': return `  claim ${e.claim.id}: ${e.claim.text}`;
      case 'verdict': return `  verdict ${e.verdict.claimId}: ${e.verdict.status}`;
      case 'synthesis': return `\nSYNTHESIS:\n${e.section}`;
      case 'error': return `  ! ${e.message}`;
    }
  }).join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const query = argv.slice(2).join(' ').trim() || 'Is EGFR a druggable target in NSCLC?';
  const symbol = (query.match(/\b[A-Z0-9]{2,7}\b/)?.[0]) ?? 'EGFR';
  const specialistModel = new AnthropicModel();
  const verifierModel = new AnthropicModel();
  const events: TraceEvent[] = [];
  await runOrchestration({
    query, symbol, tools: [openTargetsTool, pubmedTool],
    specialistModel, verifierModel,
    emit: (e) => { events.push(e); process.stdout.write(formatTrace([e]) + '\n'); },
  });
  void MODEL_ROUTER;
}
