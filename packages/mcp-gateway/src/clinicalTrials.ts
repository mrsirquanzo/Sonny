import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://clinicaltrials.gov/api/v2/studies';

interface Study {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: { overallStatus?: string };
    designModule?: { phases?: string[] };
  };
}

export const clinicalTrialsTool: Tool = {
  name: 'clinical_trials_search',
  description: 'Search ClinicalTrials.gov (v2) and return trials (NCT id, title, phase, status).',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const url = `${ENDPOINT}?query.term=${encodeURIComponent(query)}&pageSize=8&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`ClinicalTrials.gov HTTP ${res.status}`);
    const studies = ((await res.json()) as { studies?: Study[] }).studies ?? [];
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    for (const s of studies) {
      const id = s.protocolSection?.identificationModule?.nctId;
      if (!id) continue;
      const phases = (s.protocolSection?.designModule?.phases ?? []).join('/');
      const status = s.protocolSection?.statusModule?.overallStatus ?? '';
      out.push({ id, kind: 'trial', source: 'ClinicalTrials.gov',
        title: s.protocolSection?.identificationModule?.briefTitle ?? '(no title)',
        snippet: `${phases} ${status}`.trim(), url: `https://clinicaltrials.gov/study/${id}`, raw: s, retrievedAt: now });
    }
    return out;
  },
};
