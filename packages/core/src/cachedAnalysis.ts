import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CanonicalComputationManifestSchema,
  ComputationEvidenceSchema,
  SectionSchema,
  canonicalComputationManifest,
  canonicalJson,
  computationId,
  sha256CanonicalJson,
  sha256Text,
  type CanonicalComputationManifest,
  type ComputationEvidence,
  type Section,
} from '@mrsirquanzo/sonny-shared';
import { z } from 'zod';
import type { AnalysisArtifact } from '@mrsirquanzo/sonny-mcp-gateway';
import type { AnalysisSpecialistResult } from './analysisSpecialist.js';
import { reproducibilityGate } from './reproducibilityGate.js';
import { ANALYSIS_RELEASE_PUBLIC_KEY_PEM } from './releasePublicKey.js';

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const Base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const PortableArtifactSchema = z.object({
  path: z.string().min(1),
  mediaType: z.enum(['application/json', 'image/png']),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  sha256: Sha256Schema,
  contentBase64: Base64Schema,
}).strict();

const CachedPayloadSchema = z.object({
  bundleVersion: z.literal('1.0.0'),
  target: z.string().min(1),
  publicKeyPem: z.string().min(1),
  publicKeyId: Sha256Schema,
  manifest: CanonicalComputationManifestSchema,
  originReplayVerification: z.literal('verified'),
  primaryResultHash: Sha256Schema,
  replayResultHash: Sha256Schema,
  section: z.unknown(),
  evidence: z.unknown(),
  artifacts: z.array(PortableArtifactSchema).min(1).max(8),
}).strict();

const SignedBundleSchema = z.object({
  signatureAlgorithm: z.literal('Ed25519'),
  payload: CachedPayloadSchema,
  signatureBase64: Base64Schema,
}).strict();

type CachedPayload = z.infer<typeof CachedPayloadSchema>;
type PortableArtifact = z.infer<typeof PortableArtifactSchema>;

export class CachedAnalysisBundleError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CachedAnalysisBundleError';
  }
}

export interface CreateSignedCachedAnalysisBundleInput {
  result: AnalysisSpecialistResult;
  outputPath: string;
  privateKeyPem: string;
}

export interface LoadSignedCachedAnalysisBundleInput {
  bundlePath: string;
  artifactRoot?: string;
  allowHistoricallyVerifiedCachedClaims?: boolean;
  expectedTarget?: string;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestFromEvidence(evidence: ComputationEvidence): CanonicalComputationManifest {
  return canonicalComputationManifest({
    manifestVersion: '1.0.0',
    templateId: evidence.templateId,
    templateVersion: evidence.templateVersion,
    datasets: evidence.datasetInputs.map(({ lineageManifest: _lineageManifest, ...dataset }) => dataset),
    imageDigest: evidence.imageDigest,
    codeHash: evidence.codeHash,
    params: evidence.params,
    seed: evidence.seed,
  });
}

function safeArtifactName(path: string): string {
  if (path !== basename(path) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) {
    throw new CachedAnalysisBundleError(`unsafe cached artifact path: ${path}`);
  }
  return path;
}

function portableArtifact(artifact: AnalysisArtifact): PortableArtifact {
  safeArtifactName(artifact.path);
  const bytes = readFileSync(artifact.hostPath);
  if (bytes.byteLength !== artifact.sizeBytes || sha256Bytes(bytes) !== artifact.sha256) {
    throw new CachedAnalysisBundleError(`live artifact changed before signing: ${artifact.path}`);
  }
  return {
    path: artifact.path,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    contentBase64: bytes.toString('base64'),
  };
}

function requireVerifiedLiveResult(result: AnalysisSpecialistResult): NonNullable<AnalysisSpecialistResult['verifiedRun']> {
  const verified = result.verifiedRun;
  if (!verified || result.abstentionReason || result.section.claims.length === 0
    || result.evidence.length !== 1
    || result.section.claims.some((claim) => claim.executionMode !== 'live'
      || claim.replayVerification !== 'verified' || claim.originVerification !== 'none')) {
    throw new CachedAnalysisBundleError('release signing requires a successful verified live double-run');
  }
  return verified;
}

function writeBundleAtomically(outputPath: string, contents: string): void {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, absolute);
}

