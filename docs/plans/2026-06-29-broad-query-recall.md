# Broad-Query Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every literature search a broad two-term query `<target> AND <concept>` so Europe PMC stops returning 0 records for over-specific multi-keyword queries.

**Architecture:** A pure `buildSearchQuery(target, concept)` helper assembles the query. The planner, reflect, and completeness prompts emit a single short `concept` (1-2 words, target-free) instead of a multi-keyword `searchQuery`. The research loop and the gap-filler assemble `<target> AND <concept>` and send that. The relevance gate is unchanged and remains the precision backstop.

**Tech Stack:** TypeScript ESM (Node 20+), Vitest, Zod. Test runner: `pnpm --filter @sonny/core test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Surgical changes only; match existing style. Do not touch the relevance gate, `fillGap` deep-read selection, or confidence schemas (all out of scope).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- The model emits a `concept` of 1-2 words and never the target symbol; the loop adds the target. No keyword lists, no sentences.

---

### Task 1: buildSearchQuery helper

**Files:**
- Create: `packages/core/src/searchQuery.ts`
- Test: `packages/core/src/searchQuery.test.ts`

**Interfaces:**
- Produces: `buildSearchQuery(target: string, concept: string): string`. Returns `target` alone when concept is empty; `` `${target} AND ${concept}` `` for a single-word concept; `` `${target} AND "${concept}"` `` (phrase-quoted) when the concept contains whitespace.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/searchQuery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from './searchQuery.js';

describe('buildSearchQuery', () => {
  it('joins target and a single-word concept with AND', () => {
    expect(buildSearchQuery('CDCP1', 'ADC')).toBe('CDCP1 AND ADC');
  });

  it('phrase-quotes a multi-word concept so it is not AND-split', () => {
    expect(buildSearchQuery('CDCP1', 'cell therapy')).toBe('CDCP1 AND "cell therapy"');
  });

  it('returns the target alone when the concept is empty or whitespace', () => {
    expect(buildSearchQuery('CDCP1', '')).toBe('CDCP1');
    expect(buildSearchQuery('CDCP1', '   ')).toBe('CDCP1');
  });

  it('trims surrounding whitespace from the concept', () => {
    expect(buildSearchQuery('CDCP1', '  oncology  ')).toBe('CDCP1 AND oncology');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- searchQuery`
Expected: FAIL - `buildSearchQuery` is not defined.

- [ ] **Step 3: Implement the helper**

Create `packages/core/src/searchQuery.ts`:

```ts
// Assemble a broad two-term Europe PMC query: the target plus one concept facet.
// The target is always pinned; the concept is phrase-quoted when multi-word so
// Europe PMC treats it as one phrase rather than ANDing each word.
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  if (!c) return target;
  return /\s/.test(c) ? `${target} AND "${c}"` : `${target} AND ${c}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- searchQuery`
Expected: PASS - all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/searchQuery.ts packages/core/src/searchQuery.test.ts
git commit -m "feat(core): add buildSearchQuery for broad target AND concept queries"
```

---

### Task 2: Researcher emits concept and searches broad

**Files:**
- Modify: `packages/core/src/researcher.ts`
- Test: `packages/core/src/researcher.test.ts`

