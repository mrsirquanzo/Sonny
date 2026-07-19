import { describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, OllamaEmbeddings } from './embeddings.js';

describe('OllamaEmbeddings', () => {
  it('calls the configurable Ollama embed endpoint and parses batch vectors', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }), { status: 200 }));
    const client = new OllamaEmbeddings({ model: 'embed-test', endpoint: 'http://ollama/api/embed', fetchImpl });
    await expect(client.embed(['alpha', 'beta'])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchImpl).toHaveBeenCalledWith('http://ollama/api/embed', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ model: 'embed-test', input: ['alpha', 'beta'] }),
    }));
  });

  it('rejects malformed vector counts', async () => {
    const client = new OllamaEmbeddings({
      fetchImpl: async () => new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 }),
    });
    await expect(client.embed(['a', 'b'])).rejects.toThrow('1 vectors for 2 inputs');
  });
});

describe('cosineSimilarity', () => {
  it('scores aligned, orthogonal, and invalid vectors', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});
