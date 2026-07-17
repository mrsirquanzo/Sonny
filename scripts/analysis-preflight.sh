#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)
SANDBOX_DIR=$REPO_ROOT/packages/mcp-gateway/sandbox
SECCOMP_PROFILE=$SANDBOX_DIR/seccomp.json
IMAGE_TAG=sonny-analysis:preflight
ANALYSIS_UID=65532
ANALYSIS_GID=65532

RUNTIME=
RUNTIME_DESCRIPTION=
IMAGE_REF=
RUN_SEQUENCE=0
PASS_COUNT=0
FAIL_COUNT=0

# Colima shares the macOS home directory by default, but not every path selected
# by macOS TMPDIR. Keep bind-mount fixtures under the repository's /Users path.
STATE_DIR=$(mktemp -d "$REPO_ROOT/.analysis-preflight.XXXXXX")
chmod 0700 "$STATE_DIR"
CIDFILE_LIST=$STATE_DIR/cidfiles
OUTPUT_DIR=$STATE_DIR/output
DATA_DIR=$STATE_DIR/data
: > "$CIDFILE_LIST"
mkdir "$OUTPUT_DIR" "$DATA_DIR"
chmod 0777 "$OUTPUT_DIR"
printf '%s\n' 'allowlisted fixture' > "$DATA_DIR/fixture.txt"
chmod 0555 "$DATA_DIR"
chmod 0444 "$DATA_DIR/fixture.txt"

print_install_instructions() {
    printf '%s\n' \
        'No usable Docker-compatible container runtime was found.' \
        'Install and start the supported macOS runtime with:' \
        '  brew install colima docker && colima start' \
        'Do not run analysis outside the container sandbox.' \
        '' \
        'Summary: FAIL (container runtime unavailable; exit 3)'
}

detect_runtime() {
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        RUNTIME=docker
        RUNTIME_DESCRIPTION=docker
        return 0
    fi

    if command -v nerdctl >/dev/null 2>&1 && nerdctl info >/dev/null 2>&1; then
        RUNTIME=nerdctl
        RUNTIME_DESCRIPTION=nerdctl
        return 0
    fi

    if command -v colima >/dev/null 2>&1; then
        printf '%s\n' 'Colima is installed but no Docker/nerdctl daemon is usable.' >&2
    fi

    return 3
}

allocate_cidfile() {
    RUN_SEQUENCE=$((RUN_SEQUENCE + 1))
    CURRENT_CIDFILE=$STATE_DIR/container-$RUN_SEQUENCE.cid
    printf '%s\n' "$CURRENT_CIDFILE" >> "$CIDFILE_LIST"
}

remove_recorded_containers() {
    [ -n "$RUNTIME" ] || return 0

    while IFS= read -r cidfile; do
        [ -s "$cidfile" ] || continue
        cid=$(sed -n '1p' "$cidfile")
        [ -n "$cid" ] || continue
        "$RUNTIME" rm -f "$cid" >/dev/null 2>&1 || true
    done < "$CIDFILE_LIST"
}

cleanup() {
    remove_recorded_containers
    chmod 0755 "$DATA_DIR" >/dev/null 2>&1 || true
    rm -rf "$STATE_DIR"
}

trap cleanup 0
trap 'exit 130' HUP INT TERM

run_standard_container() {
    allocate_cidfile || return 1
    "$RUNTIME" run --rm --cidfile "$CURRENT_CIDFILE" \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges=true \
        --security-opt "seccomp=$SECCOMP_PROFILE" \
        --ipc none \
        --pids-limit 64 \
        --memory 256m \
        --memory-swap 256m \
        --cpus 1 \
        --user "$ANALYSIS_UID:$ANALYSIS_GID" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
        "$IMAGE_REF" "$@"
}

assert_network_blocked() {
    run_standard_container python -c '
import socket

failures = []

try:
    socket.getaddrinfo("example.com", 443)
except OSError:
    pass
else:
    failures.append("DNS lookup unexpectedly succeeded")

for family, address, label in (
    (socket.AF_INET, ("1.1.1.1", 53), "IPv4 connect"),
    (socket.AF_INET6, ("2606:4700:4700::1111", 53, 0, 0), "IPv6 connect"),
):
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
    except OSError:
        continue
    sock.settimeout(1.0)
    try:
        sock.connect(address)
    except OSError:
        pass
    else:
        failures.append(f"{label} unexpectedly succeeded")
    finally:
        sock.close()

if failures:
    raise SystemExit("; ".join(failures))
print("DNS, IPv4, and IPv6 are blocked")
'
}

assert_rootfs_read_only() {
    run_standard_container python -c '
import errno

try:
    with open("/work/rootfs-write-probe", "wb") as handle:
        handle.write(b"violation")
except OSError as exc:
    if exc.errno != errno.EROFS:
        raise SystemExit(f"write failed for the wrong reason: errno={exc.errno}")
else:
    raise SystemExit("read-only root filesystem accepted a write")
print("root filesystem rejected the write with EROFS")
'
}