**Interfaces:**
- Consumes: `buildSearchQuery` from `./searchQuery.js`.
- Produces: `ResearchQuestion` becomes `{ question: string; concept: string }` (field `searchQuery` renamed to `concept`). `planResearchQuestions` and `reflectOnGaps` return questions/followups carrying `concept`.

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/researcher.test.ts`, make these edits:

1. Add the import near the top (after the existing imports):

```ts
import { buildSearchQuery } from './searchQuery.js';
```

2. Replace every `searchQuery: '<value>'` inside a model-reply fixture with `concept: '<short>'`. The exact replacements:
   - line ~27: `searchQuery: 'CDCP1 mechanism action'` -> `concept: 'mechanism'`
   - line ~32 assertion: `expect(qs[0].searchQuery).toBe('CDCP1 mechanism action')` -> `expect(qs[0].concept).toBe('mechanism')`
   - line ~65: `searchQuery: 'CDCP1 mechanism action cancer'` -> `concept: 'mechanism'`
   - line ~99: `searchQuery: 'q kw'` -> `concept: 'kw'`
   - line ~101: `followups: [{ question: 'again', searchQuery: 'again kw' }]` -> `followups: [{ question: 'again', concept: 'again' }]`
   - line ~116: `searchQuery: 'kw'` -> `concept: 'kw'`
   - line ~142: `searchQuery: 'cdcp1 proteomics'` -> `concept: 'proteomics'`
   - line ~175: `searchQuery: 'cdcp1 mechanism'` -> `concept: 'mechanism'`
   - line ~251: `searchQuery: 'kw'` -> `concept: 'kw'`

3. Rewrite the test titled `'returns objects with question and searchQuery, includes target in prompt'` (line ~22) - rename it and assert the concept field:

```ts
  it('returns objects with question and concept, includes target in prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { questions: [{ question: 'What is the MOA of CDCP1?', concept: 'mechanism' }] } as never;
      },
    };
    const qs: ResearchQuestion[] = await planResearchQuestions(brief, 'CDCP1', model);
    expect(qs[0].question).toBe('What is the MOA of CDCP1?');
    expect(qs[0].concept).toBe('mechanism');
    expect(prompt).toContain('CDCP1');
    expect(prompt).toContain('Target Biology');
  });
```

4. Replace the test titled `'pins the bug fix: search tool receives the concise searchQuery, not the long question text'` (line ~194) with one that pins the assembled broad query:

```ts
  it('sends the broad target AND concept query to the search tool, not the question text', async () => {
    const recordedQueries: string[] = [];
    const trackingSearch: Tool = {
      name: 'europepmc_search',
      description: 'europepmc_search',
      async call(args: Record<string, unknown>) {
        recordedQueries.push(String(args['query'] ?? ''));
        return [] as never;
      },
    };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return [] as never; } };
    const replies = [
      { questions: [{ question: 'What is the long-winded mechanism of action question?', concept: 'mechanism' }] },
      { claims: [] },
      { done: true, followups: [], takeaway: 't' },
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [trackingSearch, fulltext], store: new EvidenceStore(),
      model, emit: () => {}, budget: { maxRounds: 1 },
    });

    expect(recordedQueries[0]).toBe(buildSearchQuery('CDCP1', 'mechanism')); // 'CDCP1 AND mechanism'
    expect(recordedQueries[0]).not.toContain('long-winded');
  });
```

5. Replace the test titled `'instructs the model to keep the target symbol in every searchQuery'` (line ~232) - the instruction inverts to a target-free concept:

```ts
  it('instructs the model to emit a single concept without the target symbol', async () => {
    let system = '';
    const model = { async generateStructured(o: { system: string }) { system = o.system; return { questions: [{ question: 'q', concept: 'mechanism' }] } as never; } };
    await planResearchQuestions({ id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' }, 'CDCP1', model);
    expect(system).toContain('concept');
    expect(system.toLowerCase()).toContain('do not include the target');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- researcher`
Expected: FAIL - `ResearchQuestion.concept` does not exist; prompts do not mention `concept`; the query sent is the raw value, not `CDCP1 AND mechanism`.

- [ ] **Step 3: Update the schemas, types, prompts, and query assembly**

In `packages/core/src/researcher.ts`:

1. Add the import on line 5 area (after the relevance import):

```ts
import { buildSearchQuery } from './searchQuery.js';
```

2. Change `ResearchQuestion` (line ~9):

```ts
export interface ResearchQuestion { question: string; concept: string }
```

3. Change `QuestionsSchema` (line ~11):

```ts
const QuestionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    concept: z.string().min(1),
  })).min(1).max(5),
});
```

4. Replace the `planResearchQuestions` system+prompt (line ~21-24):

```ts
    system: `You are the ${brief.title} research specialist. ${brief.promptHint}\nPlan the specific, answerable research questions you must investigate to assess this target at expert depth.\nFor each item return:\n- question: a precise, answerable research question\n- concept: ONE short topic facet of 1-2 words that narrows the search (examples: 'ADC', 'oncology', 'signaling', 'metastasis', 'resistance'). Do NOT include the target gene symbol - it is added automatically. Do NOT write a sentence or a list of keywords, just the single concept.`,
    prompt: `BRIEF: ${brief.title}\nTARGET: ${target}\nOBJECTIVE: ${brief.objective}\nList up to 5 research questions, most important first. Each must have a question and a single short concept.`,
