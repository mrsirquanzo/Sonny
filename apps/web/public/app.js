// apps/web/public/app.js
const $ = (id) => document.getElementById(id);
const evidence = new Map();         // id -> {id, title}
let es = null;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function openDrawer(id) {
  const e = evidence.get(id);
  $('drawer-body').innerHTML = e
    ? `<div style="font-family:var(--mono);color:var(--accent)">${esc(e.id)}</div><div style="font-weight:600;margin-top:6px">${esc(e.title)}</div>`
    : `<div>${esc(id)}</div>`;
  $('drawer').classList.add('open'); $('scrim').classList.add('on');
}
function closeDrawer() { $('drawer').classList.remove('open'); $('scrim').classList.remove('on'); }
$('drawer-close').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
$('edits-toggle').onclick = () => { document.body.classList.toggle('show-edits'); $('edits-toggle').classList.toggle('on'); };

function appendTrace(line) { $('trace').textContent += line + '\n'; }

function reset() {
  evidence.clear(); $('trace').textContent = ''; $('dossier').innerHTML = '';
  $('evidence-list').innerHTML = ''; $('verdict').textContent = 'Researching…';
  $('meta').textContent = ''; $('edits-toggle').hidden = true; document.body.classList.remove('show-edits');
}

function handle(ev) {
  switch (ev.type) {
    case 'plan': appendTrace(`PLAN  specialists=${ev.specialists.join(',')} tools=${ev.tools.join(',')}`); break;
    case 'tool_call': appendTrace(`  → ${ev.tool}(${JSON.stringify(ev.args)})`); break;
    case 'tool_result': appendTrace(`  ← ${ev.tool}: ${ev.count} record(s)`); break;
    case 'evidence_registered': {
      evidence.set(ev.id, { id: ev.id, title: ev.title });
      const row = document.createElement('div'); row.className = 'erow';
      row.innerHTML = `<div><div class="eid" data-id="${esc(ev.id)}">${esc(ev.id)}</div><div class="et">${esc(ev.title)}</div></div>`;
      $('evidence-list').appendChild(row); break;
    }
    case 'claim_drafted': appendTrace(`  claim ${ev.claim.id}: ${ev.claim.text}`); break;
    case 'verdict': appendTrace(`  verdict ${ev.verdict.claimId}: ${ev.verdict.status}`); break;
    case 'synthesis': {
      // section is plain text with [ID] tokens — render with clickable citation chips.
      const html = ev.section.split('\n').map((line) => {
        const escaped = esc(line);
        return `<p>${escaped.replace(/\[([^\]]+)\]/g, (_, id) => `<span class="cite" data-id="${esc(id)}">[${esc(id)}]</span>`)}</p>`;
      }).join('');
      $('dossier').innerHTML = html; break;
    }
    case 'error': appendTrace(`  ! ${ev.message}`); break;
  }
}

function wireCitations() {
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]'); if (t) openDrawer(t.getAttribute('data-id'));
  });
}
wireCitations();

function run() {
  const q = $('query').value.trim(); if (!q) return;
  if (es) es.close(); reset();
  const symbol = (q.match(/\b[A-Z0-9]{2,7}\b/) || ['EGFR'])[0];
  es = new EventSource(`/api/run?q=${encodeURIComponent(q)}&symbol=${encodeURIComponent(symbol)}`);
  es.onmessage = (m) => handle(JSON.parse(m.data));
  es.addEventListener('done', (m) => {
    const { section } = JSON.parse(m.data);
    $('verdict').textContent = section ? 'Findings' : 'No grounded findings';
    $('meta').textContent = `${evidence.size} sources cited · grounded + verified`;
    $('edits-toggle').hidden = false; es.close();
  });
  es.addEventListener('error', (m) => {
    try { appendTrace('  ! ' + JSON.parse(m.data).message); } catch { /* connection closed */ }
    es.close();
  });
}
$('run').onclick = run;
$('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
