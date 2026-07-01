# EPO OPS Patent-Lookup Module Design (Patent Specialist - Slice 3)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 3 of 6.
**Date:** 2026-07-01.

## Purpose

Given a patent number, return an authoritative structured `PatentRecord` from EPO Open Patent Services (OPS): identity/bibliographic data, applicant/assignee, the INPADOC patent family across jurisdictions, and a pragmatic per-member legal status.

This turns a sequence match into a freedom-to-operate / ownership signal: who holds the IP, and whether it looks live where it matters.

## Architecture

A typed function `lookupPatent(input, deps) => Promise<PatentRecord>` in `packages/mcp-gateway/src/epoPatent.ts`.
NOT a fetch-based `Tool` returning `Evidence[]`: its output is one rich structured record the slice-5 orchestrator reconciles, not an LLM-driven search (consistent with `confirmRegions`).
Takes an injectable `fetchImpl` (like `blast_verify`) so unit tests mock the OAuth and data endpoints with no live network.

## Flow

1. **Normalize** the patent number to EPO epodoc form.
2. **Authenticate** via OAuth2 client-credentials; cache the token in memory with a clock-skew safety buffer.
3. **Fetch + parse** three OPS endpoints with the bearer token: biblio, family, legal.
4. **Interpret** legal status pragmatically and assemble the `PatentRecord`.

## Resilience: soft infra degradation

A brittle pipeline is a dead pipeline.
`lookupPatent` NEVER throws.
Every failure mode returns `{ found: false, error: "<CODE>: <reason>" }` with a conspicuous prefixed code, so a live research run keeps the BLAST and ANARCI analysis even when EPO is misconfigured or down.

Error codes:
- `EPO_CONFIG_MISSING` - `SONNY_EPO_KEY` or `SONNY_EPO_SECRET` not set.
- `EPO_AUTH_FAILED` - credentials rejected (401 from the token endpoint or a data endpoint).
- `EPO_NOT_FOUND` - the patent number did not resolve (404).
- `EPO_NETWORK_ERROR` - network failure, 5xx, or a structurally unparseable response (for example an HTML error page).
- `EPO_NORMALIZE_FAILED` - the input could not be parsed into a patent number.

The conspicuous error string is the tool's responsibility.
Emitting a stderr warning when a lookup is degraded is the slice-5 orchestrator's responsibility (so operators watching logs see the degraded state); noted here, implemented there.

## Number normalization

`normalizePatentNumber(input) => NormalizedNumber | null`.

Handles common copy-paste artifacts from patent PDFs:
- interior spaces and commas: `US 10,123,456 B2` -> `US10123456`.
- country-code casing: `us10123456b2` -> `US10123456`.
- an optional trailing kind code (`A1`, `B2`, `A`, etc.), stripped for the epodoc lookup form but retained in `NormalizedNumber.kind`.

`NormalizedNumber = { country: string; number: string; kind?: string; epodoc: string }` where `epodoc` is `country + number` (the OPS lookup key).
Returns `null` when the input has no recognizable country + number; `lookupPatent` maps `null` to `{ found: false, error: "EPO_NORMALIZE_FAILED: ..." }`.

Supported inputs: US, EP, WO and other 2-letter country prefixes followed by digits and an optional kind code.

## OAuth2 token lifecycle

- POST `https://ops.epo.org/3.2/auth/accesstoken`, `Authorization: Basic base64(key:secret)`, body `grant_type=client_credentials`.
- Response `{ access_token, expires_in }`.
- **Clock-skew mitigation:** store the local expiry as `now + (expires_in - 300) seconds` (a 5-minute safety buffer) so a token cannot expire mid-flight during the subsequent multi-endpoint fetches.
- Cache the token in a module-level variable; reuse while unexpired.
- On a `401` from a data endpoint, discard the cached token, re-authenticate once, and retry the request; a second `401` yields `EPO_AUTH_FAILED`.

## Endpoints (OPS 3.2)

Base: `https://ops.epo.org/3.2/rest-services`. `Accept: application/json`, bearer token.

- Biblio: `GET /published-data/publication/epodoc/{epodoc}/biblio`.
- Family: `GET /family/publication/epodoc/{epodoc}`.
- Legal: `GET /legal/publication/epodoc/{epodoc}`.

The exact JSON nesting is smoke-validated (see Setup); unit tests pin parsing behavior via fixtures.

## Defensive parsing

OPS payloads are deeply nested and variable: a field that is a single object for one applicant becomes an array of objects for several.
All parsing uses optional chaining plus a normalization helper that coerces a value to an array (`x == null ? [] : Array.isArray(x) ? x : [x]`) before mapping, so an unexpected object-vs-array shape never throws.
Missing fields yield empty arrays or undefined, not errors.

