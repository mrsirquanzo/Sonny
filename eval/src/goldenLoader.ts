import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GoldenPatent } from './goldenPatent.js';

export interface LoadedGolden { golden: GoldenPatent; groundTruthVerified: boolean; sourceFile: string }

const REQUIRED: Array<keyof GoldenPatent> = ['name', 'patentNumber', 'declaredSequenceCount', 'knownSequences', 'expectedConstructs'];

function validate(obj: unknown, file: string): GoldenPatent {
  if (typeof obj !== 'object' || obj === null) throw new Error(`golden ${file}: not an object`);
  for (const k of REQUIRED) {
    if (!(k in obj)) throw new Error(`golden ${file}: missing required field "${String(k)}"`);
  }
  return obj as GoldenPatent;
}

export function loadGoldens(dir?: string): LoadedGolden[] {
  const base = dir ?? fileURLToPath(new URL('../golden/', import.meta.url));
  let files: string[];
  try { files = readdirSync(base).filter((f) => f.endsWith('.patent.json')); }
  catch { return []; }
  return files.map((f) => {
    const sourceFile = `${base.replace(/\/$/, '')}/${f}`;
    const golden = validate(JSON.parse(readFileSync(sourceFile, 'utf8')), f);
    return { golden, groundTruthVerified: golden.groundTruthVerified === true, sourceFile };
  });
}
