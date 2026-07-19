# Spec: Sonny Analysis Toolbox (sandboxed Python data analysis)

Date: 2026-07-16
Status: approved (survived 5 rounds of Codex adversarial review)
Author: Quan (with Claude)
Related: [[project_sonny_analysis_toolbox]], docs/SONNY_ARCHITECTURE_REVIEW.md, biomni review (~/code/biomni), review log alongside this file

## 1. One-line goal

Give Sonny a hardened, sandboxed Python analysis arm that runs reviewed analytical methods over frozen, content-addressed biology datasets (DepMap, GTEx, tumor expression) and turns the results into reproducibly re-executed, grounded dossier sections, without weakening the grounding core.

## 2. Why (interview + product)

The AstraZeneca Oncology Bioscience panel asked for 1-2 study cases that answer biological questions with AI workflows.
Today Sonny grounds claims in retrieved literature; it cannot compute an answer from primary data.
Biomni runs arbitrary model-authored code with full privileges and trusts the output.
Sonny's differentiator: run reviewed analysis sandboxed, and treat every computed number as evidence that is re-executed reproducibly from a content-addressed dataset + exact code.
Computation becomes a new, stronger form of grounding.

## 3. Two-phase framing (scope discipline)

Phase 1 (this spec, for the interview): AI-planned execution of reviewed analytical methods. The reviewed template holds all analysis code, thresholds, tissue sets, exclusion rules, and statistical tests. The model selects only the target gene and a bounded analysis question; it does not author code and does not pick thresholds. Honest description: "Sonny plans and runs reviewed, sandboxed analyses," not "Sonny writes Python."
Phase 2 (post-interview, deferred): model-authored execute/observe codegen (Biomni-style). Deterministic rerun alone does not make arbitrary code trustworthy (a fabricated `print` reruns identically), so Phase 2 additionally requires an independent trust mechanism: reference implementations, a restricted analysis DSL, or human review. Named here only so the architecture leaves room for it.

## 4. Success criteria (verifiable)

Done when all are observably true:

1. `sonny analyze TACSTD2` produces a "Data analysis" dossier section (CLI) with at least one figure generated inside the Docker sandbox from content-addressed local dataset files.
2. The section carries >=3 grounded claims. Each claim carries a structured binding `{ computationId, resultKey, assertedValue, assertedUnit }` validated against a schema-checked `results.json` (never free-form stdout, never numeric-token parsing from prose).
3. A first-class `computation` evidence variant exists in `packages/shared` as a discriminated union branch requiring every provenance + result field; it round-trips through Briefing serialization and CLI.
4. All analysis runs only in the hardened Docker sandbox. Live runs execute the reviewed template TWICE over the same content-addressed inputs and compare typed outputs within declared tolerances (reproducibility gate; correctness comes from template review + golden fixtures); mismatch drops the claim. Docker unavailable = fail closed or signed cached replay; NEVER unsandboxed.
5. A network-blocked test (IPv4/IPv6/DNS from analysis code) passes in a protected `test:docker` job; that job's absence or skip fails the release gate (ordinary `pnpm -r test` stays runnable without Docker).
6. Missing/unreadable dataset or failed/mismatched run degrades to an honest RED/abstain section, never a crash. Zero orphan containers (verified). Validated artifacts are persisted to a content-addressed host run directory BEFORE the container is removed.
7. `pnpm -r build && pnpm -r test` stays green; new code has sibling tests; a mandatory computation-grounding eval metric + an adversarial fabricated-output fixture are in the eval harness.
8. The TROP2 / TACSTD2 case renders end to end on the Ollama backend via the CLI.

Not in the one-week criteria: LUMINA rendering (separate repo, named follow-on), Phase-2 codegen, BD/market/clinical/FTO diligence (Layer 3, roadmap slide).

## 5. Architecture

TypeScript ESM monorepo; Python is a hardened Docker subprocess boundary, threat-modeled as hostile code (not a repo-authored bridge like ANARCI).

