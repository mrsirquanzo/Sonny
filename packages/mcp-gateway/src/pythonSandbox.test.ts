import { EventEmitter } from 'node:events';
import {
  cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { ComputationEvidenceSchema } from '@mrsirquanzo/sonny-shared';
import {
  runAnalysisTemplate, toComputationEvidence, type AnalysisArtifact,
} from './pythonSandbox.js';

const GOLDEN_RESULTS = new URL('./dataLake/golden/trop2_results.json', import.meta.url);
const GOLDEN_PNG = new URL('./dataLake/golden/trop2_analysis.png', import.meta.url);
const IMAGE_ID = `sha256:${'2'.repeat(64)}`;
const VALID_INPUT = {
  templateId: 'trop2_analysis',
  params: { target: 'TACSTD2', analysisQuestion: 'trop2_profile' },
  datasetIds: [
    'depmap.crispr_gene_effect', 'gtex.median_tpm', 'expr.tumor',
  ],
  timeoutMs: 1_000,
} as const;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

type ExtractWriter = (destination: string) => void;

function successfulArtifacts(destination: string): void {
  cpSync(GOLDEN_RESULTS, join(destination, 'results.json'));
  cpSync(GOLDEN_PNG, join(destination, 'trop2_analysis.png'));
}

function installDockerMock(options: {
  extract?: ExtractWriter;
  runError?: Error;
  hangRun?: boolean;
} = {}): void {
  let hangingRun: FakeChild | undefined;
  spawnMock.mockImplementation((_command: string, argv: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);

    process.nextTick(() => {
      const action = argv[0];
      if (action === 'run') {
        const cidfile = argv[argv.indexOf('--cidfile') + 1];
        writeFileSync(cidfile, 'sandbox-container-id\n', { mode: 0o600 });
        if (options.runError) {
          child.emit('error', options.runError);
          return;
        }
        if (options.hangRun) {
          hangingRun = child;
          return;
        }
      }
      if (action === 'cp') {
        const destination = argv.at(-1);
        if (!destination) throw new Error('docker cp destination missing in test');
        (options.extract ?? successfulArtifacts)(destination);
      }
      if (action === 'rm' && options.hangRun && hangingRun) {
        const run = hangingRun;
        hangingRun = undefined;
        process.nextTick(() => run.emit('close', 137, 'SIGKILL'));
      }
      child.emit('close', 0, null);
    });
    return child;
  });
}

function callsFor(action: string): string[][] {
  return spawnMock.mock.calls
    .map((call) => call[1] as string[])
    .filter((argv) => argv[0] === action);
}

function expectLifecycleCleanup(): void {
  expect(callsFor('rm').some((argv) => argv.includes('sandbox-container-id'))).toBe(true);
  expect(callsFor('volume').some((argv) => argv[1] === 'rm' && argv.includes('-f'))).toBe(true);
}

let runRoot: string;

beforeEach(() => {
  runRoot = mkdtempSync(join(realpathSync(tmpdir()), 'sonny-sandbox-unit-'));
  process.env.SONNY_ANALYSIS_RUN_ROOT = runRoot;
  process.env.SONNY_ANALYSIS_IMAGE = IMAGE_ID;
  spawnMock.mockReset();
});

afterEach(() => {
  delete process.env.SONNY_ANALYSIS_RUN_ROOT;
  delete process.env.SONNY_ANALYSIS_IMAGE;
  rmSync(runRoot, { recursive: true, force: true });
});

