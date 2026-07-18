import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnalysisResultsSchema,
  ComputationEvidenceSchema,
  computationId,
  sha256CanonicalJson,
  type AnalysisResults,
  type ComputationEvidence,
  type JsonValue,
} from '@mrsirquanzo/sonny-shared';
import { z } from 'zod';
import { resolveAnalysisRuntimeAssets } from './runtimeAssets.js';

const ANALYSIS_UID = 65_532;
const ANALYSIS_GID = 65_532;
const PID_LIMIT = 64;
const MEMORY_LIMIT = '512m';
const CPU_LIMIT = '1';
const TMP_LIMIT = '64m';
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
// Per-file write cap inside the container. Above the largest artifact + matplotlib cache.
const FSIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACTS = 8;
const MAX_STDIO_BYTES = 64 * 1024;
const RUNTIME_ASSETS = resolveAnalysisRuntimeAssets();
const SECCOMP_PATH = RUNTIME_ASSETS.seccomp;
const TEMPLATE_ROOT = dirname(RUNTIME_ASSETS.template);
const DATA_ROOT = dirname(RUNTIME_ASSETS.depmap);
const DATASETS_MANIFEST_PATH = RUNTIME_ASSETS.datasetsManifest;
const DEFAULT_RUN_ROOT = fileURLToPath(new URL('../../../.sonny/analysis-runs/', import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const Trop2ParamsSchema = z.object({
  target: z.literal('TACSTD2'),
  analysisQuestion: z.enum([
    'trop2_profile', 'dependency', 'tumor_expression', 'normal_tissue_expression',
  ]),
}).strict();

interface TemplateDefinition {
  templateId: string;
  version: string;
  codePath: string;
  paramsSchema: typeof Trop2ParamsSchema;
  requiredDatasetIds: readonly string[];
  seed: number;
}

const TEMPLATE_REGISTRY: Readonly<Record<string, TemplateDefinition>> = Object.freeze({
  trop2_analysis: Object.freeze({
    templateId: 'trop2_analysis',
    version: '1.0.0',
    codePath: join(TEMPLATE_ROOT, 'trop2_analysis.py'),
    paramsSchema: Trop2ParamsSchema,
    requiredDatasetIds: Object.freeze([
      'depmap.crispr_gene_effect', 'gtex.median_tpm', 'expr.tumor',
    ]),
    seed: 1729,
  }),
});

interface DatasetManifestEntry {
  id: string;
  source: string;
  sourceIds: Record<string, JsonValue>;
  acquisitionQuery: JsonValue;
  retrievedAt: string;
  outputSha256: string;
  [key: string]: JsonValue;
}

interface DatasetsManifest {
  manifestVersion: string;
  datasets: DatasetManifestEntry[];
}

export interface ComputationDatasetHash {
  datasetId: string;
  logicalSourceId: string;
  contentSha256: string;
  acquisitionQuery: JsonValue;
  retrievedAt: string;
  lineageManifestHash: string;
  lineageManifest: Record<string, JsonValue>;
}

export interface AnalysisArtifact {
  path: string;
  hostPath: string;
  mediaType: 'application/json' | 'image/png';
  sizeBytes: number;
  sha256: string;
}

export interface AnalysisExecutionResult {
  resultsJson: AnalysisResults;
  artifacts: AnalysisArtifact[];
  exitCode: number;
  timedOut: boolean;
  imageDigest: string;
  codeBytes: string;
  codeHash: string;
  datasetHashes: ComputationDatasetHash[];
  params: Record<string, JsonValue>;
  seed: number;
}

export interface RunAnalysisTemplateInput {
  templateId: string;
  params: unknown;
  datasetIds: readonly string[];
  timeoutMs: number;
}

export interface ComputationEvidenceOptions {
  resultKeys: readonly string[];
  retrievedAt?: string;
  source?: string;
  title?: string;
  snippet?: string;
  url?: string;
}

export class AnalysisSandboxError extends Error {
  readonly exitCode: number | null;
  readonly timedOut: boolean;

  constructor(message: string, options: { exitCode?: number | null; timedOut?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AnalysisSandboxError';
    this.exitCode = options.exitCode ?? null;
    this.timedOut = options.timedOut ?? false;
  }
}

interface CommandResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface PreparedDataset {
  mountPath: string;
  evidence: ComputationDatasetHash;
}

interface ValidatedOutput {
  resultsJson: AnalysisResults;
  artifacts: Omit<AnalysisArtifact, 'hostPath'>[];
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireImmutableImage(): { imageRef: string; imageDigest: string } {
  const imageRef = process.env.SONNY_ANALYSIS_IMAGE?.trim();
  if (!imageRef) {
    throw new AnalysisSandboxError(
      'SONNY_ANALYSIS_IMAGE must be an inspected sha256 image ID or a name@sha256 digest; mutable tags fail closed',
    );
  }
  const imageId = imageRef.match(/^sha256:([a-f0-9]{64})$/);
  const namedDigest = imageRef.match(/^[^\s@]+@sha256:([a-f0-9]{64})$/);
  const digest = imageId?.[1] ?? namedDigest?.[1];
  if (!digest) {
    throw new AnalysisSandboxError('SONNY_ANALYSIS_IMAGE is not digest/ID pinned');
  }
  return { imageRef, imageDigest: `sha256:${digest}` };
}

function isContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new AnalysisSandboxError(`trusted path root is not a real directory: ${root}`);
  }
  for (const component of components) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new AnalysisSandboxError(`trusted path contains a symlink: ${cursor}`);
    if (!stat.isDirectory() && cursor !== absolute) {
      throw new AnalysisSandboxError(`trusted path component is not a directory: ${cursor}`);
    }
  }
}

function ensureTrustedDirectory(path: string): string {
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path);
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AnalysisSandboxError(`trusted run root is not a real directory: ${path}`);
  }
  return realpathSync(path);
}

