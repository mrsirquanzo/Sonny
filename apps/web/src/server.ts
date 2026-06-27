import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { streamRun, type OrchestratorRunner } from './streamRun.js';

export interface ServerDeps {
  publicDir: string;
  makeRunner: (query: string, symbol: string) => OrchestratorRunner;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

async function serveStatic(publicDir: string, rel: string, res: http.ServerResponse): Promise<void> {
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const path = join(publicDir, safe);
  try {
    const buf = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/run') {
      const query = url.searchParams.get('q') ?? '';
      const symbol = url.searchParams.get('symbol') ?? '';
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      await streamRun(deps.makeRunner(query, symbol), (chunk) => res.write(chunk));
      res.end();
      return;
    }
    if (url.pathname === '/') return serveStatic(deps.publicDir, 'index.html', res);
    if (['/app.js', '/styles.css'].includes(url.pathname) || url.pathname.startsWith('/fonts/')) {
      return serveStatic(deps.publicDir, url.pathname.slice(1), res);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
