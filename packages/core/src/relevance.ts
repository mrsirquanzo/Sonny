import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';

export function targetTerms(store: EvidenceStore, fallbackSymbol?: string): string[] {
  const terms = new Set<string>();
  if (fallbackSymbol) terms.add(fallbackSymbol.toLowerCase());
  const target = store.all().find((e) => e.kind === 'target');
  if (target) {
    const raw = target.raw as { approvedSymbol?: string; synonyms?: string[] };
    if (raw.approvedSymbol) terms.add(raw.approvedSymbol.toLowerCase());
    for (const s of raw.synonyms ?? []) {
      if (s.length >= 3) terms.add(s.toLowerCase());
    }
  }
  return [...terms];
}

export function mentionsAny(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

export function titleMentionsTarget(e: Evidence, terms: string[]): boolean {
  return mentionsAny(e.title, terms);
}

export function relevanceGate(hits: Evidence[], terms: string[]): Evidence[] {
  if (terms.length === 0) return hits;
  return hits.filter((h) => mentionsAny(`${h.title} ${h.passage ?? ''} ${h.snippet}`, terms));
}
