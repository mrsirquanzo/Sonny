const DEFAULT_EMBED_URL = 'http://localhost:11434/api/embed';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export interface OllamaEmbeddingOptions {
  model?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

interface EmbedResponse {
  embeddings?: unknown;
  embedding?: unknown;
}

function vector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Number.isFinite)) return undefined;
  return value as number[];
}

function endpointFromEnv(): string {
  const configured = process.env.SONNY_EMBED_URL;
  if (!configured) return DEFAULT_EMBED_URL;
  return configured.endsWith('/api/embed') || configured.endsWith('/api/embeddings')
    ? configured
    : `${configured.replace(/\/$/, '')}/api/embed`;
}

export class OllamaEmbeddings {
  readonly model: string;
  readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaEmbeddingOptions = {}) {
    this.model = opts.model ?? process.env.SONNY_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
    this.endpoint = opts.endpoint ?? endpointFromEnv();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Ollama embeddings HTTP ${response.status}`);
    const body = await response.json() as EmbedResponse;
    const modern = Array.isArray(body.embeddings) ? body.embeddings.map(vector) : [];
    if (modern.length === texts.length && modern.every((item): item is number[] => !!item)) return modern;

    // Older /api/embeddings servers accept one prompt and return one embedding.
    const legacy = vector(body.embedding);
    if (texts.length === 1 && legacy) return [legacy];
    throw new Error(`Ollama embeddings returned ${modern.filter(Boolean).length} vectors for ${texts.length} inputs`);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
