# Sonny v2 — Web Glass-box Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the grounded pipeline visible in a browser — a streaming SSE endpoint that runs `runOrchestration` server-side and a static "journal" glass-box front-end that renders the live reasoning trace and the verified, cited dossier in the locked design system.

**Architecture:** A new `apps/web` package: a zero-dependency Node `http` server (`node:http`) that (a) serves a static front-end and the self-hosted Figtree font, and (b) exposes `GET /api/run?q=&symbol=` as a `text/event-stream` (SSE) that runs the orchestrator and emits each `TraceEvent` as an SSE frame. The browser front-end (vanilla HTML/CSS/JS, reusing the v7 mockup design) consumes the stream via `EventSource` and renders the trace + dossier incrementally (evidence drawer, "view agent edits" toggle). The streaming and HTTP-routing logic are dependency-injected (the orchestrator runner is passed in), so they're unit-testable with fakes; only the entry wiring and a manual run touch the network.

**Tech Stack:** TypeScript (ESM), Node 20+ `node:http`, Vitest, `tsx` (run), self-hosted Figtree (OFL) + IBM Plex Mono. Reuses `@sonny/core` (`runOrchestration`, `AnthropicModel`) and `@sonny/mcp-gateway` (`openTargetsTool`, `pubmedTool`).

## Global Constraints

- **Language/runtime:** TypeScript, ESM, Node 20+. `.js` import extensions. No web framework — `node:http` only; zero runtime deps beyond the workspace packages.
- **Streaming contract:** every `TraceEvent` from the orchestrator is sent as one SSE frame `data: <json>\n\n`; on completion send a final frame `event: done\ndata: <json {section}>\n\n`; on error send `event: error\ndata: <json {message}>\n\n`. Never leak the API key into any frame, log, or error sent to the client.
- **Design system (locked — copy verbatim from the v7 mockup):** font Figtree (self-hosted from the OFL files at `~/Downloads/Figtree/`), IBM Plex Mono for ids; ink `#0F172A`, accent `#1D4ED8`, good `#0F766E`, attention `#B45309`, bg `#EEF0F3`/surface `#FFFFFF`, border `#E6E8EC`. Single-column document, verdict is the hero, ≤3 colored tokens/view, status = dot+label (not filled pills), citations are clickable → evidence drawer, "view agent edits" reveals the redline. Design source to adapt: `~/Quan_project/.superpowers/brainstorm/8278-1782519876/content/dossier-v7-figtree.html`.
- **BYO key:** server reads `ANTHROPIC_API_KEY` from env at startup of the real entry only; the unit tests inject a fake runner and never need a key.
- **Testing:** Vitest. Unit tests inject fakes for the orchestrator runner; no network, no real model. Live run is manual.
- **Commits:** conventional commits, one per task minimum, on the working branch.

---

### Task 1: `apps/web` scaffold + SSE frame encoder

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/src/sse.ts`
- Test: `apps/web/src/sse.test.ts`

**Interfaces:**
- Consumes: `TraceEvent` from `@sonny/shared`.
- Produces: `function encodeEvent(e: TraceEvent): string` (→ `data: <json>\n\n`); `function encodeNamed(event: string, data: unknown): string` (→ `event: <name>\ndata: <json>\n\n`).

- [ ] **Step 1: Create manifests**

```json
// apps/web/package.json
{
  "name": "@sonny/web",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json", "start": "tsx src/index.ts" },
  "dependencies": { "@sonny/core": "workspace:*", "@sonny/mcp-gateway": "workspace:*", "@sonny/shared": "workspace:*" }
}
```

```json
// apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/sse.test.ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

