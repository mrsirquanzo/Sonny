import { z } from 'zod';
import { JsonValueSchema } from './results.js';

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CanonicalDatasetInputSchema = z.object({
  datasetId: z.string().min(1),
  logicalSourceId: z.string().min(1),
  contentSha256: Sha256Schema,
  acquisitionQuery: JsonValueSchema,
  retrievedAt: z.string().min(1),
  lineageManifestHash: Sha256Schema,
}).strict();

export const CanonicalComputationManifestSchema = z.object({
  manifestVersion: z.literal('1.0.0'),
  templateId: z.string().min(1),
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  datasets: z.array(CanonicalDatasetInputSchema).min(1),
  imageDigest: ImageDigestSchema,
  codeHash: Sha256Schema,
  params: z.record(JsonValueSchema),
  seed: z.number().int().nonnegative(),
}).strict();

export type CanonicalDatasetInput = z.infer<typeof CanonicalDatasetInputSchema>;
export type CanonicalComputationManifest = z.infer<typeof CanonicalComputationManifestSchema>;

/** RFC 8785 JSON Canonicalization Scheme for JSON-domain values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not permit non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) throw new TypeError('JCS does not permit undefined values');
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`JCS does not permit ${typeof value} values`);
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function sha256Text(value: string): string {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const rotateRight = (word: number, count: number) => (word >>> count) | (word << (32 - count));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function canonicalComputationManifest(
  manifest: CanonicalComputationManifest,
): CanonicalComputationManifest {
  const parsed = CanonicalComputationManifestSchema.parse(manifest);
  return {
    ...parsed,
    datasets: [...parsed.datasets].sort((left, right) =>
      left.datasetId.localeCompare(right.datasetId)
      || left.logicalSourceId.localeCompare(right.logicalSourceId)
      || left.contentSha256.localeCompare(right.contentSha256)),
  };
}

export function computationId(manifest: CanonicalComputationManifest): string {
  return sha256CanonicalJson(canonicalComputationManifest(manifest));
}