describe.sequential('runAnalysisTemplate', () => {
  it('passes every hardening flag without a shell and mounts only exact reviewed inputs', async () => {
    installDockerMock();

    const result = await runAnalysisTemplate(VALID_INPUT);
    const runCall = spawnMock.mock.calls.find((call) => (call[1] as string[])[0] === 'run');
    expect(runCall).toBeDefined();
    const argv = runCall?.[1] as string[];
    const spawnOptions = runCall?.[2] as Record<string, unknown>;

    expect(spawnOptions.shell).toBe(false);
    expect(argv).toEqual(expect.arrayContaining([
      '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true', '--ipc=none',
      '--pids-limit', '64', '--memory', '512m', '--memory-swap', '512m',
      '--cpus', '1', '--user', '65532:65532', IMAGE_ID,
    ]));
    expect(argv.some((value) => value.startsWith('seccomp='))).toBe(true);
    expect(argv).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777');
    expect(argv).toContain('nofile=256:256');
    expect(argv).toContain('fsize=16777216:16777216'); // 16 MiB per-file cap (fits the PNG + font cache)

    const mounts = argv.filter((_value, index) => argv[index - 1] === '--mount');
    expect(mounts.filter((mount) => mount.includes('type=bind'))).toHaveLength(5);
    expect(mounts.filter((mount) => mount.includes('dst=/data/'))).toHaveLength(3);
    expect(mounts.filter((mount) => mount.includes('dst=/data/')).every((mount) => mount.endsWith(',readonly'))).toBe(true);
    expect(mounts).toContainEqual(expect.stringContaining('type=volume'));
    expect(mounts).toContainEqual(expect.stringContaining('dst=/output'));
    expect(result.exitCode).toBe(0);
    expect(result.resultsJson.templateId).toBe('trop2_analysis');
    expectLifecycleCleanup();
  });

  it('passes normalized params only through a read-only JSON mount and rejects injection fields', async () => {
    let mountedParams: unknown;
    installDockerMock();
    spawnMock.mockImplementationOnce(spawnMock.getMockImplementation()!);

    const originalImplementation = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation((command: string, argv: string[], options: unknown) => {
      if (argv[0] === 'run') {
        const mount = argv.find((value) => value.includes('dst=/work/params.json'));
        const source = mount?.match(/src=([^,]+),dst=/)?.[1];
        if (!source || !mount?.endsWith(',readonly')) throw new Error('params mount is not read-only');
        mountedParams = JSON.parse(readFileSync(source, 'utf8')) as unknown;
        expect(argv.join('\n')).not.toContain('TACSTD2; touch /tmp/pwned');
      }
      return originalImplementation(command, argv, options);
    });

    await runAnalysisTemplate(VALID_INPUT);
    expect(mountedParams).toEqual({ target: 'TACSTD2', analysisQuestion: 'trop2_profile' });

    spawnMock.mockClear();
    await expect(runAnalysisTemplate({
      ...VALID_INPUT,
      params: { ...VALID_INPUT.params, command: 'TACSTD2; touch /tmp/pwned' },
    })).rejects.toThrow(/unrecognized|unknown/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['symlink', (destination: string) => {
      cpSync(GOLDEN_RESULTS, join(destination, 'results.json'));
      const target = join(destination, 'actual.png');
      cpSync(GOLDEN_PNG, target);
      symlinkSync(target, join(destination, 'trop2_analysis.png'));
    }],
    ['oversized artifact', (destination: string) => {
      cpSync(GOLDEN_RESULTS, join(destination, 'results.json'));
      writeFileSync(join(destination, 'trop2_analysis.png'), Buffer.alloc(9 * 1024 * 1024));
    }],
    ['non-PNG magic bytes', (destination: string) => {
      cpSync(GOLDEN_RESULTS, join(destination, 'results.json'));
      writeFileSync(join(destination, 'trop2_analysis.png'), 'not a png');
    }],
    ['non-PNG/JSON extension', (destination: string) => {
      cpSync(GOLDEN_RESULTS, join(destination, 'results.json'));
      cpSync(GOLDEN_PNG, join(destination, 'trop2_analysis.png'));
      writeFileSync(join(destination, 'payload.py'), 'print(1)');
    }],
  ] satisfies Array<[string, ExtractWriter]>)('rejects a %s and still cleans up', async (_label, extract) => {
    installDockerMock({ extract });
    await expect(runAnalysisTemplate(VALID_INPUT)).rejects.toThrow(/artifact|regular|PNG|extension|size/i);
    expectLifecycleCleanup();
  });

  it('cleans the container and output volume when docker spawn throws', async () => {
    installDockerMock({ runError: new Error('daemon disconnected') });
    await expect(runAnalysisTemplate(VALID_INPUT)).rejects.toThrow('daemon disconnected');
    expectLifecycleCleanup();
  });

  it('kills the cidfile container on timeout and leaves no output volume', async () => {
    installDockerMock({ hangRun: true });
    await expect(runAnalysisTemplate({ ...VALID_INPUT, timeoutMs: 10 })).rejects.toThrow(/timed out/i);
    expectLifecycleCleanup();
  });

  it('adapts a successful result through the Slice 2 computation manifest and evidence schema', async () => {
    installDockerMock();
    const result = await runAnalysisTemplate(VALID_INPUT);
    const evidence = toComputationEvidence(result, {
      resultKeys: ['dependency.median_gene_effect'],
      retrievedAt: '2026-07-17T20:58:39Z',
    });

    expect(ComputationEvidenceSchema.parse(evidence).computationId).toBe(evidence.computationId);
    expect(evidence.codeHash).toBe(result.codeHash);
    expect((evidence.raw as { templateId: string }).templateId).toBe('trop2_analysis');
    expect(result.artifacts.every((artifact: AnalysisArtifact) => artifact.hostPath.startsWith(realpathSync(runRoot)))).toBe(true);
  });
});
