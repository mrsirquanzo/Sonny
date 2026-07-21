import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { looksLikeFreeText, resolveQueryScope } from './parseQuery.js';

function fixedModel(result: unknown): StructuredModel {
  return { async generateStructured() { return result as never; } };
}
function throwingModel(): StructuredModel {
  return { async generateStructured() { throw new Error('rate limited'); } };
}

describe('looksLikeFreeText', () => {
  it('treats a bare symbol as not free text and a sentence as free text', () => {
    expect(looksLikeFreeText('CDCP1')).toBe(false);
    expect(looksLikeFreeText('  HER2 ')).toBe(false);
    expect(looksLikeFreeText('assess CDCP1 as an ADC in NSCLC')).toBe(true);
  });
});

describe('resolveQueryScope', () => {
  it('returns a bare symbol verbatim without calling the model', async () => {
    let called = false;
    const model: StructuredModel = { async generateStructured() { called = true; return {} as never; } };
    const events: TraceEvent[] = [];
    const out = await resolveQueryScope({ rawQuery: 'CDCP1', model, emit: (e) => events.push(e) });
    expect(out).toEqual({ target: 'CDCP1' });
    expect(called).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('parses a free-form prompt into target + indication + modality and emits query_parsed', async () => {
    const events: TraceEvent[] = [];
    const model = fixedModel({ target: 'CDCP1', indication: 'NSCLC', modality: 'ADC' });
    const out = await resolveQueryScope({ rawQuery: 'is CDCP1 a good ADC target in NSCLC?', model, emit: (e) => events.push(e) });
    expect(out).toEqual({ target: 'CDCP1', indication: 'NSCLC', modality: 'ADC' });
    expect(events.some((e) => e.type === 'query_parsed')).toBe(true);
  });

  it('drops filler values like "not specified"', async () => {
    const model = fixedModel({ target: 'TROP2', indication: 'not specified', modality: 'none' });
    const out = await resolveQueryScope({ rawQuery: 'look at TROP2 please', model, emit: () => {} });
    expect(out).toEqual({ target: 'TROP2' });
  });

  it('degrades to raw text as target and emits an error when parsing throws', async () => {
    const events: TraceEvent[] = [];
    const out = await resolveQueryScope({ rawQuery: 'evaluate some target here', model: throwingModel(), emit: (e) => events.push(e) });
    expect(out).toEqual({ target: 'evaluate some target here' });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
