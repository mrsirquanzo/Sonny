import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { produceBriefing, RESEARCH_ROSTER, makeModel, resolveVerifier, pinVerifierModel } from '@mrsirquanzo/sonny-core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool, europePmcCitationsTool } from '@mrsirquanzo/sonny-mcp-gateway';
import { createServer, type ServerDeps } from './server.js';

export function buildDeps(publicDir: string): ServerDeps {
  return {
    publicDir,
    makeRunner: (query, symbol) => async (emit) => {
      const v = resolveVerifier();
      const briefing = await produceBriefing({
        target: query || symbol,
        roster: RESEARCH_ROSTER,
        literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
        structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
        specialistModel: makeModel(),
        verifierModel: pinVerifierModel(v.model, v.modelId),
        leadModel: makeModel(),
        emit,
        budget: { maxRounds: 4 },
      });
      return { verdict: briefing.recommendation.verdict, sections: briefing.sections };
    },
  };
}

const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const port = Number(process.env.PORT ?? 8787);
  createServer(buildDeps(publicDir)).listen(port, () => {
    console.log(`Sonny web listening on http://localhost:${port}`);
  });
}
