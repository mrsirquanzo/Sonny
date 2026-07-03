export interface LiveCapabilities {
  live: boolean;
  anthropic: boolean;
  epo: boolean;
  anarci: boolean;
  reasons: string[];
}

// ANARCI availability is signalled by SONNY_ANARCI=1 (the user sets it after `conda install -c bioconda anarci hmmer`).
// A PATH probe is deferred to the live runner where a spawn is acceptable; detection here stays pure and env-only.
export function detectLiveCapabilities(env: NodeJS.ProcessEnv = process.env): LiveCapabilities {
  const live = env.SONNY_LIVE === '1';
  const anthropic = Boolean(env.ANTHROPIC_API_KEY);
  const epo = Boolean(env.SONNY_EPO_KEY && env.SONNY_EPO_SECRET);
  const anarci = env.SONNY_ANARCI === '1';
  const reasons: string[] = [];
  if (!live) reasons.push('SONNY_LIVE not set (live tier disabled)');
  if (!anthropic) reasons.push('ANTHROPIC_API_KEY missing (no model, cannot run)');
  if (!epo) reasons.push('EPO creds missing (SONNY_EPO_KEY/SECRET): patent identity degrades to EPO_CONFIG_MISSING');
  if (!anarci) reasons.push('ANARCI missing (SONNY_ANARCI!=1): region/species confirm degrades to anarci_unavailable');
  return { live, anthropic, epo, anarci, reasons };
}

export function liveEnabled(caps: LiveCapabilities): boolean {
  return caps.live && caps.anthropic;
}
