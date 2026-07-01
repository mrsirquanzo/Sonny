import { ingestToMarkdown } from '@sonny/mcp-gateway';
import type { IngestResult } from '@sonny/mcp-gateway';
import { extractPatentData, makeModel } from '@sonny/core';
import type { StructuredModel, ExtractedPatent } from '@sonny/core';

export interface ExtractPatentDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
}

export async function runExtractPatent(
  filePath: string,
  deps: ExtractPatentDeps = {},
): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  const ingest = deps.ingest ?? ingestToMarkdown;
  const res = await ingest(filePath);
  if (res.status !== 'ok') return { ok: false, error: res.error ?? 'markitdown unavailable' };
  const model = deps.model ?? makeModel();
  const data = await extractPatentData(res.markdown, model);
  return { ok: true, data };
}