function requireRegularContainedFile(path: string, parent: string, label: string): string {
  const parentReal = realpathSync(parent);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AnalysisSandboxError(`${label} is not a regular file`);
  }
  const real = realpathSync(path);
  if (!isContained(parentReal, real) || dirname(real) !== parentReal) {
    throw new AnalysisSandboxError(`${label} escaped its reviewed registry directory`);
  }
  if (real.includes(',')) throw new AnalysisSandboxError(`${label} path cannot be represented as a Docker mount`);
  return real;
}

function loadDatasetsManifest(): DatasetsManifest {
  const parsed = JSON.parse(readFileSync(DATASETS_MANIFEST_PATH, 'utf8')) as DatasetsManifest;
  if (parsed.manifestVersion !== '1.0.0' || !Array.isArray(parsed.datasets)) {
    throw new AnalysisSandboxError('dataset registry has an unsupported manifest version');
  }
  return parsed;
}

function logicalSourceId(dataset: DatasetManifestEntry): string {
  const release = dataset.sourceIds.release
    ?? dataset.sourceIds.datasetId
    ?? dataset.sourceIds.studyId
    ?? dataset.id;
  return `${dataset.source}:${String(release)}`;
}

function prepareDatasets(template: TemplateDefinition, requestedIds: readonly string[]): PreparedDataset[] {
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new AnalysisSandboxError('datasetIds must not contain duplicates');
  }
  const required = [...template.requiredDatasetIds].sort();
  const requested = [...requestedIds].sort();
  if (JSON.stringify(required) !== JSON.stringify(requested)) {
    throw new AnalysisSandboxError(`template ${template.templateId} requires exactly: ${required.join(', ')}`);
  }

  const manifest = loadDatasetsManifest();
  const byId = new Map(manifest.datasets.map((entry) => [entry.id, entry]));
  return template.requiredDatasetIds.map((datasetId) => {
    const entry = byId.get(datasetId);
    if (!entry) throw new AnalysisSandboxError(`unknown reviewed dataset: ${datasetId}`);

    // Slice 1's committed files are canonically named by dataset ID. Resolve that
    // exact allowlisted filename; never trust a caller-provided path or mount the lake.
    const mountPath = requireRegularContainedFile(
      join(DATA_ROOT, `${datasetId}.csv`), DATA_ROOT, `dataset ${datasetId}`,
    );
    const contentSha256 = sha256Bytes(readFileSync(mountPath));
    if (contentSha256 !== entry.outputSha256) {
      throw new AnalysisSandboxError(`dataset ${datasetId} does not match its reviewed content hash`);
    }
    const lineageManifest = entry as Record<string, JsonValue>;
    return {
      mountPath,
      evidence: {
        datasetId,
        logicalSourceId: logicalSourceId(entry),
        contentSha256,
        acquisitionQuery: entry.acquisitionQuery,
        retrievedAt: entry.retrievedAt,
        lineageManifestHash: sha256CanonicalJson(lineageManifest),
        lineageManifest,
      },
    };
  });
}

