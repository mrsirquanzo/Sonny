import { ingestToMarkdown } from '@mrsirquanzo/sonny-mcp-gateway';
import type { IngestResult } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { extractPatentData, type ExtractedPatent } from './patentData.js';
import { makeModel, type StructuredModel } from './model.js';

export interface ExtractPatentDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
}

export async function extractPatentSequences(opts: {
  filePath: string;
  emit: (e: TraceEvent) => void;
  deps?: ExtractPatentDeps;
}): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  const { filePath, emit, deps = {} } = opts;
  const ingest = deps.ingest ?? ingestToMarkdown;
  try {
    const res = await ingest(filePath);
    if (res.status !== 'ok') {
      const error = res.error ?? 'markitdown unavailable';
      emit({ type: 'error', message: error });
      emit({ type: 'patent_ingest', status: 'failed' });
      return { ok: false, error };
    }
    emit({ type: 'patent_ingest', status: 'ok' });
    const model = deps.model ?? makeModel();
    const data = await extractPatentData(res.markdown, model, emit);
    return { ok: true, data };
  } catch (e) {
    const error = `patent extraction failed: ${(e as Error).message}`;
    emit({ type: 'error', message: error });
    return { ok: false, error };
  }
}