/** Sign only the canonical payload of a successful, reproducibility-gated live result. */
export function createSignedCachedAnalysisBundle(input: CreateSignedCachedAnalysisBundleInput): void {
  const verifiedRun = requireVerifiedLiveResult(input.result);
  const evidence = ComputationEvidenceSchema.parse(input.result.evidence[0]);
  const section = SectionSchema.parse(input.result.section);
  if (section.kind !== 'analysis' || !section.computationIds.includes(evidence.computationId)) {
    throw new CachedAnalysisBundleError('analysis section does not resolve to its computation evidence');
  }
  if (verifiedRun.primaryResultHash !== evidence.resultsJsonHash) {
    throw new CachedAnalysisBundleError('primary result hash does not match computation evidence');
  }
  const artifacts = verifiedRun.artifacts.map(portableArtifact);
  if (!artifacts.some((artifact) => artifact.path === 'results.json')
    || !artifacts.some((artifact) => artifact.mediaType === 'image/png')) {
    throw new CachedAnalysisBundleError('portable cached run requires results.json and a PNG figure');
  }
  const resultsArtifact = artifacts.find((artifact) => artifact.path === 'results.json');
  if (!resultsArtifact || sha256CanonicalJson(JSON.parse(
    Buffer.from(resultsArtifact.contentBase64, 'base64').toString('utf8'),
  ) as unknown) !== verifiedRun.primaryResultHash) {
    throw new CachedAnalysisBundleError('results.json artifact does not match the verified primary result');
  }
  const manifest = manifestFromEvidence(evidence);
  if (computationId(manifest) !== evidence.computationId) {
    throw new CachedAnalysisBundleError('canonical manifest does not match computation evidence');
  }
  const payload: CachedPayload = CachedPayloadSchema.parse({
    bundleVersion: '1.0.0',
    target: evidence.raw.target.symbol,
    publicKeyPem: ANALYSIS_RELEASE_PUBLIC_KEY_PEM,
    publicKeyId: sha256Text(ANALYSIS_RELEASE_PUBLIC_KEY_PEM),
    manifest,
    originReplayVerification: verifiedRun.originReplayVerification,
    primaryResultHash: verifiedRun.primaryResultHash,
    replayResultHash: verifiedRun.replayResultHash,
    section,
    evidence,
    artifacts,
  });
  const signature = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(input.privateKeyPem));
  if (!verify(null, Buffer.from(canonicalJson(payload)), ANALYSIS_RELEASE_PUBLIC_KEY_PEM, signature)) {
    throw new CachedAnalysisBundleError('signing key does not match the bundled release public key');
  }
  writeBundleAtomically(input.outputPath, `${JSON.stringify({
    signatureAlgorithm: 'Ed25519', payload, signatureBase64: signature.toString('base64'),
  }, null, 2)}\n`);
}

function parseAndVerifyBundle(bundlePath: string): {
  payload: CachedPayload;
  section: Extract<Section, { kind: 'analysis' }>;
  evidence: ComputationEvidence;
  artifacts: Array<PortableArtifact & { bytes: Buffer }>;
} {
  try {
    const serialized = readFileSync(bundlePath);
    if (serialized.byteLength > MAX_BUNDLE_BYTES) throw new CachedAnalysisBundleError('cached bundle exceeds its size limit');
    const bundle = SignedBundleSchema.parse(JSON.parse(serialized.toString('utf8')) as unknown);
    if (bundle.payload.publicKeyPem !== ANALYSIS_RELEASE_PUBLIC_KEY_PEM
      || bundle.payload.publicKeyId !== sha256Text(ANALYSIS_RELEASE_PUBLIC_KEY_PEM)) {
      throw new CachedAnalysisBundleError('cached bundle is not anchored to the bundled release key');
    }
    const validSignature = verify(
      null,
      Buffer.from(canonicalJson(bundle.payload)),
      ANALYSIS_RELEASE_PUBLIC_KEY_PEM,
      Buffer.from(bundle.signatureBase64, 'base64'),
    );
    if (!validSignature) throw new CachedAnalysisBundleError('cached bundle signature verification failed');

    const section = SectionSchema.parse(bundle.payload.section);
    if (section.kind !== 'analysis') throw new CachedAnalysisBundleError('cached bundle section is not an analysis section');
    const evidence = ComputationEvidenceSchema.parse(bundle.payload.evidence);
    const manifest = canonicalComputationManifest(bundle.payload.manifest);
    if (canonicalJson(manifest) !== canonicalJson(bundle.payload.manifest)
      || computationId(manifest) !== evidence.computationId
      || canonicalJson(manifest) !== canonicalJson(manifestFromEvidence(evidence))) {
      throw new CachedAnalysisBundleError('cached bundle canonical computation manifest is inconsistent');
    }
    if (bundle.payload.target !== evidence.raw.target.symbol
      || bundle.payload.primaryResultHash !== evidence.resultsJsonHash) {
      throw new CachedAnalysisBundleError('cached bundle result identity is inconsistent');
    }
    const names = new Set<string>();
    const artifacts = bundle.payload.artifacts.map((artifact) => {
      safeArtifactName(artifact.path);
      if (names.has(artifact.path)) throw new CachedAnalysisBundleError(`duplicate cached artifact: ${artifact.path}`);
      names.add(artifact.path);
      const bytes = Buffer.from(artifact.contentBase64, 'base64');
      if (bytes.toString('base64') !== artifact.contentBase64
        || bytes.byteLength !== artifact.sizeBytes || sha256Bytes(bytes) !== artifact.sha256) {
        throw new CachedAnalysisBundleError(`cached artifact hash verification failed: ${artifact.path}`);
      }
      return { ...artifact, bytes };
    });
    const results = artifacts.find((artifact) => artifact.path === 'results.json');
    if (!results || sha256CanonicalJson(JSON.parse(results.bytes.toString('utf8')) as unknown)
      !== bundle.payload.primaryResultHash) {
      throw new CachedAnalysisBundleError('cached results.json does not match the compared primary result hash');
    }
    return { payload: bundle.payload, section, evidence, artifacts };
  } catch (error) {
    if (error instanceof CachedAnalysisBundleError) throw error;
    throw new CachedAnalysisBundleError('signed cached analysis bundle was rejected', { cause: error });
  }
}