function boundedAppend(current: string, chunk: Buffer, label: string): string {
  const nextBytes = Buffer.byteLength(current) + chunk.byteLength;
  if (nextBytes > MAX_STDIO_BYTES) {
    throw new AnalysisSandboxError(`container ${label} exceeded ${MAX_STDIO_BYTES} bytes`);
  }
  return current + chunk.toString('utf8');
}

function readCid(cidfile: string): string | undefined {
  if (!existsSync(cidfile)) return undefined;
  const cid = readFileSync(cidfile, 'utf8').trim();
  return /^[a-f0-9]{12,64}$/.test(cid) || /^[A-Za-z0-9_.-]+$/.test(cid) ? cid : undefined;
}

async function dockerCommand(argv: string[], options: {
  timeoutMs?: number;
  cidfile?: string;
  containerName?: string;
} = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('docker', argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let streamError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      try { stdout = boundedAppend(stdout, chunk, 'stdout'); } catch (error) { streamError = error as Error; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      try { stderr = boundedAppend(stderr, chunk, 'stderr'); } catch (error) { streamError = error as Error; child.kill('SIGKILL'); }
    });
    child.on('error', rejectOnce);
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (streamError) { rejectPromise(streamError); return; }
      resolvePromise({ exitCode: code ?? 128, signal, stdout, stderr, timedOut });
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        const cid = options.cidfile ? readCid(options.cidfile) : undefined;
        const cleanupTarget = cid ?? options.containerName;
        if (cleanupTarget) {
          void dockerCommand(['rm', '-f', cleanupTarget]).catch(() => child.kill('SIGKILL'));
        } else {
          child.kill('SIGKILL');
        }
      }, options.timeoutMs);
    }
  });
}

