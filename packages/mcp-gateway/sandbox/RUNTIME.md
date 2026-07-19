# Sonny analysis sandbox runtime

The analysis image is Docker-only and fails closed. It must never be replaced by
an unsandboxed host Python process.

## macOS setup

Install the supported rootless Colima VM and Docker client, then start Colima:

```sh
brew install colima docker && colima start
```

The preflight also accepts an already-running Docker daemon or nerdctl daemon.
When the clients are installed but no daemon is active, it prints the command
above and exits `3`. It never starts or installs host software itself.

From the repository root, run:

```sh
./scripts/analysis-preflight.sh
```

The script builds the digest-pinned `sonny-analysis:preflight` image, captures
its inspected image ID, and uses that immutable ID for every probe. The image
uses hash-locked CPython 3.11 wheels and removes pip, setuptools, wheel, and
`ensurepip` before runtime. Each container uses the pinned `seccomp.json`
allowlist in this directory.

`seccomp.json` is a repository-pinned, default-deny profile derived from Moby's
tagged `seccomp/v0.2.1` profile and reduced to Linux `amd64`/`arm64`. It omits
mount, namespace creation, kernel module, BPF, perf, and ptrace syscalls; normal
`clone` is masked to reject namespace flags and `clone3` returns `ENOSYS` for a
safe glibc fallback.

## Assertions

- **Network isolation:** DNS resolution plus direct IPv4 and IPv6 connections
  all fail under `--network none`.
- **Immutable root filesystem:** a write to an image directory owned by the
  analysis UID fails specifically with `EROFS` under `--read-only`.
- **Explicit writable surfaces:** the bounded `/tmp` tmpfs works, and a
  deliberately mounted host output directory receives a persisted file.
- **Allowlisted input:** one exact data directory is readable through a
  read-only bind mount, is reported read-only by mount metadata, and rejects a
  write.
- **Process hardening:** the process runs as numeric UID/GID `65532:65532`, has
  no unexpected supplementary groups or effective capabilities, has
  `no-new-privileges` and seccomp filtering active, and observes bounded PID,
  memory, and CPU cgroups.
- **PID enforcement:** a bounded process-spawn loop reaches the 32-PID cgroup
  limit, then terminates and reaps every child it created.
- **Memory enforcement:** a bounded 512 MiB allocation in a container limited
  to 128 MiB is OOM-killed with exit status 137.
- **Lifecycle cleanup:** every probe uses `--rm` and a cidfile; after the probes,
  every recorded container ID must be absent. The exit trap force-removes any
  leaked recorded container as cleanup, without converting the assertion to a
  pass.

The preflight's disposable host state parent is mode `0700`. Its output leaf is
temporarily mode `0777` only so fixed container UID `65532` can cross macOS VM
file sharing; the private parent prevents other host users from traversing it.
Slice 3 must still implement the spec's chowned, non-reused `0700` production
output directory, quota, validation, and atomic content-addressed promotion.

The preflight exits `0` only when all assertions pass, `1` for a build or
isolation failure, and `3` when no usable runtime is installed. A failed or
skipped Docker preflight must fail the protected release gate.

## Docker-unavailable fallback

Docker unavailability never authorizes local Python execution. The only
permitted fallback is a signed, precomputed artifact produced after the
protected Docker reproducibility gate successfully double-ran the exact
reviewed template over the same content-addressed inputs.

The cached bundle must include the canonical manifest, both compared result
hashes, every artifact hash, `originReplayVerification: verified`, and a release
signature over the manifest and artifact hashes. Loaders verify that signature
with the bundled release public key before exposing any claim. Cached claims are
shown as `executionMode: cached`, `originVerification: verified`, and
`replayVerification: not_run`; unsigned, altered, or historically unverified
bundles abstain/RED. Shipping historically verified cached claims remains an
explicit policy decision (default permitted and clearly labeled), as specified
in section 5.5 of the approved analysis-toolbox spec.
