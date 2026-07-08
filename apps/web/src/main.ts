import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runDossier, makeModel } from '@mrsirquanzo/sonny-core';
import { openTargetsTargetTool, pubmedTool, clinicalTrialsTool } from '@mrsirquanzo/sonny-mcp-gateway';
import { createServer, type ServerDeps } from './server.js';

export function buildDeps(publicDir: string): ServerDeps {
  return {
    publicDir,
    makeRunner: (query, symbol) => async (emit) => {
      const { verdict, sections } = await runDossier({
        query,
        symbol,
        tools: [openTargetsTargetTool, pubmedTool, clinicalTrialsTool],
        plannerModel: makeModel(),
        specialistModel: makeModel(),
        verifierModel: makeModel(),
        emit,
      });
      return { verdict, sections };
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