## Pragmatic legal-status interpretation

- `LEGAL_CODE_MAP: Record<string, { category: string; effect: 'active' | 'inactive' | 'neutral' }>` maps curated high-signal INPADOC event codes to a category and a directional effect (for example a grant is `active`, a lapse / non-payment / withdrawal is `inactive`, an address change is `neutral`).
- Unmapped codes pass through raw (code + description) with `category` undefined and `effect` `neutral`; nothing is silently dropped.
- **Coarse per-member status:** scan a member's events in date order; the status is `inactive` if the latest directional (non-neutral) event is `inactive`, `active` if it is `active`, and `unknown` when there is no directional event.
- **Estimated expiry:** earliest filing/priority date + 20 years, on the record as `estimatedExpiry` with `expiryEstimated: true` ALWAYS set when present. Patent-term adjustments (PTA), SPCs, and terminal disclaimers are out of scope and can shift the real date; the flag makes the estimate explicit.

The map is illustrative and extensible; its exact code set is refined against real OPS legal data during the smoke.

## Output

```ts
interface LegalEvent {
  code: string;
  category?: string;
  effect: 'active' | 'inactive' | 'neutral';
  date?: string;
  description?: string;
}

interface FamilyMember {
  country: string;
  number: string;
  kind?: string;
  status: 'active' | 'inactive' | 'unknown';
  events: LegalEvent[];
}

interface PatentRecord {
  input: string;
  normalized?: string;            // epodoc form; absent when normalization failed
  found: boolean;
  title?: string;
  applicants: string[];           // assignees / applicants
  inventors: string[];
  ipc: string[];                  // classification symbols
  publicationDate?: string;
  family: FamilyMember[];
  estimatedExpiry?: string;
  expiryEstimated?: true;         // always true when estimatedExpiry is present
  error?: string;                 // "<CODE>: <reason>" when found is false
}
```

When `found` is `false`, `applicants`, `inventors`, `ipc`, and `family` are empty arrays and `error` is set.

## Configuration

`SONNY_EPO_KEY` and `SONNY_EPO_SECRET` (one free EPO OPS registration).
Optional `SONNY_EPO_BASE` to override the base URL (defaults to `https://ops.epo.org/3.2`).

## Decomposition (3 TDD tasks)

1. **Pure logic:** `normalizePatentNumber`, `LEGAL_CODE_MAP`, coarse-status derivation, expiry estimate. No network.
2. **OAuth:** token acquisition, in-memory caching with the 5-minute buffer, and 401 refresh. Injectable fetch.
3. **`lookupPatent` assembly:** biblio + family + legal fetch and defensive parse into `PatentRecord`; export from the gateway index.

## Testing

All tests inject `fetchImpl`; no live network.

- Normalization: `US 10,123,456 B2`, `us10123456b2`, `EP1234567A1`, `WO2020123456A1` all map to the correct epodoc form and retain the kind; an unrecognizable string returns `null`.
- Expiry: an `estimatedExpiry` is filing/priority + 20 years and always carries `expiryEstimated: true`.
- Token: a first call fetches and caches; a second call within the buffer reuses without a new token request; the stored expiry reflects the 5-minute buffer.
- 401 refresh: a data-endpoint 401 triggers exactly one re-auth and retry; a second 401 yields `EPO_AUTH_FAILED`.
- Biblio parse: applicants (single object AND array-of-objects shapes both parse), title, IPC, publication date.
- Family parse: multiple INPADOC members across countries.
- Legal parse: events mapped to categories/effects; an unmapped code passes through raw with `effect: 'neutral'`.
- Coarse status: granted-then-lapsed -> `inactive`; granted-with-no-later-lapse -> `active`; no directional event -> `unknown`.
- Soft degradation: missing creds -> `found: false, error: "EPO_CONFIG_MISSING: ..."`; 404 -> `EPO_NOT_FOUND`; network throw / 5xx / non-JSON body -> `EPO_NETWORK_ERROR`; unparseable number -> `EPO_NORMALIZE_FAILED`. None throw.

## Setup

Register for a free EPO OPS account, set `SONNY_EPO_KEY` / `SONNY_EPO_SECRET`.
A manual smoke (not a unit test) against a known patent validates the OPS JSON nesting and refines `LEGAL_CODE_MAP` against real legal data; the TypeScript contract stays fixed.

## Out of scope

- Claims / full-text retrieval (added in slice 4 when reconciliation needs it).
- Definitive enforceability determination and full term-adjustment math (PTA/SPC/terminal disclaimers).
- Freedom-to-operate legal opinions.
- An LLM-callable tool wrapper (slice-5 decision).