async function checkedDockerCommand(argv: string[]): Promise<CommandResult> {
  const result = await dockerCommand(argv);
  if (result.exitCode !== 0) {
    throw new AnalysisSandboxError(`docker ${argv[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
      exitCode: result.exitCode,
    });
  }
  return result;
}

async function removeContainer(cidfile: string, containerName: string): Promise<void> {
  // cidfile is authoritative once Docker creates it. The predeclared random name
  // closes the startup race where a timeout can fire just before cidfile creation.
  const target = readCid(cidfile) ?? containerName;
  await dockerCommand(['rm', '-f', target]).catch(() => undefined);
}

async function removeVolume(volumeName: string): Promise<void> {
  await dockerCommand(['volume', 'rm', '-f', volumeName]).catch(() => undefined);
}

function validateExtractedOutput(outputDirectory: string): ValidatedOutput {
  const rootStat = lstatSync(outputDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AnalysisSandboxError('artifact extraction root is not a regular directory');
  }
  const rootReal = realpathSync(outputDirectory);
  const entries = readdirSync(outputDirectory, { withFileTypes: true });
  if (entries.length === 0 || entries.length > MAX_ARTIFACTS) {
    throw new AnalysisSandboxError(`artifact count must be between 1 and ${MAX_ARTIFACTS}`);
  }

  let totalBytes = 0;
  let resultsJson: AnalysisResults | undefined;
  const artifacts: Omit<AnalysisArtifact, 'hostPath'>[] = [];
  for (const entry of entries) {
    const artifactPath = join(outputDirectory, entry.name);
    const fileStat = lstatSync(artifactPath);
    if (!entry.isFile() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new AnalysisSandboxError(`artifact ${entry.name} is not a regular file`);
    }
    const real = realpathSync(artifactPath);
    if (!isContained(rootReal, real) || dirname(real) !== rootReal) {
      throw new AnalysisSandboxError(`artifact ${entry.name} escaped output containment`);
    }
    const bytes = readFileSync(real);
    totalBytes += bytes.byteLength;
    if (totalBytes > OUTPUT_LIMIT_BYTES) throw new AnalysisSandboxError('artifact output exceeded total size limit');

    let mediaType: AnalysisArtifact['mediaType'];
    if (entry.name.endsWith('.png')) {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PNG_BYTES) {
        throw new AnalysisSandboxError(`PNG artifact ${entry.name} exceeded its size limit`);
      }
      if (bytes.subarray(0, PNG_SIGNATURE.length).compare(PNG_SIGNATURE) !== 0) {
        throw new AnalysisSandboxError(`PNG artifact ${entry.name} has invalid magic bytes`);
      }
      mediaType = 'image/png';
    } else if (entry.name.endsWith('.json')) {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_JSON_BYTES) {
        throw new AnalysisSandboxError(`JSON artifact ${entry.name} exceeded its size limit`);
      }
      const firstByte = bytes.toString('utf8').trimStart()[0];
      if (firstByte !== '{') throw new AnalysisSandboxError(`JSON artifact ${entry.name} has invalid magic bytes`);
      let json: unknown;
      try { json = JSON.parse(bytes.toString('utf8')) as unknown; } catch (cause) {
        throw new AnalysisSandboxError(`JSON artifact ${entry.name} is invalid`, { cause });
      }
      if (entry.name === 'results.json') resultsJson = AnalysisResultsSchema.parse(json);
      mediaType = 'application/json';
    } else {
      throw new AnalysisSandboxError(`artifact ${entry.name} has a forbidden extension`);
    }
    artifacts.push({
      path: entry.name,
      mediaType,
      sizeBytes: fileStat.size,
      sha256: sha256Bytes(bytes),
    });
  }

  if (!resultsJson) throw new AnalysisSandboxError('validated output is missing results.json');
  const declaredFigures = new Set(resultsJson.artifacts.map((artifact) => artifact.path));
  const extractedFigures = new Set(artifacts.filter((artifact) => artifact.mediaType === 'image/png').map((artifact) => artifact.path));
  if (canonicalSet(declaredFigures) !== canonicalSet(extractedFigures)) {
    throw new AnalysisSandboxError('extracted PNG artifacts do not match results.json declarations');
  }
  if (artifacts.filter((artifact) => artifact.mediaType === 'application/json').some((artifact) => artifact.path !== 'results.json')) {
    throw new AnalysisSandboxError('only the schema-validated results.json JSON artifact is permitted');
  }
  return { resultsJson, artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)) };
}

function canonicalSet(values: Set<string>): string {
  return JSON.stringify([...values].sort());
}

function verifyExistingPromotion(path: string, artifacts: readonly Omit<AnalysisArtifact, 'hostPath'>[]): void {
  const names = readdirSync(path).sort();
  if (JSON.stringify(names) !== JSON.stringify(artifacts.map((artifact) => artifact.path).sort())) {
    throw new AnalysisSandboxError('content-addressed run directory collision');
  }
  for (const artifact of artifacts) {
    const candidate = requireRegularContainedFile(join(path, artifact.path), path, `promoted artifact ${artifact.path}`);
    const stat = statSync(candidate);
    if (stat.size !== artifact.sizeBytes || sha256Bytes(readFileSync(candidate)) !== artifact.sha256) {
      throw new AnalysisSandboxError('content-addressed run directory collision');
    }
  }
}

function promoteOutput(
  extractedDirectory: string,
  runsDirectory: string,
  artifacts: readonly Omit<AnalysisArtifact, 'hostPath'>[],
): AnalysisArtifact[] {
  const runHash = sha256CanonicalJson(artifacts.map(({ path, mediaType, sizeBytes, sha256 }) => ({
    path, mediaType, sizeBytes, sha256,
  })));
  const finalDirectory = join(runsDirectory, runHash);
  if (existsSync(finalDirectory)) {
    verifyExistingPromotion(finalDirectory, artifacts);
    rmSync(extractedDirectory, { recursive: true, force: true });
  } else {
    renameSync(extractedDirectory, finalDirectory);
    chmodSync(finalDirectory, 0o700);
  }
  return artifacts.map((artifact) => ({ ...artifact, hostPath: join(finalDirectory, artifact.path) }));
}

function mount(source: string, destination: string): string {
  if (source.includes(',')) throw new AnalysisSandboxError('Docker bind source contains an unsupported comma');
  return `type=bind,src=${source},dst=${destination},readonly`;
}

/** Run one reviewed template exclusively inside the hardened Docker boundary. */
export async function runAnalysisTemplate(input: RunAnalysisTemplateInput): Promise<AnalysisExecutionResult> {
  const template = TEMPLATE_REGISTRY[input.templateId];
  if (!template) throw new AnalysisSandboxError(`unknown reviewed template: ${input.templateId}`);
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 10 * 60_000) {
    throw new AnalysisSandboxError('timeoutMs must be an integer between 1 and 600000');
  }
  const params = template.paramsSchema.parse(input.params) as Record<string, JsonValue>;
  const { imageRef, imageDigest } = requireImmutableImage();
  const codePath = requireRegularContainedFile(template.codePath, TEMPLATE_ROOT, `template ${input.templateId}`);
  const codeBuffer = readFileSync(codePath);
  const codeBytes = codeBuffer.toString('utf8');
  if (!Buffer.from(codeBytes, 'utf8').equals(codeBuffer)) {
    throw new AnalysisSandboxError('reviewed template is not valid UTF-8');
  }
  const codeHash = sha256Bytes(codeBuffer);
  const preparedDatasets = prepareDatasets(template, input.datasetIds);

  const runRoot = ensureTrustedDirectory(process.env.SONNY_ANALYSIS_RUN_ROOT ?? DEFAULT_RUN_ROOT);
  const runsDirectory = ensureTrustedDirectory(join(runRoot, 'runs'));
  const pendingRoot = ensureTrustedDirectory(join(runRoot, 'pending'));
  const pendingDirectory = mkdtempSync(join(pendingRoot, 'run-'));
  chmodSync(pendingDirectory, 0o700);
  const paramsPath = join(pendingDirectory, 'params.json');
  const cidfile = join(pendingDirectory, 'container.cid');
  const extractedDirectory = join(pendingDirectory, 'extracted');
  writeFileSync(paramsPath, `${JSON.stringify(params)}\n`, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
  mkdirSync(extractedDirectory, { mode: 0o700 });

  const runId = randomUUID();
  const volumeName = `sonny-analysis-output-${runId}`;
  const containerName = `sonny-analysis-run-${runId}`;
  let volumeCreated = false;
  try {
    // A plain local volume (NOT type=tmpfs): a tmpfs-backed volume is emptied
    // the instant the container stops, so `docker cp` after exit would find an
    // empty /output. A regular volume persists until we remove it, and output
    // size is already bounded by the fsize ulimit + OUTPUT_LIMIT_BYTES on extract.
    // A plain local volume (NOT type=tmpfs): a tmpfs-backed volume is emptied
    // the instant the container stops, so `docker cp` after exit would find an
    // empty /output. A fresh volume mounted at /output inherits the image's
    // /output dir ownership (non-root uid, set in the Dockerfile), so the
    // non-root run can write. Output size is bounded by the fsize ulimit +
    // OUTPUT_LIMIT_BYTES on extraction.
    await checkedDockerCommand(['volume', 'create', '--driver', 'local', volumeName]);
    volumeCreated = true;

    const dockerArguments = [
      'run', '--cidfile', cidfile, '--name', containerName,
      '--label', `sonny.analysis.run=${runId}`,
      ...(process.env.SONNY_ANALYSIS_CONTAINER_LABEL
        ? ['--label', process.env.SONNY_ANALYSIS_CONTAINER_LABEL]
        : []),
      '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true',
      '--security-opt', `seccomp=${SECCOMP_PATH}`,
      '--ipc=none', '--pids-limit', String(PID_LIMIT),
      '--memory', MEMORY_LIMIT, '--memory-swap', MEMORY_LIMIT,
      '--cpus', CPU_LIMIT, '--user', `${ANALYSIS_UID}:${ANALYSIS_GID}`,
      // fsize is a per-file byte cap (RLIMIT_FSIZE). Must exceed the largest
      // legitimate artifact (PNG) plus matplotlib's font cache, or writes EFBIG.
      '--ulimit', 'nofile=256:256', '--ulimit', `fsize=${FSIZE_LIMIT_BYTES}:${FSIZE_LIMIT_BYTES}`,
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${TMP_LIMIT},mode=1777`,
      '--mount', mount(codePath, '/work/template.py'),
      '--mount', mount(paramsPath, '/work/params.json'),
      ...preparedDatasets.flatMap(({ mountPath, evidence }) => [
        '--mount', mount(mountPath, `/data/${evidence.datasetId}.csv`),
      ]),
      // No volume-nocopy: a fresh empty volume must inherit the image's /output
      // dir ownership (non-root uid) so the analysis can write. The image dir is
      // empty, so nothing but ownership/mode is copied.
      '--mount', `type=volume,src=${volumeName},dst=/output`,
      imageRef, 'python', '/work/template.py',
    ];
    const execution = await dockerCommand(dockerArguments, {
      timeoutMs: input.timeoutMs, cidfile, containerName,
    });
    if (execution.timedOut) {
      throw new AnalysisSandboxError(`analysis template timed out after ${input.timeoutMs}ms`, {
        exitCode: execution.exitCode, timedOut: true,
      });
    }
    if (execution.exitCode !== 0 || execution.signal !== null) {
      throw new AnalysisSandboxError(
        `analysis template failed: ${execution.stderr.trim() || `exit ${execution.exitCode}`}`,
        { exitCode: execution.exitCode },
      );
    }

    const cid = readCid(cidfile);
    if (!cid) throw new AnalysisSandboxError('Docker did not write a valid container ID');
    await checkedDockerCommand(['cp', `${cid}:/output/.`, extractedDirectory]);
    const validated = validateExtractedOutput(extractedDirectory);
    if (validated.resultsJson.templateId !== template.templateId
      || validated.resultsJson.templateVersion !== template.version) {
      throw new AnalysisSandboxError('results.json template identity does not match the reviewed registry');
    }
    const artifacts = promoteOutput(extractedDirectory, runsDirectory, validated.artifacts);

    return {
      resultsJson: validated.resultsJson,
      artifacts,
      exitCode: execution.exitCode,
      timedOut: false,
      imageDigest,
      codeBytes,
      codeHash,
      datasetHashes: preparedDatasets.map(({ evidence }) => evidence),
      params,
      seed: template.seed,
    };
  } finally {
    // Artifact copy, validation, and atomic promotion all happen above while the
    // stopped container and named volume still exist. Teardown is unconditional.
    await removeContainer(cidfile, containerName);
    if (volumeCreated) await removeVolume(volumeName);
    rmSync(pendingDirectory, { recursive: true, force: true });
  }
}