```

5. Change `ReflectSchema` followups (line ~50-57):

```ts
const ReflectSchema = z.object({
  done: z.boolean(),
  followups: z.array(z.object({
    question: z.string().min(1),
    concept: z.string().min(1),
  })).max(3),
  takeaway: z.string(),
});
```

6. Replace the `reflectOnGaps` system prompt's follow-up instruction (line ~63) - change the `searchQuery` bullet to a concept bullet:

```ts
    system: `You are the ${brief.title} research lead reviewing your own progress. Decide whether the thread is sufficiently covered for expert-level assessment. If a critical question remains unanswered, or a source raised a new high-value thread (e.g. a resistance mechanism), list up to 3 follow-up questions. Each follow-up needs:\n- question: a precise research question\n- concept: ONE short topic facet of 1-2 words (no sentence, no keyword list) and do NOT include the target gene symbol - it is added automatically\nOtherwise set done=true. Always write a one-line takeaway summarizing the thread so far.`,
```

7. Replace the search-query assembly in `runResearcher` (line ~94-95). Compute the broad query once and use it in both the emit and the call:

```ts
    const query = buildSearchQuery(target, item.concept);
    emit({ type: 'tool_call', tool: search.name, args: { query } });
    const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
```

- [ ] **Step 4: Run the researcher tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- researcher`
Expected: PASS - all researcher cases green, including the two rewritten semantic tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts
git commit -m "feat(core): planner emits concept; research loop searches target AND concept"
```

---

### Task 3: Gap-filler emits concept and searches broad

**Files:**
- Modify: `packages/core/src/completeness.ts`
- Modify: `packages/core/src/runDeepResearch.ts:58` (pass `target` to `fillGap`)
- Test: `packages/core/src/completeness.test.ts`
- Test: `packages/core/src/runDeepResearch.test.ts`
- Test: `packages/core/src/produceResearchSection.test.ts`

**Interfaces:**
- Consumes: `buildSearchQuery` from `./searchQuery.js`.
- Produces: `ResearchGap` becomes `{ specialistId: string; question: string; concept: string; reason: string }`. `fillGap` gains a required `target: string` option.

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/completeness.test.ts`:

1. Line ~22 (assessCompleteness gap fixture): `searchQuery: 'CDCP1 clinical trial'` -> `concept: 'trials'`.
2. Every `fillGap({ ... })` call in this file (there are three: the "only supported survives" test, the `fillGap resilience` test, and the `fillGap relevance gating` test) gets `target: 'CDCP1',` added to its options object.
3. Rename the gap field in every gap object in this file: `searchQuery: 'CDCP1 resistance'` -> `concept: 'resistance'`; the two `searchQuery: 'kw'` -> `concept: 'kw'`; and the assessCompleteness reply fixture `searchQuery: 'CDCP1 clinical trial'` -> `concept: 'trials'` (already covered by item 1).
4. Add `import { buildSearchQuery } from './searchQuery.js';` at the top, and append this new test inside the file (its own `describe`) to pin the broad query:

```ts
describe('fillGap query', () => {
  it('searches the broad target AND concept query', async () => {
    const recordedQueries: string[] = [];
    const search: Tool = { name: 'europepmc_search', description: '', async call(args: Record<string, unknown>) { recordedQueries.push(String(args['query'] ?? '')); return [] as never; } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return [] as never; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'How does resistance arise?', concept: 'resistance', reason: 'gap' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(), specialistModel, verifierModel, emit: () => {},
    });
    expect(recordedQueries[0]).toBe(buildSearchQuery('CDCP1', 'resistance')); // 'CDCP1 AND resistance'
  });
});
```

