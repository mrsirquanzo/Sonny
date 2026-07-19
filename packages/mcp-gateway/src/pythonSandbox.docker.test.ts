import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisResultsSchema, canonicalJson } from '@mrsirquanzo/sonny-shared';
import { runAnalysisTemplate } from './pythonSandbox.js';

const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore', shell: false }).status === 0;
const dockerSuite = describe.skipIf(!dockerAvailable);
const imageTag = process.env.SONNY_ANALYSIS_IMAGE_TAG ?? 'sonny-analysis:preflight';
const runLabel = `sonny.analysis.integration=${process.pid}`;
const input = {
  templateId: 'trop2_analysis',
  params: { target: 'TACSTD2', analysisQuestion: 'trop2_profile' },
  datasetIds: ['depmap.crispr_gene_effect', 'gtex.median_tpm', 'expr.tumor'],
  timeoutMs: 120_000,
} as const;

let runRoot = '';

dockerSuite('hardened Python sandbox (real Docker)', () => {
  beforeAll(() => {
    // The run root MUST be under a path Docker Desktop shares into its VM. On
    // macOS the system tmpdir (/var/folders) is NOT shared, so bind mounts fail;
    // a repo-relative dir (under /Users) is. Matches production DEFAULT_RUN_ROOT.
    const base = fileURLToPath(new URL('../.docker-test-runs/', import.meta.url));
    mkdirSync(base, { recursive: true });
    runRoot = mkdtempSync(join(realpathSync(base), 'run-'));
    process.env.SONNY_ANALYSIS_RUN_ROOT = runRoot;
    process.env.SONNY_ANALYSIS_CONTAINER_LABEL = runLabel;
    process.env.SONNY_ANALYSIS_IMAGE = execFileSync(
      'docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}'],
      { encoding: 'utf8' },
    ).trim();
  });

  afterAll(() => {
    delete process.env.SONNY_ANALYSIS_RUN_ROOT;
    delete process.env.SONNY_ANALYSIS_CONTAINER_LABEL;
    delete process.env.SONNY_ANALYSIS_IMAGE;
    rmSync(runRoot, { recursive: true, force: true });
  });

  it('runs the reviewed TROP2 template twice with typed results and a PNG', async () => {
    const first = await runAnalysisTemplate(input);
    const replay = await runAnalysisTemplate(input);
    expect(AnalysisResultsSchema.parse(first.resultsJson)).toEqual(first.resultsJson);
    expect(first.artifacts.some((artifact) => artifact.mediaType === 'image/png')).toBe(true);
    expect(canonicalJson(first.resultsJson)).toBe(canonicalJson(replay.resultsJson));
  }, 300_000);

  it('blocks DNS, IPv4, and IPv6 under the executor hardening profile', () => {
    const image = process.env.SONNY_ANALYSIS_IMAGE as string;
    const seccomp = fileURLToPath(new URL('../sandbox/seccomp.json', import.meta.url));
    const python = `
import socket

failures = []
try:
    socket.getaddrinfo("example.com", 443)
except OSError:
    pass
else:
    failures.append("DNS")

for family, address, label in (
    (socket.AF_INET, ("1.1.1.1", 53), "IPv4"),
    (socket.AF_INET6, ("2606:4700:4700::1111", 53, 0, 0), "IPv6"),
):
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(0.5)
        sock.connect(address)
    except OSError:
        pass
    else:
        failures.append(label)
    finally:
        try:
            sock.close()
        except NameError:
            pass

if failures:
    raise SystemExit("network unexpectedly reachable: " + ", ".join(failures))
`;
    const probe = spawnSync('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true', '--security-opt', `seccomp=${seccomp}`,
      '--ipc=none', '--pids-limit', '64', '--memory', '512m', '--memory-swap', '512m',
      '--cpus', '1', '--user', '65532:65532', image, 'python', '-c', python,
    ], { encoding: 'utf8', shell: false });
    expect(probe.status, probe.stderr + probe.stdout).toBe(0);
  });

  it('leaves zero labeled orphan containers', () => {
    const ids = execFileSync('docker', [
      'ps', '-aq', '--filter', `label=${runLabel}`,
    ], { encoding: 'utf8' }).trim();
    expect(ids).toBe('');
  });
});
