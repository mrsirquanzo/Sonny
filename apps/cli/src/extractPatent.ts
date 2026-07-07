import { extractPatentSequences } from '@mrsirquanzo/sonny-core';
import type { ExtractPatentDeps, ExtractedPatent } from '@mrsirquanzo/sonny-core';

export type { ExtractPatentDeps };

export async function runExtractPatent(
  filePath: string,
  deps: ExtractPatentDeps = {},
): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  return extractPatentSequences({ filePath, emit: () => {}, deps });
}
