// Opt-in live patent eval. Usage:
//   SONNY_LIVE=1 ANTHROPIC_API_KEY=... [SONNY_EPO_KEY=... SONNY_EPO_SECRET=... SONNY_ANARCI=1] \
//   SONNY_GOLDEN_FILE_<name>=/path/to/patent.pdf pnpm --filter @sonny/eval exec tsx src/patentLiveMain.ts
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';
import { loadGoldens } from './goldenLoader.js';
import { runLivePatent } from './patentLive.js';

const caps = detectLiveCapabilities();
console.log('live capabilities:', JSON.stringify({ live: caps.live, anthropic: caps.anthropic, epo: caps.epo, anarci: caps.anarci }));
for (const r of caps.reasons) console.log('  -', r);
if (!liveEnabled(caps)) { console.log('live tier not enabled; set SONNY_LIVE=1 and ANTHROPIC_API_KEY.'); process.exit(0); }

for (const l of loadGoldens()) {
  const file = process.env[`SONNY_GOLDEN_FILE_${l.golden.name}`];
  if (!file) { console.log(`skip ${l.golden.name}: no SONNY_GOLDEN_FILE_${l.golden.name}`); continue; }
  const report = await runLivePatent(l.golden, file, caps);
  const label = report.groundTruthVerified ? 'VERIFIED' : 'UNVERIFIED (observe-only)';
  console.log(`\n[${label}] ${report.name}`);
  console.log(JSON.stringify(report.metrics, null, 2));
  for (const n of report.notes) console.log('  note:', n);
}
