# Signed analysis cache operations

The cached analysis path is a demo safety net, not an unsandboxed executor. Sonny
creates a bundle only from a live analysis whose protected Docker double-run passed
the reproducibility and grounding gates. A bundle contains the canonical computation
manifest, both compared canonical result hashes, computation evidence, the bounded
analysis section, and the bytes and SHA-256 hash of every validated artifact.

The payload is signed with Ed25519. Loading checks the signature against the public
key compiled into `packages/core/src/releasePublicKey.ts`, verifies all artifact and
result hashes, re-runs cached computation grounding, and only then materializes the
artifacts. Reconstructed claims are always labeled:

- `executionMode: cached`
- `originVerification: verified`
- `replayVerification: not_run`

Historically verified cached claims are allowed by default. Set
`SONNY_ALLOW_HISTORICALLY_VERIFIED_CACHE=false` to disable them and fail closed.

## Generate a bundle from a real protected run

Configure the pinned analysis image and working Ollama backend as for the live demo,
then provide the release private key and output path:

```sh
mkdir -p .sonny/analysis-cache
export SONNY_ANALYSIS_IMAGE='sonny-analysis@sha256:<64-hex-digest>'
export SONNY_ANALYSIS_SIGNING_KEY_PATH='/secure/out-of-band/analysis-release-private-key.pem'
export SONNY_ANALYSIS_CACHE_OUT="$PWD/.sonny/analysis-cache/TACSTD2.cached-run.json"
pnpm --filter @sonny/cli start analyze TACSTD2
```

The command runs Docker twice, applies the reproducibility gate, renders the live
section, then writes the signed bundle. It refuses to sign abstentions, cached runs,
unverified claims, changed artifacts, or a private key that does not match the
compiled public key.

The repository contains a development-only private key at
`packages/core/src/fixtures/dev-release-private-key.pem` for local testing. It is not
included in package `dist`. A real release must replace the compiled development
public key during the release build and supply its matching private key out-of-band;
the release private key must never be committed or packaged.

## Verify the Docker-unavailable fallback

Keep the generated bundle at the default path above. Point Docker at a deliberately
absent local socket for this command only:

```sh
unset SONNY_ANALYSIS_CACHE_OUT SONNY_ANALYSIS_SIGNING_KEY_PATH
export SONNY_ANALYSIS_CACHE_DIR="$PWD/.sonny/analysis-cache"
DOCKER_HOST=unix:///tmp/sonny-intentionally-absent-docker.sock \
  pnpm --filter @sonny/cli start analyze TACSTD2
```

The rendered section must contain `CACHED / ORIGIN VERIFIED`, the notice that no
analysis ran on this machine, and the state lines `cached`, `not_run`, and `verified`.
Changing any byte in the JSON bundle must instead produce a RED abstention saying the
signed fallback was rejected. Data, schema, reproducibility, or other scientific
failures never trigger cached fallback.

## Release checks

Run:

```sh
pnpm -r build
pnpm -r test
pnpm test:docker
```

The ordinary test suite includes a `pnpm pack` smoke test that extracts the packaged
gateway and resolves its Dockerfile, seccomp policy, locked requirements, reviewed
templates/schema, dataset registry, and frozen datasets from `dist`. Release CI must
also run `pnpm test:docker`; the package smoke test does not replace the protected
Docker security suite.
