import type { Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import { SPECIALISTS } from './specialists.js';
import { selectSpecialists } from './planner.js';
import { produceSection } from './produceSection.js';
import type { StructuredModel } from './model.js';

export async function runDossier(opts: {
  query: string; symbol: string; tools: Tool[];
  plannerModel: StructuredModel; specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<{ verdict: string; sections: Section[] }> {
  const { query, symbol, tools, plannerModel, specialistModel, verifierModel, emit } = opts;

  const { selected, skipped } = await selectSpecialists(query, plannerModel);
  const specs = SPECIALISTS.filter((s) => selected.includes(s.id));
  emit({ type: 'plan', specialists: specs.map((s) => s.id), tools: [...new Set(specs.flatMap((s) => s.toolNames))] });
  for (const k of skipped) emit({ type: 'specialist_skipped', specialist: k.id, reason: k.reason });

  const store = new EvidenceStore();
  const sections: Section[] = [];
  for (const spec of specs) {
    sections.push(await produceSection({ spec, query, symbol, tools, store, specialistModel, verifierModel, emit }));
  }

  const top = sections.flatMap((s) => s.claims).sort((a, b) => b.confidence - a.confidence)[0];
  const verdict = top ? top.text : 'No grounded findings for this target.';
  return { verdict, sections };
}