### 5.1 Data lake (content-addressed, lineage-first)

`packages/mcp-gateway/src/dataLake/` with `datasets.json`. Each dataset carries a lineage manifest: `{ id, source, sourceIds, acquisitionQuery, retrievedAt, rawSourceHashes, preprocessingCodeHash, preprocessingImageDigest, preprocessingParams, outputSha256, license, localPath }`.
Datasets for v1 (frozen snapshots, licenses reviewed in Slice 1):
- `depmap.crispr_gene_effect` - DepMap CRISPR (Chronos) gene effect + release-matched model/lineage metadata.
- `gtex.median_tpm` - GTEx median gene TPM per tissue.
- `expr.tumor` - tumor expression via cBioPortal REST, pre-fetched (study id + molecular-profile id + pull date).
Dataset identity = content SHA-256 + acquisition query + retrievedAt + full lineage manifest hash, not a semantic version label.
Demo machine pre-fetches; no live network at demo time.

### 5.2 Hardened Docker executor

`packages/mcp-gateway/src/pythonSandbox.ts`, `runAnalysisTemplate({ templateId, params, datasetIds, timeoutMs })`.
- Template code is byte-identical and lives in a host-side registry; params are strictly Zod-validated JSON passed via a read-only file (never interpolated into source, paths, Docker args, or a shell). `spawn(..., { shell: false })`. Unknown fields rejected.
- Rootless Docker; image pinned by digest (`sonny-analysis@sha256:...`) built from digest-pinned `python:3.11-slim` + digest-locked wheels (pandas, numpy, scipy, biopython, matplotlib, pyarrow). No runtime pip. Image digest recorded per computation.
- `--read-only` root filesystem, `--network none` (blocks IPv4/IPv6/DNS), `--cap-drop=ALL`, `--security-opt no-new-privileges`, pinned seccomp profile, `--ipc=none`, `--pids-limit`, `--memory`, `--cpus`, `--user <numeric-uid>` no supplementary groups.
- Image is either registry-pushed OCI pulled by `name@sha256:...`, or a reproducible local build whose inspected image ID is verified against the expected value and used directly. Digest/ID recorded per computation.
- Code mounted read-only. Only exact allowlisted dataset files (resolved on host from datasetIds) mounted read-only at fixed paths - never the whole lake.
- One writable surface only: a per-run, freshly-created, non-reused `0700` output dir under a trusted canonical parent (reject symlinked parents), on a quota-backed/size-capped filesystem, bind-mounted `nodev,nosuid,noexec` (persists after container removal); `/tmp` is a bounded tmpfs for scratch. A disk-flood integration test asserts the output cap holds. After exit, validated files (lstat + realpath-containment + magic-byte + size + hash; bounded regular PNG/JSON only) are atomically promoted to a content-addressed host run dir; unpromoted output is deleted on every exit path; THEN the container is killed/removed via cidfile in `finally`.
- Caps on stdout, stderr, artifact count, total output bytes, fds, file size, wall time. Retention/cleanup policy for run dirs defined.
Returns `{ resultsJson, artifacts, exitCode, timedOut, imageDigest, codeBytes, codeHash, datasetHashes, params, seed }`.

### 5.3 Analysis specialist (agent seam)

`packages/core` specialist mirroring existing deep-research specialists.
- Selects a reviewed `templateId` + the bounded params it is allowed to set (target gene, analysis question). Thresholds/tissue-sets/tests come from the template, not the model.
- Calls `runAnalysisTemplate`, maps typed `results.json` keys into Claims with structured computed bindings. No raw stdout reaches a model.
- Grounding gate: a claim without a valid computation evidence record does not ship. Abstains (RED) on missing data or failed/mismatched run.

### 5.4 Schema + rendering

