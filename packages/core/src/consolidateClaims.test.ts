import { describe, it, expect } from 'vitest';
import type { Section, Claim } from '@mrsirquanzo/sonny-shared';
import { consolidateSectionClaims } from './consolidateClaims.js';

function claim(id: string, text: string, citations: string[] = [], confidence = 0.8): Claim {
  return { id, text, citations, confidence };
}

function section(id: string, claims: Claim[]): Section {
  return { kind: 'research', id, title: id, takeaway: `${id} takeaway`, claims, sources: [], rag: 'green' };
}

describe('consolidateSectionClaims', () => {
  it('collapses an identical fact restated across sections, keeping one copy', () => {
    const sections = [
      section('a', [claim('a1', 'TROP2 is overexpressed in epithelial cancers.', ['PMID:1'])]),
      section('b', [claim('b1', 'Trop-2 is overexpressed in epithelial cancers.', ['PMID:1'])]),
      section('c', [claim('c1', 'TROP-2 is overexpressed in epithelial cancers!', ['PMID:1'])]),
    ];
    const { sections: out, merged } = consolidateSectionClaims(sections);
    expect(merged).toBe(2);
    const total = out.flatMap((s) => s.claims).length;
    expect(total).toBe(1);
  });

  it('treats reworded claims citing the same evidence as one fact', () => {
    const sections = [
      section('a', [claim('a1', 'Trop-2 is overexpressed in various epithelial-derived cancers.', ['PMID:9', 'PMID:8'])]),
      section('b', [claim('b1', 'Trop-2 (also known as TROP2) is overexpressed in various epithelial-derived cancers.', ['PMID:8', 'PMID:9'])]),
    ];
    const { sections: out, merged } = consolidateSectionClaims(sections);
    expect(merged).toBe(1);
    expect(out.flatMap((s) => s.claims).length).toBe(1);
  });

  it('keeps the best-supported representative and unions the citations', () => {
    const sections = [
      section('a', [claim('a1', 'X is essential.', ['PMID:1'], 0.6)]),
      section('b', [claim('b1', 'X is essential.', ['PMID:1', 'PMID:2', 'PMID:3'], 0.9)]),
    ];
    const { sections: out } = consolidateSectionClaims(sections);
    const kept = out.flatMap((s) => s.claims);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('b1');
    expect([...kept[0].citations].sort()).toEqual(['PMID:1', 'PMID:2', 'PMID:3']);
  });

  it('does not merge genuinely distinct claims that share a citation', () => {
    const sections = [
      section('a', [
        claim('a1', 'TROP2 drives proliferation via ERK signaling.', ['PMID:1']),
        claim('a2', 'TROP2 knockdown reduces migration in TNBC lines.', ['PMID:1']),
      ]),
    ];
    const { sections: out, merged } = consolidateSectionClaims(sections);
    expect(merged).toBe(0);
    expect(out[0].claims).toHaveLength(2);
  });

  it('is a no-op when there are no duplicates', () => {
    const sections = [section('a', [claim('a1', 'fact one', ['PMID:1']), claim('a2', 'fact two', ['PMID:2'])])];
    const { sections: out, merged } = consolidateSectionClaims(sections);
    expect(merged).toBe(0);
    expect(out).toEqual(sections);
  });
});