function materializeArtifacts(
  artifacts: Array<PortableArtifact & { bytes: Buffer }>, artifactRoot: string, payload: CachedPayload,
): Map<string, string> {
  const runId = sha256CanonicalJson({
    computationId: computationId(payload.manifest),
    artifacts: artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
  });
  const directory = join(resolve(artifactRoot), runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths = new Map<string, string>();
  for (const artifact of artifacts) {
    const output = join(directory, artifact.path);
    if (existsSync(output)) {
      const stat = lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256Bytes(readFileSync(output)) !== artifact.sha256) {
        throw new CachedAnalysisBundleError(`cached artifact materialization collision: ${artifact.path}`);
      }
    } else {
      writeFileSync(output, artifact.bytes, { mode: 0o600, flag: 'wx' });
    }
    paths.set(artifact.path, output);
  }
  return paths;
}

/** Verify the release signature and artifact hashes before reconstructing cached claims. */
export function loadSignedCachedAnalysisBundle(
  input: LoadSignedCachedAnalysisBundleInput,
): AnalysisSpecialistResult {
  if (input.allowHistoricallyVerifiedCachedClaims === false) {
    throw new CachedAnalysisBundleError('historically verified cached claims are disabled by policy');
  }
  const verified = parseAndVerifyBundle(input.bundlePath);
  if (input.expectedTarget !== undefined
    && verified.payload.target.toUpperCase() !== input.expectedTarget.trim().toUpperCase()) {
    throw new CachedAnalysisBundleError(
      `cached bundle target ${verified.payload.target} does not match requested target ${input.expectedTarget}`,
    );
  }
  const gated = reproducibilityGate({
    claims: verified.section.claims,
    evidence: [verified.evidence],
    primaryResults: { [verified.evidence.computationId]: verified.evidence.raw },
    executionMode: 'cached',
    originVerification: 'verified',
  });
  if (gated.shippable.length !== verified.section.claims.length) {
    throw new CachedAnalysisBundleError(`cached claim grounding failed: ${gated.dropped[0]?.reason ?? 'unknown reason'}`);
  }
  const artifactRoot = input.artifactRoot ?? join(process.cwd(), '.sonny', 'analysis-cache', 'artifacts');
  const materialized = materializeArtifacts(verified.artifacts, artifactRoot, verified.payload);
  const declaredFigures = new Set(verified.evidence.raw.artifacts.map((artifact) => artifact.path));
  const figurePaths = verified.artifacts
    .filter((artifact) => artifact.mediaType === 'image/png' && declaredFigures.has(artifact.path))
    .map((artifact) => materialized.get(artifact.path))
    .filter((path): path is string => path !== undefined);
  if (figurePaths.length === 0) throw new CachedAnalysisBundleError('cached run has no verified declared figure');

  return {
    section: {
      ...verified.section,
      claims: gated.shippable,
      figurePaths,
    },
    evidence: [verified.evidence],
    dropped: [],
  };
}