- `packages/shared`: `EvidenceSchema` becomes a backward-compatible discriminated union; the `computation` branch REQUIRES computationId, dataset content hashes, imageDigest, codeHash, params, seed, exit status, resultKeys, and `results.json` hash. A discriminated analysis `Section` variant extends (not bypasses) the existing `Section[]` pipeline. `ClaimSchema` gains structured computed bindings `{ computationId, resultKey, assertedValue, assertedUnit }`.
- `computationId = sha256(JCS(canonicalComputationManifest))` with a versioned manifest, an enumerated field set, and cross-package golden hash vectors.
- `results.json` schema (versioned, bounded): scalar and grouped-series result types with numeric `value`, `unit`, `comparator`, `threshold`, `direction`, `precision`/`tolerance`, `missingness`, `sampleN`, and explicit nullable fields.
- CLI renders text summary + figure paths + provenance. LUMINA inline rendering is a named follow-on PR in the LUMINA repo.
- Provenance survives `assembleReferences` (extended) through Briefing/CLI/UI, not a parallel path.

### 5.5 Verification (ordered, separate states)

Each claim tracks separate fields: `executionMode` (`live` | `cached`), `replayVerification` (`verified` = live double-run matched within tolerance | `not_run` = cached), `originVerification` (`verified` = signed manifest checked | `none`), `llmVerdict`, `verifierDecorrelated`. Reproducibility and model-decorrelation are orthogonal and never conflated.
1. Reproducibility gate (first): re-execute the template over the same content-addressed inputs and compare typed outputs within declared tolerances; failure ALWAYS drops the claim. This catches nondeterminism, not mathematical/preprocessing bugs - CORRECTNESS is supported separately by reviewed-template reviews + golden fixtures, not by the re-run. The spec does not claim "independent" verification of correctness.
2. Decorrelated LLM verifier (second, different model family): judges only semantic overreach on surviving claims; `verifierDecorrelated` is explicit and independent of `replayVerification`.
RAG: introduce a source-identity resolver that resolves independence to a logical dataset-release group (not each underlying file hash - DepMap matrix + release-matched metadata are one source) for computations and to the parent publication for literature passages, passed explicitly into `computeRag`.
Cached fallback trust: release signing is permitted ONLY after the protected Docker reproducibility gate passes; the signed manifest includes `originReplayVerification: verified` + the two compared result hashes. Sign the canonical manifest + every artifact hash with a release key, bundle the public key, verify on load, and display `executionMode: cached`, `originVerification: verified` (signature + origin replay), `replayVerification: not_run`. Whether historically-verified cached claims may ship is an explicit policy flag (default: yes, clearly labeled).

## 6. Grounding contract for computed claims

A computed Claim is grounded iff it carries a `computation` Evidence record with: content-addressed computationId, dataset content SHA-256(s) + acquisition query + retrievedAt + lineage manifest, exact code bytes + codeHash, image digest, normalized params + seed, exit status, and the typed result key(s) + validated `results.json` hash it rests on; AND `replayVerification === verified` (live) or `originVerification === verified` (cached). "No token, no ship" now covers computed values, and the token must be re-executed reproducibly within tolerance (correctness supported by template review + golden fixtures, not the re-run alone).

## 7. Slices (science first, TDD, each a branch+PR)