/** Adapt executor provenance using Slice 2's canonical manifest and evidence schema. */
export function toComputationEvidence(
  result: AnalysisExecutionResult,
  options: ComputationEvidenceOptions,
): ComputationEvidence {
  const manifest = {
    manifestVersion: '1.0.0' as const,
    templateId: result.resultsJson.templateId,
    templateVersion: result.resultsJson.templateVersion,
    datasets: result.datasetHashes.map(({ lineageManifest: _lineageManifest, ...dataset }) => dataset),
    imageDigest: result.imageDigest,
    codeHash: result.codeHash,
    params: result.params,
    seed: result.seed,
  };
  const id = computationId(manifest);
  return ComputationEvidenceSchema.parse({
    id: `COMPUTATION:${id}`,
    kind: 'computation',
    source: options.source ?? 'Sonny reviewed analysis',
    title: options.title ?? `${result.resultsJson.target.symbol} reviewed analysis`,
    snippet: options.snippet ?? 'Typed output from a reviewed, hardened Docker analysis.',
    url: options.url ?? '',
    retrievedAt: options.retrievedAt ?? new Date().toISOString(),
    raw: result.resultsJson,
    computationId: id,
    templateId: manifest.templateId,
    templateVersion: manifest.templateVersion,
    datasetInputs: result.datasetHashes,
    imageDigest: result.imageDigest,
    codeBytes: result.codeBytes,
    codeHash: result.codeHash,
    params: result.params,
    seed: result.seed,
    exitStatus: { exitCode: result.exitCode, timedOut: result.timedOut, signal: null },
    resultKeys: [...options.resultKeys],
    resultsJsonHash: sha256CanonicalJson(result.resultsJson),
  });
}
