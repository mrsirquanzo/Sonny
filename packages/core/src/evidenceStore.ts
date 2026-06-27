import type { Evidence } from '@sonny/shared';

export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  register(e: Evidence): void { if (!this.byId.has(e.id)) this.byId.set(e.id, e); }
  get(id: string): Evidence | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  all(): Evidence[] { return [...this.byId.values()]; }
}
