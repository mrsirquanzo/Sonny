import {
  makeModel,
  runAnalysisSpecialist,
  type AnalysisSpecialistResult,
  type RunAnalysisSpecialistInput,
} from '@mrsirquanzo/sonny-core';

type Analyze = (input: RunAnalysisSpecialistInput) => Promise<AnalysisSpecialistResult>;

export interface RunAnalyzeDependencies {
  analyze?: Analyze;
  write?: (text: string) => void;
}

export function renderAnalysisSection(result: AnalysisSpecialistResult): string {
  const { section } = result;
  const lines = [
    `[${section.rag.toUpperCase()}] ${section.title}`,
    `  ${section.takeaway}`,
  ];
  for (const claim of section.claims) {
    lines.push(`  - ${claim.text} ${claim.citations.map((id) => `[${id}]`).join(' ')}`);
  }

  if (section.figurePaths.length > 0) {
    lines.push('', '  Figures:');
    for (const path of section.figurePaths) lines.push(`    - ${path}`);
  }

  const computationById = new Map(result.evidence.map((item) => [item.computationId, item]));
  if (section.computationIds.length > 0) {
    lines.push('', '  Provenance:');
    for (const computationId of section.computationIds) {
      const evidence = computationById.get(computationId);
      lines.push(`    computationId: ${computationId}`);
      if (!evidence) {
        lines.push('    verification: unavailable (computation evidence did not resolve)');
        continue;
      }
      lines.push('    dataset hashes:');
      for (const dataset of evidence.datasetInputs) {
        lines.push(`      - ${dataset.datasetId}: ${dataset.contentSha256}`);
      }
      const claim = section.claims.find((candidate) =>
        candidate.computedBinding?.computationId === computationId);
      lines.push(`    executionMode: ${claim?.executionMode ?? 'unverified'}`);
      lines.push(`    replayVerification: ${claim?.replayVerification ?? 'not_run'}`);
      lines.push(`    originVerification: ${claim?.originVerification ?? 'none'}`);
    }
  } else {
    lines.push('', '  Provenance: unavailable because the analysis abstained.');
  }
  return lines.join('\n');
}

export async function runAnalyze(target: string, dependencies: RunAnalyzeDependencies = {}): Promise<AnalysisSpecialistResult> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const result = dependencies.analyze
    ? await dependencies.analyze({ target })
    : await runAnalysisSpecialist({ target, planningModel: makeModel() });
  write(`${renderAnalysisSection(result)}\n`);
  return result;
}
