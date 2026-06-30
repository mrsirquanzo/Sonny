# Citation Snowball Design

**Status:** Approved, ready for implementation plan.
**Slice:** 11 (retrieve like a scientist, part 2: snowball from seminal papers).
**Date:** 2026-06-29.

## Problem

A scientist, having read a seminal paper, follows its citation graph to reach related work and specialty labs - rather than only guessing keywords.
Sonny finds seminal papers (broad TITLE_ABS search, sorted by citations) but never expands from them.
Forward citations of the original CDCP1 papers surface recent, on-target work the keyword search alone may miss ("CDCP1 promotes nasopharyngeal carcinoma malignancy", "Differential Role of CD318 in Tumor Immunity").

## Design

After a thread deep-reads its first seminal paper, snowball one hop along forward citations.

### 1. `europepmc_citations` tool (mcp-gateway)

`call({ pmid })` -> GET `/MED/{pmid}/citations?format=json&pageSize=8&sort=CITED desc` -> returns the citing papers as Evidence.
The citations endpoint returns `{ id, source, title, citedByCount, pubYear }` per citer - title only, no abstract or pmcid.
Map each `source === 'MED'` citer to `{ id: 'PMID:<id>', kind: 'publication', source: 'Europe PMC', title, snippet: 'cited <n>x . <year>', passage: '', url, raw: { citedByCount, pubYear } }`.
Throws on non-OK HTTP (so `safeToolCall` isolates it).

### 2. `snowballCitations` step (new `snowball.ts` in core)

`snowballCitations({ seed, terms, tools, store, emit })`:
1. Resolve the seed PMID from `seed.id` (strip the `PMID:` prefix); return if absent or the `europepmc_citations` / `europepmc_search` tools are missing.
2. `citations(pmid)` -> candidates; `relevanceGate(..., terms)` - effectively a title gate, since citations carry no abstract.
3. Take the top **K = 3**.
4. **Hydrate** each: `europepmc_search({ query: 'EXT_ID:<pmid> AND SRC:MED' })` returns the full record (abstract + pmcid; verified live); `relevanceGate(..., terms)`; register.
5. `safeToolCall`-wrapped throughout; emits `tool_call` / `tool_result` / `evidence_registered`.

Hydrated neighbors are registered as evidence (their abstracts feed `extractClaims` and the references list). They are not themselves recursively deep-read - that keeps the hop bounded.

### 3. Wire into `runResearcher` (once per thread)

Declare `let snowballed = false;` before the round loop.
Inside the existing `if (top)` deep-read block, after the passages are registered, add:

```ts
if (!snowballed) {
  snowballed = true;
  await snowballCitations({ seed: top, terms, tools, store, emit });
}
```

So each of the five specialists snowballs exactly once, from its first deep-read seminal paper.

### 4. Register the tool

Export `europePmcCitationsTool` from `mcp-gateway/index.ts`, and add it to `literatureTools` in `apps/cli/src/deep.ts`.

## Out of scope

- Backward references; recursive multi-hop snowball; deep-reading the neighbors.
- Specialty-lab / modality-expert detection (next slice).
- Confidence clamp.

## Testing

- `europePmc citations` tool test: mock fetch returns a `citationList` with two MED citers and one non-MED entry; assert only MED citers map to `PMID:` Evidence with empty passage and the citedByCount in raw.
- `snowball.test.ts`:
  (a) title-gates citers (a citer whose title lacks the target is dropped) and hydrates only the top K=3;
  (b) hydrated records are registered into the store;
  (c) returns without throwing when the citations or search tool is absent, or the seed has no PMID.
- `researcher.test.ts`: a thread that deep-reads twice snowballs only once (assert the `europepmc_citations` tool is called exactly once across rounds).
- Full core suite green.

## Success criteria

A re-run smoke shows, after a thread's first deep-read, an `europepmc_citations` call followed by `EXT_ID:` hydration searches, with citation-neighbor papers registered and appearing among the dossier references.
