import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runOrchestration, AnthropicModel } from '@sonny/core';
import { openTargetsTool, pubmedTool } from '@sonny/mcp-gateway';
import { createServer, type ServerDeps } from './server.js';

export function buildDeps(publicDir: string): ServerDeps {
  return {
    publicDir,
    makeRunner: (query, symbol) => async (emit) => {
      const specialistModel = new AnthropicModel();
      const verifierModel = new AnthropicModel();
      const { section } = await runOrchestration({
        query,
        symbol,
        tools: [openTargetsTool, pubmedTool],
        specialistModel,
        verifierModel,
        emit,
      });
      return { section };
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
