# Hardened analysis executor

`runAnalysisTemplate` mounts `/output` from a fresh Docker named volume backed by
a quota-bounded tmpfs. The volume is created with `uid=65532,gid=65532,mode=0700`,
so the analysis process remains non-root and can write on both native Linux and
Docker Desktop's Linux VM on macOS. This avoids Docker Desktop's `root:root`
ownership remapping for host bind mounts.

After the stopped container exits, `docker cp` extracts the volume contents to a
private host staging directory. The executor rejects links, path escapes,
unbounded files, invalid PNG/JSON magic, undeclared figures, and schema-invalid
`results.json`; hashes accepted files; and atomically promotes them to a
content-addressed run directory. Only then does `finally` remove the cidfile
container and named volume.

The ordinary test task excludes the real-Docker suite. Protected CI is mandatory
for release and must build `sonny-analysis:preflight`, then run:

```sh
pnpm test:docker
```

The suite skips cleanly when Docker is unavailable so developer unit tests remain
portable. A skipped protected job must not satisfy the release gate. Pending run
directories and volumes are removed on every exit path. Validated content-addressed
run directories are retained indefinitely in v1; evidence lifecycle tooling must
explicitly garbage-collect only run hashes that are no longer referenced.
