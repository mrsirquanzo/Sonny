import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TraceEvent, Section } from '@mrsirquanzo/sonny-shared';
import { createServer } from './server.js';
import type { OrchestratorRunner } from './streamRun.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
let server: Server | undefined;
afterEach(() => server?.close());

function listen(s: Server): Promise<string> {
  return new Promise((res) => s.listen(0, () => res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

const fakeRunner: OrchestratorRunner = async (emit) => {
  emit({ type: 'recommendation', verdict: 'watch' });
  return { verdict: 'watch', sections: [] as Section[] };
};

describe('createServer', () => {
  it('serves index.html at /', async () => {
    server = createServer({ publicDir, makeRunner: () => fakeRunner });
    const base = await listen(server);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<!DOCTYPE html>');
  });

  it('streams SSE frames at /api/run', async () => {
    server = createServer({ publicDir, makeRunner: () => fakeRunner });
    const base = await listen(server);
    const res = await fetch(`${base}/api/run?q=test&symbol=EGFR`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('recommendation');
    expect(body).toContain('event: done');
  });

  it('404s an unknown path', async () => {
    server = createServer({ publicDir, makeRunner: () => fakeRunner });
    const base = await listen(server);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