assert_tmpfs_and_output_mount() {
    allocate_cidfile || return 1
    if ! "$RUNTIME" run --rm --cidfile "$CURRENT_CIDFILE" \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges=true \
        --security-opt "seccomp=$SECCOMP_PROFILE" \
        --ipc none \
        --pids-limit 64 \
        --memory 256m \
        --memory-swap 256m \
        --cpus 1 \
        --user "$ANALYSIS_UID:$ANALYSIS_GID" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
        --mount "type=bind,src=$OUTPUT_DIR,dst=/output" \
        "$IMAGE_REF" python -c '
from pathlib import Path

Path("/tmp/scratch.txt").write_text("tmpfs works\n", encoding="utf-8")
Path("/output/result.txt").write_text("bind works\n", encoding="utf-8")
assert Path("/tmp/scratch.txt").read_text(encoding="utf-8") == "tmpfs works\n"
print("tmpfs and output bind are writable")
'; then
        return 1
    fi

    [ "$(sed -n '1p' "$OUTPUT_DIR/result.txt" 2>/dev/null || true)" = 'bind works' ] || {
        printf '%s\n' 'output bind write was not persisted to the host' >&2
        return 1
    }
}

assert_data_mount_read_only() {
    allocate_cidfile || return 1
    "$RUNTIME" run --rm --cidfile "$CURRENT_CIDFILE" \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges=true \
        --security-opt "seccomp=$SECCOMP_PROFILE" \
        --ipc none \
        --pids-limit 64 \
        --memory 256m \
        --memory-swap 256m \
        --cpus 1 \
        --user "$ANALYSIS_UID:$ANALYSIS_GID" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
        --mount "type=bind,src=$DATA_DIR,dst=/data,readonly" \
        "$IMAGE_REF" python -c '
from pathlib import Path

fixture = Path("/data/fixture.txt")
if fixture.read_text(encoding="utf-8") != "allowlisted fixture\n":
    raise SystemExit("allowlisted data did not read back correctly")

mount_is_read_only = False
for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
    before_separator = line.split(" - ", 1)[0].split()
    if len(before_separator) >= 6 and before_separator[4] == "/data":
        mount_is_read_only = "ro" in before_separator[5].split(",")
        break
if not mount_is_read_only:
    raise SystemExit("/data is not reported as a read-only mount")

try:
    fixture.write_text("violation\n", encoding="utf-8")
except OSError:
    pass
else:
    raise SystemExit("allowlisted data mount accepted a write")
print("allowlisted data is readable and mounted read-only")
'
}

assert_resource_controls() {
    run_standard_container python -c '
import os
from pathlib import Path

EXPECTED_UID = 65532
EXPECTED_GID = 65532
MAX_PIDS = 64
MAX_MEMORY = 256 * 1024 * 1024
MAX_CPUS = 1.0

def read_first(paths):
    for path in paths:
        candidate = Path(path)
        if candidate.exists():
            return candidate.read_text(encoding="utf-8").strip()
    raise SystemExit(f"none of the cgroup control files exist: {paths}")

status = {}
for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
    if ":" in line:
        key, value = line.split(":", 1)
        status[key] = value.strip()

if os.geteuid() != EXPECTED_UID or os.getegid() != EXPECTED_GID:
    raise SystemExit(f"wrong identity: {os.geteuid()}:{os.getegid()}")
unexpected_groups = [group for group in os.getgroups() if group != EXPECTED_GID]
if unexpected_groups:
    raise SystemExit(f"supplementary groups present: {unexpected_groups}")
cap_eff = status.get("CapEff", "-1")
if int(cap_eff, 16) != 0:
    raise SystemExit(f"effective capabilities remain: {cap_eff}")
if status.get("NoNewPrivs") != "1":
    raise SystemExit("no-new-privileges is not active")
seccomp_mode = status.get("Seccomp")
if seccomp_mode != "2":
    raise SystemExit(f"seccomp filtering is not active: {seccomp_mode}")

pids_text = read_first(("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"))
if pids_text == "max" or int(pids_text) > MAX_PIDS:
    raise SystemExit(f"PID limit is not bounded at {MAX_PIDS}: {pids_text}")

memory_text = read_first((
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
))
if memory_text == "max" or int(memory_text) > MAX_MEMORY:
    raise SystemExit(f"memory limit is not bounded at {MAX_MEMORY}: {memory_text}")

cpu_v2 = Path("/sys/fs/cgroup/cpu.max")
if cpu_v2.exists():
    quota_text, period_text = cpu_v2.read_text(encoding="utf-8").split()
    if quota_text == "max":
        raise SystemExit("CPU quota is unlimited")
    cpu_ratio = int(quota_text) / int(period_text)
else:
    quota = int(read_first((
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us",
    )))
    period = int(read_first((
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us",
    )))
    if quota < 0:
        raise SystemExit("CPU quota is unlimited")
    cpu_ratio = quota / period
if cpu_ratio > MAX_CPUS + 0.01:
    raise SystemExit(f"CPU quota exceeds {MAX_CPUS}: {cpu_ratio}")

print(
    f"uid={os.geteuid()} gid={os.getegid()} caps=0 no_new_privs=1 "
    f"seccomp=filter pids={pids_text} memory={memory_text} cpus={cpu_ratio:.2f}"
)
'
}