In `packages/core/src/runDeepResearch.test.ts`:

5. Lines ~32, ~73, ~104 (specialistModel plan replies): `searchQuery: 'kw'` -> `concept: 'kw'` (3 occurrences).

In `packages/core/src/produceResearchSection.test.ts`:

6. The `specialistReplies` plan reply uses the old bare-string shape `{ questions: ['What is the MOA?'] }`. This now throws because `runResearcher` reads `item.concept` and `buildSearchQuery` calls `.trim()` on it. Replace it with a proper question object carrying a concept:

```ts
      { questions: [{ question: 'What is the MOA?', concept: 'mechanism' }] },
```

(Leave the other two replies - claims, reflect - unchanged. The search hit title is `'CDCP1'`, so the deep-read still fires; the assertions on `section.sources`/`section.rag` are unaffected.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- "completeness|runDeepResearch|produceResearchSection"`
Expected: FAIL - `ResearchGap.concept` does not exist; `fillGap` does not accept `target`; the gap-filler search is not `CDCP1 AND resistance`; `produceResearchSection` throws on the bare-string question.

- [ ] **Step 3: Update completeness.ts**

In `packages/core/src/completeness.ts`:

1. Add the import (after the relevance import, line ~11):

```ts
import { buildSearchQuery } from './searchQuery.js';
```

2. Change `ResearchGap` (line ~13):

```ts
export interface ResearchGap { specialistId: string; question: string; concept: string; reason: string }
```

3. Change `CompletenessSchema` gaps (line ~15-22) - rename `searchQuery` to `concept`:

```ts
const CompletenessSchema = z.object({
  complete: z.boolean(),
  gaps: z.array(z.object({
    specialistId: z.string().min(1),
    question: z.string().min(1),
    concept: z.string().min(1),
    reason: z.string().min(1),
  })).max(5),
});
```

4. Replace the `assessCompleteness` system prompt's gap instruction (line ~30) - change `a 3-8 keyword searchQuery (no sentences, no punctuation)` to a concept:

```ts
    system: `You are the lead reviewer of a target-assessment dossier. Judge whether the assessment is complete enough for an expert reader. A red or thin section, or an obvious unanswered question (e.g. resistance mechanisms, safety, a missing modality), is a gap. For each gap, name the existing section id it belongs to, a precise follow-up question, a single concept (ONE short topic facet of 1-2 words, no sentence, and do NOT include the target gene symbol - it is added automatically), and the reason. If the dossier is sufficient, set complete=true with no gaps.`,
```

5. Add `target: string;` to the `fillGap` options type (line ~43) and destructure it (line ~48):

```ts
export async function fillGap(opts: {
  gap: ResearchGap; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<Claim[]> {
  const { gap, target, tools, store, specialistModel, verifierModel, emit } = opts;
```

6. Replace the gap-filler search assembly (line ~54-56). Compute the broad query once:

```ts
  const terms = targetTerms(store);
  const query = buildSearchQuery(target, gap.concept);
  emit({ type: 'tool_call', tool: search.name, args: { query } });
  const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
```

- [ ] **Step 4: Update runDeepResearch.ts**

In `packages/core/src/runDeepResearch.ts` line ~58, pass `target` to `fillGap`:

```ts
        const claims = await fillGap({ gap, target, tools: literatureTools, store, specialistModel, verifierModel, emit });
```

(`target` is already destructured from `opts` at the top of `runDeepResearch`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- "completeness|runDeepResearch|produceResearchSection"`
Expected: PASS - completeness, runDeepResearch, and produceResearchSection cases green.

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter @sonny/core test`
Expected: PASS - all core tests green (no stray `searchQuery` references remain). If any test still references `searchQuery`, rename it to `concept` per the same pattern.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/runDeepResearch.ts packages/core/src/completeness.test.ts packages/core/src/runDeepResearch.test.ts packages/core/src/produceResearchSection.test.ts
git commit -m "feat(core): gap-filler emits concept and searches target AND concept"
```

---

### Task 4: Pin the target to the TITLE_ABS field

**Files:**
- Modify: `packages/core/src/searchQuery.ts`
- Test: `packages/core/src/searchQuery.test.ts`

**Why:** Discovered in the local smoke. Europe PMC matches `query=` across full text and the tool sorts by `CITED desc`, so a bare `CDCP1 AND signaling` returns 1223 hits whose top 8 are famous reviews that only cite a CDCP1 paper - none has CDCP1 in title/abstract, so the relevance gate drops all 8 and the loop sees 0 records. Pinning the target to Europe PMC's `TITLE_ABS:` field returns papers actually about the target (`TITLE_ABS:CDCP1 AND signaling` -> 199 hits, top 8 all CDCP1-centric). The concept stays free text.

**Interfaces:**
- `buildSearchQuery(target, concept)` keeps its signature; its output changes from `<target> AND <concept>` to `TITLE_ABS:<target> AND <concept>` (and `TITLE_ABS:<target>` when the concept is empty). The two consumer tests (`researcher.test.ts`, `completeness.test.ts`) assert against `buildSearchQuery(...)` directly, so they update automatically - do not edit them.

- [ ] **Step 1: Update the failing unit tests**

In `packages/core/src/searchQuery.test.ts`, update the expected strings to the field-pinned form:

```ts
describe('buildSearchQuery', () => {
  it('pins the target to TITLE_ABS and joins a single-word concept with AND', () => {
    expect(buildSearchQuery('CDCP1', 'ADC')).toBe('TITLE_ABS:CDCP1 AND ADC');
  });

  it('phrase-quotes a multi-word concept so it is not AND-split', () => {
    expect(buildSearchQuery('CDCP1', 'cell therapy')).toBe('TITLE_ABS:CDCP1 AND "cell therapy"');
  });

  it('returns the field-pinned target alone when the concept is empty or whitespace', () => {
    expect(buildSearchQuery('CDCP1', '')).toBe('TITLE_ABS:CDCP1');
    expect(buildSearchQuery('CDCP1', '   ')).toBe('TITLE_ABS:CDCP1');
  });

  it('trims surrounding whitespace from the concept', () => {
    expect(buildSearchQuery('CDCP1', '  oncology  ')).toBe('TITLE_ABS:CDCP1 AND oncology');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- searchQuery`
Expected: FAIL - output is `CDCP1 AND ADC`, expected `TITLE_ABS:CDCP1 AND ADC`.

- [ ] **Step 3: Field-pin the target in the helper**

Replace `packages/core/src/searchQuery.ts` with:

```ts
// Assemble a broad two-term Europe PMC query: the target plus one concept facet.
// The target is pinned to the TITLE_ABS field so Europe PMC returns papers where the
// target is a subject (in title or abstract), not papers that merely cite it in full
// text. The concept stays free text and is phrase-quoted when multi-word.
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  const pinned = `TITLE_ABS:${target}`;
  if (!c) return pinned;
  return /\s/.test(c) ? `${pinned} AND "${c}"` : `${pinned} AND ${c}`;
}
```

- [ ] **Step 4: Run the helper tests, then the full core suite**

Run: `pnpm --filter @sonny/core test -- searchQuery`
Expected: PASS - all 4 cases green.

Run: `pnpm --filter @sonny/core test`
Expected: PASS - full core suite green. The `researcher.test.ts` and `completeness.test.ts` query assertions compare against `buildSearchQuery(...)` directly, so they track the new output with no edits.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/searchQuery.ts packages/core/src/searchQuery.test.ts
git commit -m "feat(core): pin target to TITLE_ABS so broad queries return on-target papers"
```

---

## Notes for the controller

- After all tasks, run `pnpm -r test` before the whole-branch review (the CLI/web packages do not reference `searchQuery`, but confirm).
- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) is the acceptance check: most `europepmc_search` calls should now return hits instead of 0, and sections should carry real literature claims. Validation, not a task.
- Out of scope, do not let it leak in: reference snowball (next slice), `fillGap` deep-read title/passage gating, and the confidence clamp.