Slice 0 - runtime preflight (do FIRST; this machine currently has no Docker): install/configure the intended rootless container runtime on the actual demo machine and prove the pinned image builds and runs with `--network none`, read-only rootfs, the allowlisted mounts, and the resource controls. Deliverable: a green preflight script. Discovering runtime incompatibility in Slice 3 would be too late for the one-week demo.
Slice 1 - scientific + license fixture spike: freeze TACSTD2 DepMap/GTEx/tumor snapshots; lock exact analyses, thresholds, tissue sets, exclusion rules, statistical tests, and golden outputs in reviewed templates; confirm the TROP2 signal is usable and the claims are defensible before building infra. Deliverable: golden fixture + scientific-validity note.
Slice 2 - computation contracts + grounding + mandatory eval: discriminated `computation` evidence, `results.json` schema, claim<->result structured bindings, `computationId` canonicalization + golden vectors, reproducibility gate, adversarial fabricated-output fixture, computation-grounding eval metric. The discriminated `Section` union ships in THIS slice with a tested migration assigning existing sections a `research` discriminator, updating every producer and serialized fixture green in the same slice. No executor yet (fixtures).
Slice 3 - hardened Docker executor: `runAnalysisTemplate`, digest-pinned image, hardening flags, injection-safe param passing, allowlisted-file mounts, artifact extraction-before-removal, lifecycle cleanup; protected `test:docker` suite (blocked network, immutable code/data, OOM/fork/timeout, artifact rejection, zero orphans, double-run tolerance).
Slice 4 - template CLI analysis: reviewed TACSTD2 templates, analysis specialist, `sonny analyze`, discriminated analysis section, grounded claims end to end on Ollama.
Slice 5 - rendering + E2E + backup: CLI rendering polish, signed precomputed fallback artifact, deployment bundle + packaged-install smoke test (image builds, assets resolve from dist). LUMINA rendering tracked separately.

## 8. TROP2 flagship case (scientifically bounded)

Target: TROP2, gene TACSTD2. Validated ADC target (Trodelvy, Dato-DXd).
Computed claims bounded to what the data supports:
1. Dependency (orthogonal tumor biology, NOT a decisive ADC criterion): DepMap CRISPR gene-effect distribution for TACSTD2 with release-matched lineage metadata; report against template-locked selectivity thresholds + sample counts + missingness, framed as biology context.
2. Tumor expression signal: TACSTD2 tumor signal from the frozen cBioPortal slice. No cross-source quantitative tumor-vs-normal claim unless a jointly-processed compendium is used; otherwise report tumor and normal signals separately.
3. Normal-tissue transcript signal (screening flag only): GTEx median TPM for TACSTD2 across normal tissues. Claim phrased as "flags potential normal-tissue exposure risk requiring protein-level and clinical confirmation." Epithelial localization, surface protein, and toxicity are NOT claimed from GTEx bulk; grounded separately in literature/protein evidence if asserted.
Modality/linker conclusions (cleavable-linker ADC vs naked antibody) require internalization/pharmacology/clinical evidence, grounded in literature, not computed from expression.
Backup: a single signed, precomputed CDCP1 analysis artifact (not a second live pipeline).

## 9. Interview framing

- Live demo = Phase-1 reviewed-method execution on TACSTD2 via CLI: biology question -> AI-planned, sandboxed, reproducibly re-executed analysis -> grounded, bounded claims.
- Contrast slide: same execution power as Biomni, but sandboxed (hardened Docker, network off), reviewed, and grounded (content-addressed dataset + code, re-executed reproducibly), wrapped in verification/abstention. Phase-1 is honestly "AI-planned execution of reviewed methods"; model-authored codegen is the Phase-2 roadmap.
- Roadmap slide: Phase 2 model-authored codegen (with an independent trust mechanism) + Layer 3 commercial diligence (market, clinical landscape, competitive, patent FTO).

## 10. Risks

- Docker absent/misconfigured on demo machine -> pre-verify rootless Docker on the actual machine; fail-closed + signed cached fallback ready.
- Dataset licensing (DepMap/GTEx/cBioPortal redistribution) -> reviewed in Slice 1 before shipping any file.
- Scientific overreach in front of experts -> claims bounded per section 8; deterministic gate + decorrelated verifier catch drift.
- Scope creep toward a full Biomni environment -> hold at 3 datasets, reviewed templates only, one flagship case, CLI surface.

## 11. Decisions

- Tumor expression source: cBioPortal REST pre-fetched to the lake; provenance = study id + molecular-profile id + pull date + content SHA-256.
- v1 = AI-planned execution of reviewed templates (locked thresholds/tests); no model-authored code, no model-selected thresholds (Phase 2 only).
- Docker-only execution; no unsandboxed fallback; live runs double-execute and compare within tolerance.
- LUMINA rendering out of one-week acceptance; CLI is the primary demo surface.
