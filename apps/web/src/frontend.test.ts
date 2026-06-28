// apps/web/src/frontend.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('front-end contract', () => {
  it('index.html exposes the element ids app.js drives', () => {
    const html = readFileSync(join(pub, 'index.html'), 'utf8');
    for (const id of ['query', 'run', 'verdict', 'meta', 'trace', 'dossier', 'evidence-list', 'drawer', 'drawer-body', 'edits-toggle', 'contents', 'skipped']) {
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
    for (const t of ['plan', 'tool_call', 'evidence_registered', 'claim_drafted', 'verdict', 'error']) {
      expect(js).toContain(t);
    }
    expect(js).toContain('EventSource');
    expect(js).toContain("addEventListener('done'");
    expect(js).toContain('section_complete');
    expect(js).toContain('specialist_skipped');
    expect(js).toContain('renderSection');
  });
});
