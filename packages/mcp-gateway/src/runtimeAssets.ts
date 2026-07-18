import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AnalysisRuntimeAssets {
  dockerfile: string;
  seccomp: string;
  requirements: string;
  requirementsInput: string;
  executorDocumentation: string;
  runtimeDocumentation: string;
  datasetsManifest: string;
  template: string;
  resultsSchema: string;
  depmap: string;
  gtex: string;
  tumor: string;
}

function resolveAsset(...relativeCandidates: string[]): string {
  for (const candidate of relativeCandidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(`required analysis runtime asset is missing: ${relativeCandidates.join(' or ')}`);
}

/** Resolve assets from either the TypeScript source tree or the packaged dist tree. */
export function resolveAnalysisRuntimeAssets(): AnalysisRuntimeAssets {
  const sandbox = (name: string) => resolveAsset(`./sandbox/${name}`, `../sandbox/${name}`);
  const dataLake = (name: string) => resolveAsset(`./dataLake/${name}`);
  return {
    dockerfile: sandbox('Dockerfile'),
    seccomp: sandbox('seccomp.json'),
    requirements: sandbox('requirements.txt'),
    requirementsInput: sandbox('requirements.in'),
    executorDocumentation: sandbox('EXECUTOR.md'),
    runtimeDocumentation: sandbox('RUNTIME.md'),
    datasetsManifest: dataLake('datasets.json'),
    template: dataLake('templates/trop2_analysis.py'),
    resultsSchema: dataLake('templates/results_schema.json'),
    depmap: dataLake('frozen/depmap.crispr_gene_effect.csv'),
    gtex: dataLake('frozen/gtex.median_tpm.csv'),
    tumor: dataLake('frozen/expr.tumor.csv'),
  };
}