assert_pid_limit() {
    allocate_cidfile || return 1
    "$RUNTIME" run --rm --cidfile "$CURRENT_CIDFILE" \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges=true \
        --security-opt "seccomp=$SECCOMP_PROFILE" \
        --ipc none \
        --pids-limit 32 \
        --memory 256m \
        --memory-swap 256m \
        --cpus 1 \
        --user "$ANALYSIS_UID:$ANALYSIS_GID" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
        "$IMAGE_REF" python -c '
import errno
import subprocess

children = []
limit_blocked_spawn = False
try:
    for _ in range(96):
        try:
            children.append(subprocess.Popen(["/bin/sleep", "10"]))
        except OSError as exc:
            if exc.errno != errno.EAGAIN:
                raise
            limit_blocked_spawn = True
            print(f"PID limit blocked process creation after {len(children)} children")
            break
    if not limit_blocked_spawn:
        raise SystemExit("bounded fork smoke test did not reach the PID limit")
finally:
    for child in children:
        child.terminate()
    for child in children:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
'
}

assert_memory_limit() {
    allocate_cidfile || return 1
    oom_status=0
    "$RUNTIME" run --rm --cidfile "$CURRENT_CIDFILE" \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges=true \
        --security-opt "seccomp=$SECCOMP_PROFILE" \
        --ipc none \
        --pids-limit 16 \
        --memory 128m \
        --memory-swap 128m \
        --cpus 1 \
        --user "$ANALYSIS_UID:$ANALYSIS_GID" \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
        "$IMAGE_REF" python -c '
chunks = []
for _ in range(128):
    chunks.append(bytearray(4 * 1024 * 1024))
raise SystemExit("memory limit was not enforced after a bounded 512 MiB allocation")
' || oom_status=$?

    if [ "$oom_status" -ne 137 ]; then
        printf 'expected OOM-killed exit status 137, got %s\n' "$oom_status" >&2
        return 1
    fi
    printf '%s\n' 'memory cgroup killed the bounded over-allocation'
}

assert_zero_orphans() {
    orphan_found=0
    while IFS= read -r cidfile; do
        [ -s "$cidfile" ] || continue
        cid=$(sed -n '1p' "$cidfile")
        [ -n "$cid" ] || continue
        if "$RUNTIME" container inspect "$cid" >/dev/null 2>&1; then
            printf 'orphan container remains: %s\n' "$cid" >&2
            orphan_found=1
        fi
    done < "$CIDFILE_LIST"

    [ "$orphan_found" -eq 0 ]
}

run_assertion() {
    assertion_name=$1
    assertion_function=$2
    printf '\n[%s] %s\n' 'RUN' "$assertion_name"
    if "$assertion_function"; then
        PASS_COUNT=$((PASS_COUNT + 1))
        printf '[%s] %s\n' 'PASS' "$assertion_name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        printf '[%s] %s\n' 'FAIL' "$assertion_name" >&2
    fi
}

detection_status=0
detect_runtime || detection_status=$?
if [ "$detection_status" -ne 0 ]; then
    print_install_instructions
    exit 3
fi

printf 'Runtime: %s\n' "$RUNTIME_DESCRIPTION"
printf 'Seccomp: pinned profile at %s\n' "$SECCOMP_PROFILE"
printf 'Building %s...\n' "$IMAGE_TAG"

if ! "$RUNTIME" build --tag "$IMAGE_TAG" "$SANDBOX_DIR"; then
    printf '\nSummary: 0 passed, 1 failed (image build)\n' >&2
    exit 1
fi

if ! IMAGE_REF=$("$RUNTIME" image inspect --format '{{.Id}}' "$IMAGE_TAG"); then
    printf '\nSummary: 0 passed, 1 failed (image ID inspection failed)\n' >&2
    exit 1
fi
if [ -z "$IMAGE_REF" ]; then
    printf '\nSummary: 0 passed, 1 failed (image ID unavailable)\n' >&2
    exit 1
fi
printf 'Built image ID: %s\n' "$IMAGE_REF"

run_assertion 'network none blocks DNS, IPv4, and IPv6' assert_network_blocked
run_assertion 'read-only root filesystem rejects writes' assert_rootfs_read_only
run_assertion 'tmpfs scratch and host output bind are writable' assert_tmpfs_and_output_mount
run_assertion 'allowlisted data bind is readable and read-only' assert_data_mount_read_only
run_assertion 'identity, capabilities, seccomp, and cgroup controls are set' assert_resource_controls
run_assertion 'PID cgroup stops a bounded fork smoke test' assert_pid_limit
run_assertion 'memory cgroup stops a bounded OOM smoke test' assert_memory_limit
run_assertion 'all cidfile-tracked containers were removed' assert_zero_orphans

printf '\nSummary: %s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -eq 0 ]; then
    printf '%s\n' 'PASS: Sonny analysis sandbox preflight'
    exit 0
fi

printf '%s\n' 'FAIL: Sonny analysis sandbox preflight' >&2
exit 1
