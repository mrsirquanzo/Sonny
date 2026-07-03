import { describe, it, expect } from 'vitest';
import { ingestToMarkdown } from './ingest.js';
import type { MarkitdownExec } from './ingest.js';

describe('ingestToMarkdown', () => {
  it('returns markdown with status ok on exit code 0', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '# Patent\nSEQ ID NO: 1', stderr: '', code: 0 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('ok');
    expect(r.markdown).toBe('# Patent\nSEQ ID NO: 1');
  });

  it('soft-degrades to markitdown_unavailable on a spawn error (code -1) without throwing', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '', stderr: 'spawn markitdown ENOENT', code: -1 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('markitdown_unavailable');
    expect(r.markdown).toBe('');
    expect(r.error).toContain('ENOENT');
  });

  it('soft-degrades on a non-zero exit', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '', stderr: 'bad file', code: 2 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('markitdown_unavailable');
  });
});