describe('sse encoding', () => {
  it('encodes a TraceEvent as a data frame terminated by a blank line', () => {
    const e: TraceEvent = { type: 'evidence_registered', id: 'PMID:1', title: 'X' };
    const frame = encodeEvent(e);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(JSON.parse(frame.slice('data: '.length).trimEnd())).toEqual(e);
  });

  it('encodes a named event frame', () => {
    const frame = encodeNamed('done', { section: 'hi' });
    expect(frame).toBe('event: done\ndata: {"section":"hi"}\n\n');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL — `Cannot find module './sse.js'`.

- [ ] **Step 4: Implement the encoder**

```ts
// apps/web/src/sse.ts
import type { TraceEvent } from '@sonny/shared';

export function encodeEvent(e: TraceEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export function encodeNamed(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

- [ ] **Step 5: Install, run tests, commit**

Run: `pnpm install && pnpm --filter @sonny/web test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(web): scaffold @sonny/web + SSE frame encoder"
```

---

### Task 2: `streamRun` — orchestration → SSE writer

**Files:**
- Create: `apps/web/src/streamRun.ts`
- Modify: `apps/web/src/index.ts` (create as a barrel that re-exports; see Step 4)
- Test: `apps/web/src/streamRun.test.ts`

**Interfaces:**
- Consumes: `encodeEvent`, `encodeNamed` (Task 1); `TraceEvent` from `@sonny/shared`.
- Produces:
  `type OrchestratorRunner = (emit: (e: TraceEvent) => void) => Promise<{ section: string }>`
  `async function streamRun(runner: OrchestratorRunner, write: (chunk: string) => void): Promise<void>` — calls `runner` with an `emit` that writes `encodeEvent(e)`; on success writes `encodeNamed('done', { section })`; on throw writes `encodeNamed('error', { message })` (message is the error's message string only).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/streamRun.test.ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { streamRun, type OrchestratorRunner } from './streamRun.js';

describe('streamRun', () => {
  it('writes one frame per emitted event then a done frame', async () => {
    const chunks: string[] = [];
    const runner: OrchestratorRunner = async (emit) => {
      emit({ type: 'plan', specialists: ['target_biology'], tools: ['t'] } as TraceEvent);
      emit({ type: 'evidence_registered', id: 'PMID:1', title: 'X' } as TraceEvent);
      return { section: 'done text' };
    };
    await streamRun(runner, (c) => chunks.push(c));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('"type":"plan"');
    expect(chunks[1]).toContain('PMID:1');
    expect(chunks[2]).toBe('event: done\ndata: {"section":"done text"}\n\n');
  });

  it('writes an error frame (message only) when the runner throws', async () => {
    const chunks: string[] = [];
    const runner: OrchestratorRunner = async () => { throw new Error('boom'); };
    await streamRun(runner, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('event: error\ndata: {"message":"boom"}\n\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL — `Cannot find module './streamRun.js'`.

- [ ] **Step 3: Implement streamRun**

```ts
// apps/web/src/streamRun.ts
import type { TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

export type OrchestratorRunner = (emit: (e: TraceEvent) => void) => Promise<{ section: string }>;

export async function streamRun(runner: OrchestratorRunner, write: (chunk: string) => void): Promise<void> {
  try {
    const { section } = await runner((e) => write(encodeEvent(e)));
    write(encodeNamed('done', { section }));
  } catch (err) {
    write(encodeNamed('error', { message: err instanceof Error ? err.message : 'unknown error' }));
  }
}
```

```ts
// apps/web/src/index.ts
export { encodeEvent, encodeNamed } from './sse.js';
export { streamRun, type OrchestratorRunner } from './streamRun.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/web test` → Expected: PASS (4 tests total).

```bash
git add -A
git commit -m "feat(web): streamRun bridges orchestrator emit to SSE frames"
```

---

### Task 3: HTTP server (static + `/api/run` SSE), dependency-injected

**Files:**
- Create: `apps/web/src/server.ts`
- Modify: `apps/web/src/index.ts` (add export)
- Test: `apps/web/src/server.test.ts`

**Interfaces:**
- Consumes: `streamRun`, `OrchestratorRunner` (Task 2).
- Produces:
  `interface ServerDeps { publicDir: string; makeRunner: (query: string, symbol: string) => OrchestratorRunner }`
  `function createServer(deps: ServerDeps): http.Server` — routes: `GET /` → `index.html`; `GET /app.js`, `/styles.css`, `/fonts/*` → static files from `publicDir` (content-type by extension; 404 if missing); `GET /api/run?q=<query>&symbol=<symbol>` → SSE (`content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`) driven by `streamRun(deps.makeRunner(query, symbol), write)`; any other path → 404.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TraceEvent } from '@sonny/shared';
import { createServer } from './server.js';
import type { OrchestratorRunner } from './streamRun.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
let server: Server | undefined;
afterEach(() => server?.close());

function listen(s: Server): Promise<string> {
  return new Promise((res) => s.listen(0, () => res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

const fakeRunner: OrchestratorRunner = async (emit) => {
  emit({ type: 'evidence_registered', id: 'ENSG00000146648', title: 'EGFR' } as TraceEvent);
  return { section: 'EGFR is a target. [ENSG00000146648]' };
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
    expect(body).toContain('ENSG00000146648');
    expect(body).toContain('event: done');
  });

  it('404s an unknown path', async () => {
    server = createServer({ publicDir, makeRunner: () => fakeRunner });
    const base = await listen(server);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Create a minimal `public/index.html` so the static route has something to serve**

(The full design lands in Task 4; this stub makes Task 3's tests runnable.)

```html
<!-- apps/web/public/index.html -->
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sonny</title></head>
<body><div id="app">Sonny glass-box</div><script src="/app.js"></script></body></html>
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 4: Implement the server**

```ts
// apps/web/src/server.ts
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { streamRun, type OrchestratorRunner } from './streamRun.js';

export interface ServerDeps {
  publicDir: string;
  makeRunner: (query: string, symbol: string) => OrchestratorRunner;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json',
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
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
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
```

```ts
// apps/web/src/index.ts  (append)
export { createServer, type ServerDeps } from './server.js';
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/web test` → Expected: PASS (7 tests total).

```bash
git add -A
git commit -m "feat(web): node http server with static routes + /api/run SSE"
```

---

### Task 4: Glass-box front-end (the locked dossier design wired to SSE)

**Files:**
- Create: `apps/web/public/styles.css`, `apps/web/public/app.js`, `apps/web/public/fonts/Figtree.ttf`, `apps/web/public/fonts/IBMPlexMono.ttf`
- Modify: `apps/web/public/index.html` (replace the Task 3 stub with the real design)
- Test: `apps/web/src/frontend.test.ts`

**Interfaces:**
- Consumes: the SSE stream from `/api/run` (Task 3); `TraceEvent` shapes from `@sonny/shared`.
- Produces: a browser UI. The HTML must contain these element ids that `app.js` targets (the structural contract this task's test enforces): `#query`, `#run`, `#verdict`, `#meta`, `#trace`, `#dossier`, `#evidence-list`, `#drawer`, `#drawer-body`, `#edits-toggle`.

**Design source:** adapt `~/Quan_project/.superpowers/brainstorm/8278-1782519876/content/dossier-v7-figtree.html` — reuse its palette, Figtree/IBM-Plex-Mono typography, single-column journal layout, evidence-drawer markup, and "view agent edits" treatment. Move its inline `<style>` into `styles.css`; self-host the fonts via `@font-face` (do NOT load Google Fonts). Replace its hard-coded content with the live containers below.

- [ ] **Step 1: Copy the self-hosted fonts**

```bash
mkdir -p apps/web/public/fonts
cp ~/Downloads/Figtree/Figtree-VariableFont_wght.ttf apps/web/public/fonts/Figtree.ttf
# IBM Plex Mono: if not present locally, download the regular weight ttf into the path below.
# (A single regular weight is sufficient for identifiers.)
```

If `~/Downloads/Figtree/Figtree-VariableFont_wght.ttf` is missing, STOP and report NEEDS_CONTEXT (the OFL font files are required for offline self-hosting). For IBM Plex Mono, if no local ttf is available, fetch the regular weight from the IBM Plex GitHub release into `apps/web/public/fonts/IBMPlexMono.ttf`.

- [ ] **Step 2: Write the failing structural test**

```ts
// apps/web/src/frontend.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('front-end contract', () => {
  it('index.html exposes the element ids app.js drives', () => {
    const html = readFileSync(join(pub, 'index.html'), 'utf8');
    for (const id of ['query', 'run', 'verdict', 'meta', 'trace', 'dossier', 'evidence-list', 'drawer', 'drawer-body', 'edits-toggle']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('href="/styles.css"');
    expect(html).toContain('src="/app.js"');
  });

  it('styles.css self-hosts Figtree (no Google Fonts)', () => {
    const css = readFileSync(join(pub, 'styles.css'), 'utf8');
    expect(css).toContain('@font-face');
    expect(css).toContain('/fonts/Figtree.ttf');
    expect(css).not.toContain('fonts.googleapis.com');
  });

  it('app.js handles the core TraceEvent types and the done event', () => {
    const js = readFileSync(join(pub, 'app.js'), 'utf8');
    for (const t of ['plan', 'tool_call', 'evidence_registered', 'claim_drafted', 'verdict', 'synthesis', 'error']) {
      expect(js).toContain(t);
    }
    expect(js).toContain('EventSource');
    expect(js).toContain("addEventListener('done'");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL — cannot read `styles.css`/`app.js` (not created yet) or missing ids.

- [ ] **Step 4: Write `index.html` (real design, live containers)**

```html
<!-- apps/web/public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sonny — grounded biomedical due diligence</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="page">
    <main class="sheet">
      <div class="composer">
        <input id="query" type="text" placeholder="Ask a target-biology question, e.g. Is EGFR a druggable target in NSCLC?">
        <button id="run">Run</button>
        <span id="edits-toggle" class="lnk" hidden>View agent edits</span>
      </div>
      <h1 id="verdict" class="verdict">Sonny</h1>
      <div id="meta" class="meta"></div>
      <hr class="rule">
      <section id="dossier" class="dossier"></section>
      <h2 class="lane">Supporting evidence</h2>
      <div id="evidence-list" class="evidence"></div>
      <details class="proc"><summary>Research process</summary><div id="trace" class="trace"></div></details>
    </main>
  </div>
  <div class="scrim" id="scrim"></div>
  <aside class="drawer" id="drawer"><span class="x" id="drawer-close">✕</span><div id="drawer-body"></div></aside>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Write `styles.css` (port the v7 mockup styles; self-host fonts)**

Port the palette/typography/layout from the v7 mockup design source into `styles.css`. It MUST include the self-hosted font faces and the design tokens:

```css
/* apps/web/public/styles.css */
@font-face { font-family: 'Figtree'; src: url('/fonts/Figtree.ttf') format('truetype'); font-weight: 300 700; font-display: swap; }
@font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/IBMPlexMono.ttf') format('truetype'); font-weight: 400; font-display: swap; }
:root{ --bg:#EEF0F3; --sheet:#FFFFFF; --border:#E6E8EC; --ink:#0F172A; --text:#334155; --muted:#6B7280;
  --accent:#1D4ED8; --ok:#0F766E; --warn:#B45309; --mono:'IBM Plex Mono',ui-monospace,monospace; --fig:'Figtree',system-ui,sans-serif; }
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--fig);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
.page{max-width:920px;margin:24px auto;padding:0 16px}
.sheet{background:var(--sheet);border:1px solid var(--border);border-radius:12px;padding:36px 44px 44px}
.composer{display:flex;gap:10px;align-items:center;margin-bottom:22px}
#query{flex:1;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:inherit;color:var(--ink)}
#run{border:1px solid var(--accent);color:#fff;background:var(--accent);border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
.lnk{font-size:12px;color:var(--muted);cursor:pointer}.lnk.on{color:var(--accent)}
.verdict{font-family:var(--fig);font-size:26px;line-height:1.25;font-weight:600;color:var(--ink);letter-spacing:-.01em;margin:0 0 12px}
.meta{font-size:12px;color:var(--muted)}
.rule{border:0;border-top:1px solid var(--border);margin:20px 0}
.lane{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:24px 0 10px}
.dossier p{margin:0 0 12px;max-width:68ch}
.cite{font-family:var(--mono);font-size:11px;color:var(--accent);cursor:pointer}
.claim{padding:10px 0;border-bottom:1px solid var(--border)}.claim:last-child{border-bottom:none}
.vlabel{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:7px}.vlabel b{color:var(--ok);font-weight:600}
.vlabel.warn b{color:var(--warn)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.erow{display:flex;gap:10px;padding:9px 4px;border-bottom:1px solid var(--border)}.erow:last-child{border-bottom:none}
.eid{font-family:var(--mono);font-size:11px;color:var(--accent);cursor:pointer}.et{font-size:12px;color:var(--muted)}
.proc{margin-top:22px}.proc summary{cursor:pointer;font-size:12px;color:var(--muted);font-weight:600}
.trace{font-family:var(--mono);font-size:11.5px;color:#475569;white-space:pre-wrap;margin-top:8px}
.drawer{position:fixed;top:0;right:-460px;width:440px;height:100%;background:#fff;border-left:1px solid var(--border);box-shadow:-8px 0 30px rgba(16,24,40,.12);transition:right .22s;padding:26px 24px;overflow:auto;z-index:50}
.drawer.open{right:0}.drawer .x{position:absolute;top:16px;right:18px;color:var(--muted);cursor:pointer}
.scrim{position:fixed;inset:0;background:rgba(16,24,40,.18);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}.scrim.on{opacity:1;pointer-events:auto}
body.show-edits .rl{display:block}.rl{display:none;margin-top:8px;border-left:3px solid var(--warn);background:#faf7f2;border-radius:0 6px 6px 0;padding:9px 12px;font-size:12.5px}
```

- [ ] **Step 6: Write `app.js` (consume SSE, render incrementally)**

```js
// apps/web/public/app.js
const $ = (id) => document.getElementById(id);
const evidence = new Map();         // id -> {id, title}
let es = null;

function openDrawer(id) {
  const e = evidence.get(id);
  $('drawer-body').innerHTML = e
    ? `<div style="font-family:var(--mono);color:var(--accent)">${e.id}</div><div style="font-weight:600;margin-top:6px">${e.title}</div>`
    : `<div>${id}</div>`;
  $('drawer').classList.add('open'); $('scrim').classList.add('on');
}
function closeDrawer() { $('drawer').classList.remove('open'); $('scrim').classList.remove('on'); }
$('drawer-close').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
$('edits-toggle').onclick = () => { document.body.classList.toggle('show-edits'); $('edits-toggle').classList.toggle('on'); };

function citeHtml(ids) { return (ids || []).map((id) => `<span class="cite" data-id="${id}">[${id}]</span>`).join(' '); }
function appendTrace(line) { $('trace').textContent += line + '\n'; }

function reset() {
  evidence.clear(); $('trace').textContent = ''; $('dossier').innerHTML = '';
  $('evidence-list').innerHTML = ''; $('verdict').textContent = 'Researching…';
  $('meta').textContent = ''; $('edits-toggle').hidden = true; document.body.classList.remove('show-edits');
}

function handle(ev) {
  switch (ev.type) {
    case 'plan': appendTrace(`PLAN  specialists=${ev.specialists.join(',')} tools=${ev.tools.join(',')}`); break;
    case 'tool_call': appendTrace(`  → ${ev.tool}(${JSON.stringify(ev.args)})`); break;
    case 'tool_result': appendTrace(`  ← ${ev.tool}: ${ev.count} record(s)`); break;
    case 'evidence_registered': {
      evidence.set(ev.id, { id: ev.id, title: ev.title });
      const row = document.createElement('div'); row.className = 'erow';
      row.innerHTML = `<div><div class="eid" data-id="${ev.id}">${ev.id}</div><div class="et">${ev.title}</div></div>`;
      $('evidence-list').appendChild(row); break;
    }
    case 'claim_drafted': appendTrace(`  claim ${ev.claim.id}: ${ev.claim.text}`); break;
    case 'verdict': appendTrace(`  verdict ${ev.verdict.claimId}: ${ev.verdict.status}`); break;
    case 'synthesis': {
      // section is plain text with [ID] tokens — render with clickable citation chips.
      const html = ev.section.split('\n').map((line) =>
        `<p>${line.replace(/\[([^\]]+)\]/g, (_, id) => `<span class="cite" data-id="${id}">[${id}]</span>`)}</p>`).join('');
      $('dossier').innerHTML = html; break;
    }
    case 'error': appendTrace(`  ! ${ev.message}`); break;
  }
}

function wireCitations() {
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]'); if (t) openDrawer(t.getAttribute('data-id'));
  });
}
wireCitations();

function run() {
  const q = $('query').value.trim(); if (!q) return;
  if (es) es.close(); reset();
  const symbol = (q.match(/\b[A-Z0-9]{2,7}\b/) || ['EGFR'])[0];
  es = new EventSource(`/api/run?q=${encodeURIComponent(q)}&symbol=${encodeURIComponent(symbol)}`);
  es.onmessage = (m) => handle(JSON.parse(m.data));
  es.addEventListener('done', (m) => {
    const { section } = JSON.parse(m.data);
    $('verdict').textContent = section ? 'Findings' : 'No grounded findings';
    $('meta').textContent = `${evidence.size} sources cited · grounded + verified`;
    $('edits-toggle').hidden = false; es.close();
  });
  es.addEventListener('error', (m) => {
    try { appendTrace('  ! ' + JSON.parse(m.data).message); } catch { /* connection closed */ }
    es.close();
  });
}
$('run').onclick = run;
$('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
```

- [ ] **Step 7: Run tests, then verify the live page manually**

Run: `pnpm --filter @sonny/web test` → Expected: PASS (10 tests total).

Manual (after Task 5 wires the entry): start the server with a key, open `http://localhost:8787`, type "Is EGFR a druggable target in NSCLC?", click Run. Expected: the trace fills under "Research process", evidence rows appear with real `ENSG…`/`PMID:` ids, the dossier paragraphs render with clickable `[ID]` chips that open the drawer, and "View agent edits" appears on completion.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): journal glass-box front-end (Figtree, SSE trace + cited dossier + evidence drawer)"
```

---

### Task 5: Real entry — wire the orchestrator and start the server

**Files:**
- Create: `apps/web/src/main.ts`
- Modify: `apps/web/src/index.ts` (no export change needed; `main.ts` is the runtime entry referenced by the `start` script — update `package.json` `start` to point at it)
- Test: `apps/web/src/main.test.ts`

**Interfaces:**
- Consumes: `createServer` (Task 3); `runOrchestration`, `AnthropicModel` (`@sonny/core`); `openTargetsTool`, `pubmedTool` (`@sonny/mcp-gateway`).
- Produces: `function buildDeps(publicDir: string): ServerDeps` — returns deps whose `makeRunner(query, symbol)` constructs an `OrchestratorRunner` that calls `runOrchestration({ query, symbol, tools: [openTargetsTool, pubmedTool], specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), emit })`. `main.ts` calls `createServer(buildDeps(...)).listen(PORT)`.

- [ ] **Step 1: Point the start script at the entry**

Edit `apps/web/package.json`: change `"start"` to `"tsx src/main.ts"`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/main.test.ts
import { describe, it, expect } from 'vitest';
import { buildDeps } from './main.js';

describe('buildDeps', () => {
  it('produces server deps with a runner factory and the public dir', () => {
    const deps = buildDeps('/tmp/public');
    expect(deps.publicDir).toBe('/tmp/public');
    expect(typeof deps.makeRunner).toBe('function');
    // makeRunner returns a function (the runner) without constructing models eagerly
    expect(typeof deps.makeRunner('q', 'EGFR')).toBe('function');
  });
});
```

Note: constructing the *runner* must not construct `AnthropicModel` until the runner is invoked (so this test needs no API key). Build the models lazily inside the returned runner.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL — `Cannot find module './main.js'`.

- [ ] **Step 4: Implement the entry**

```ts
// apps/web/src/main.ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runOrchestration, AnthropicModel } from '@sonny/core';
import { openTargetsTool, pubmedTool } from '@sonny/mcp-gateway';
import { createServer, type ServerDeps } from './server.js';

export function buildDeps(publicDir: string): ServerDeps {
  return {
    publicDir,
    makeRunner: (query, symbol) => async (emit) => {
      const { section } = await runOrchestration({
        query, symbol, tools: [openTargetsTool, pubmedTool],
        specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), emit,
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
    console.log(`Sonny glass-box on http://localhost:${port}`);
  });
}
```

- [ ] **Step 5: Run unit tests; then verify live**

Run: `pnpm --filter @sonny/web test` → Expected: PASS (11 tests total).
Run the whole suite: `pnpm -r test` → Expected: all packages green.

Manual live run (requires key):
```bash
ANTHROPIC_API_KEY=sk-... pnpm --filter @sonny/web start
# open http://localhost:8787 and run a query
```
Expected: the glass-box renders the live trace + a verified, cited dossier (matches the Task 4 manual expectation).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): wire real orchestrator entry + start script"
```

---

## Self-Review

**Spec coverage (Plan 2 scope = spec §6 web glass-box rendering + §7 design system):**
- §6 "Web glass-box renders the live trace": SSE endpoint (Tasks 2–3) + incremental front-end render (Task 4) ✓
- §6 inline citation chips → evidence drawer: Task 4 (`.cite[data-id]` → `openDrawer`) ✓
- §6 "view agent edits" toggle: Task 4 (`#edits-toggle`, `show-edits` class + `.rl` style) ✓ (the redline content arrives when the core emits agent-edit data — deferred with §3 `Verdict.evidenceId`/edit payload; the toggle + styling are in place)
- §7 design system (Figtree self-hosted, IBM Plex Mono ids, palette, single-column journal, dot+label, ≤3 tokens): Tasks 4 (CSS + fonts) ✓
- BYO key, no key in frames/logs: Tasks 2 (error message-only) + 5 (lazy model construction) ✓
- Robustness: a thrown run yields an `error` frame, not a crash (Task 2) ✓
- **Deferred (not gaps):** the contents-rail + multi-section dossier (current core emits a single synthesized `section`, so the front-end renders one document — multi-section + RAG dots arrive when specialists/sections land in a later plan); knowledge-graph view; PDF export; Slack.

**Placeholder scan:** none — every code/test step has complete content. The one external dependency (the Figtree OFL ttf) has an explicit copy step + a NEEDS_CONTEXT escalation if absent.

**Type consistency:** `OrchestratorRunner` (Task 2) is consumed identically by Tasks 3 and 5; `ServerDeps`/`createServer` (Task 3) consumed by Task 5; `encodeEvent`/`encodeNamed` (Task 1) used by Task 2; the `runOrchestration` call shape in Task 5 matches the signature shipped in Plan 1 (`{ query, symbol, tools, specialistModel, verifierModel, emit } → { section, shipped, verdicts }`); the front-end `handle()` switch (Task 4) covers the same `TraceEvent` variants defined in `@sonny/shared`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-sonny-v2-web-glassbox.md`.
