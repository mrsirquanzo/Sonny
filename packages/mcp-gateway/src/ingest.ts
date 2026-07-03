import { spawn } from 'node:child_process';

export type MarkitdownExec = (filePath: string) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface IngestResult {
  markdown: string;
  status: 'ok' | 'markitdown_unavailable';
  error?: string;
}

const defaultExec: MarkitdownExec = (filePath) =>
  new Promise((resolve) => {
    const bin = process.env.SONNY_MARKITDOWN ?? 'markitdown';
    const child = spawn(bin, [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => resolve({ stdout: '', stderr: String(e), code: -1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });

export async function ingestToMarkdown(
  filePath: string,
  deps: { exec?: MarkitdownExec } = {},
): Promise<IngestResult> {
  const exec = deps.exec ?? defaultExec;
  const { stdout, stderr, code } = await exec(filePath);
  if (code !== 0) {
    return { markdown: '', status: 'markitdown_unavailable', error: `markitdown exit ${code}: ${stderr.trim()}` };
  }
  return { markdown: stdout, status: 'ok' };
}
