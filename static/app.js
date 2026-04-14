/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
let leagues          = [];
let currentLeague    = null;   // full league object
let leagueTeams      = [];
let leagueSchedule   = [];
let editingTeamId    = null;
let pendingMembers   = [];     // [{name, gender}]
let editingLeagueId  = null;
let currentMatchData = null;   // data from GET /api/matches/<id>
let currentMatchId   = null;
let perfType         = 'scratch';  // 'scratch' | 'handicap'

/* ═══════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );

  // League selector
  document.getElementById('league-select').addEventListener('change', e => {
    const id = parseInt(e.target.value);
    currentLeague = leagues.find(l => l.id === id) || null;
    onLeagueChange();
  });
  document.getElementById('btn-manage-leagues').addEventListener('click', openLeaguesModal);

  // Leagues modal
  document.getElementById('leagues-modal-close').addEventListener('click', closeLeaguesModal);
  document.getElementById('leagues-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('leagues-modal-backdrop')) closeLeaguesModal();
  });
  document.getElementById('league-hdcp-toggle').addEventListener('change', e => {
    document.getElementById('hdcp-fields').classList.toggle('visible', e.target.checked);
  });
  document.getElementById('league-subform-save').addEventListener('click', saveLeague);
  document.getElementById('league-subform-cancel').addEventListener('click', resetLeagueSubform);

  // Team modal
  document.getElementById('btn-add-team').addEventListener('click', openAddTeam);
  document.getElementById('team-modal-close').addEventListener('click', closeTeamModal);
  document.getElementById('team-modal-cancel').addEventListener('click', closeTeamModal);
  document.getElementById('team-modal-save').addEventListener('click', saveTeam);
  document.getElementById('btn-add-bowler-row').addEventListener('click', addBowlerRow);
  document.getElementById('team-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('team-modal-backdrop')) closeTeamModal();
  });

  // Template league
  document.getElementById('btn-load-template').addEventListener('click', loadTemplateLeague);

  // Score modal
  document.getElementById('score-modal-close').addEventListener('click', closeScoreModal);
  document.getElementById('score-modal-cancel').addEventListener('click', closeScoreModal);
  document.getElementById('score-modal-save').addEventListener('click', saveScores);
  document.getElementById('score-modal-clear').addEventListener('click', clearScores);
  document.getElementById('score-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('score-modal-backdrop')) closeScoreModal();
  });

  // Performers toggle
  document.getElementById('perf-type-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#perf-type-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    perfType = btn.dataset.type;
    renderPerformers(window._lastPerformers || null);
  });

  // Schedule
  document.getElementById('btn-generate').addEventListener('click', generateSchedule);

  loadLeagues();
});

/* ═══════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════ */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (!currentLeague) return;
  if (tab === 'standings')  loadStandings();
  if (tab === 'schedule')   loadSchedule();
  if (tab === 'averages')   loadAverages();
  if (tab === 'performers') loadPerformers();
}

/* ═══════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════ */
function toast(msg, type = 'success') {
  const c  = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ═══════════════════════════════════════════════
   API
═══════════════════════════════════════════════ */
async function api(url, opts = {}) {
  const res  = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ═══════════════════════════════════════════════
   LEAGUES
═══════════════════════════════════════════════ */
async function loadLeagues() {
  try {
    leagues = await api('/api/leagues');
    renderLeagueSelector();
    renderLeagueList();
    if (leagues.length && !currentLeague) {
      currentLeague = leagues[0];
      document.getElementById('league-select').value = currentLeague.id;
      onLeagueChange();
    }
  } catch (e) { toast(e.message, 'error'); }
}

function renderLeagueSelector() {
  const sel = document.getElementById('league-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select league —</option>' +
    leagues.map(l => `<option value="${l.id}"${String(l.id) === String(cur) ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
}

function onLeagueChange() {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'teams';
  loadTeams();
  loadSchedule();
  if (activeTab === 'standings')  loadStandings();
  if (activeTab === 'averages')   loadAverages();
  if (activeTab === 'performers') loadPerformers();
}

function openLeaguesModal() {
  resetLeagueSubform();
  renderLeagueList();
  document.getElementById('leagues-modal-backdrop').classList.add('open');
}
function closeLeaguesModal() {
  document.getElementById('leagues-modal-backdrop').classList.remove('open');
}

function renderLeagueList() {
  const el = document.getElementById('leagues-list');
  if (!leagues.length) {
    el.innerHTML = '<p class="text-muted" style="font-size:0.85rem">No leagues yet.</p>';
    return;
  }
  el.innerHTML = leagues.map(l => `
    <div class="league-item ${currentLeague?.id === l.id ? 'current' : ''}" onclick="selectLeague(${l.id})">
      <span class="league-item-name">${esc(l.name)}</span>
      ${l.handicap_enabled ? `<span class="league-item-badge">Handicap ${l.handicap_base}/${Math.round(l.handicap_pct*100)}%</span>` : ''}
      <div class="league-item-actions" onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="editLeague(${l.id})" title="Edit">&#9998;</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteLeague(${l.id},'${esc(l.name)}')" title="Delete">&#128465;</button>
      </div>
    </div>
  `).join('');
}

function selectLeague(id) {
  currentLeague = leagues.find(l => l.id === id) || null;
  document.getElementById('league-select').value = id;
  renderLeagueList();
  onLeagueChange();
}

function editLeague(id) {
  const l = leagues.find(x => x.id === id);
  if (!l) return;
  editingLeagueId = id;
  document.getElementById('league-subform-title').textContent = 'Edit League';
  document.getElementById('league-name-input').value      = l.name;
  document.getElementById('league-hdcp-toggle').checked   = !!l.handicap_enabled;
  document.getElementById('league-hdcp-base').value       = l.handicap_base;
  document.getElementById('league-hdcp-pct').value        = Math.round(l.handicap_pct * 100);
  document.getElementById('hdcp-fields').classList.toggle('visible', !!l.handicap_enabled);
}

function resetLeagueSubform() {
  editingLeagueId = null;
  document.getElementById('league-subform-title').textContent = 'New League';
  document.getElementById('league-name-input').value    = '';
  document.getElementById('league-hdcp-toggle').checked = false;
  document.getElementById('league-hdcp-base').value     = 200;
  document.getElementById('league-hdcp-pct').value      = 80;
  document.getElementById('hdcp-fields').classList.remove('visible');
}

async function saveLeague() {
  const name = document.getElementById('league-name-input').value.trim();
  if (!name) { toast('League name required', 'error'); return; }
  const hdcp_enabled = document.getElementById('league-hdcp-toggle').checked;
  const hdcp_base    = parseInt(document.getElementById('league-hdcp-base').value) || 200;
  const hdcp_pct     = (parseInt(document.getElementById('league-hdcp-pct').value) || 80) / 100;

  const body = JSON.stringify({ name, handicap_enabled: hdcp_enabled, handicap_base: hdcp_base, handicap_pct: hdcp_pct });
  try {
    if (editingLeagueId) {
      await api(`/api/leagues/${editingLeagueId}`, { method: 'PUT', body });
      toast('League updated');
    } else {
      await api('/api/leagues', { method: 'POST', body });
      toast('League created');
    }
    await loadLeagues();
    resetLeagueSubform();
    renderLeagueList();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteLeague(id, name) {
  if (!confirm(`Delete league "${name}" and all its data?`)) return;
  try {
    await api(`/api/leagues/${id}`, { method: 'DELETE' });
    if (currentLeague?.id === id) currentLeague = null;
    toast('League deleted');
    await loadLeagues();
    renderLeagueList();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadTemplateLeague() {
  const name = prompt('Name for the template league:', 'Template League');
  if (name === null) return;  // cancelled
  const label = name.trim() || 'Template League';
  try {
    document.getElementById('btn-load-template').textContent = 'Loading…';
    document.getElementById('btn-load-template').disabled = true;
    const res = await api('/api/leagues/template', {
      method: 'POST',
      body: JSON.stringify({ name: label }),
    });
    toast(`"${res.name}" created with 10 weeks of scores!`);
    await loadLeagues();
    selectLeague(res.league_id);
    closeLeaguesModal();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    const btn = document.getElementById('btn-load-template');
    btn.textContent = '🎳 Load Template League (10 teams · 3 bowlers · 10 weeks)';
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════
   TEAMS
═══════════════════════════════════════════════ */
async function loadTeams() {
  if (!currentLeague) {
    document.getElementById('teams-grid').innerHTML =
      '<div class="empty-state"><p>Select or create a league first.</p></div>';
    return;
  }
  try {
    leagueTeams = await api(`/api/leagues/${currentLeague.id}/teams`);
    renderTeams();
  } catch (e) { toast(e.message, 'error'); }
}

function renderTeams() {
  const grid   = document.getElementById('teams-grid');
  const hdcpOn = currentLeague?.handicap_enabled;
  if (!leagueTeams.length) {
    grid.innerHTML = '<div class="empty-state"><p>No teams yet.</p></div>';
    return;
  }
  grid.innerHTML = leagueTeams.map(t => `
    <div class="team-card">
      <div class="team-card-header">
        <div class="team-name-h">${esc(t.name)}</div>
        <div class="team-actions">
          <button class="btn btn-ghost btn-sm" onclick="openEditTeam(${t.id})" title="Edit">&#9998;</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteTeam(${t.id},'${esc(t.name)}')" title="Delete">&#128465;</button>
        </div>
      </div>
      ${t.members.length
        ? `<ul class="members-list">${t.members.map(m => {
            const avgLabel  = m.games_bowled ? `Avg ${m.average}` : 'No avg';
            const hdcpLabel = (hdcpOn && m.handicap !== null) ? ` · Hdcp ${m.handicap}` : '';
            return `<li class="member-chip">
              <span class="gender-badge">${m.gender}</span>
              <span class="member-name-text">${esc(m.name)}</span>
              <span class="member-stat-text">${avgLabel}${hdcpLabel}</span>
            </li>`;
          }).join('')}</ul>`
        : `<span class="no-members">No bowlers</span>`}
    </div>
  `).join('');
}

function openAddTeam() {
  if (!currentLeague) { toast('Select a league first', 'error'); return; }
  editingTeamId  = null;
  pendingMembers = [{name:'',gender:'M'},{name:'',gender:'M'},{name:'',gender:'M'}];
  document.getElementById('team-modal-title').textContent = 'Add Team';
  document.getElementById('team-name-input').value = '';
  renderBowlerRows();
  document.getElementById('team-modal-backdrop').classList.add('open');
  document.getElementById('team-name-input').focus();
}

function openEditTeam(id) {
  const t = leagueTeams.find(x => x.id === id);
  if (!t) return;
  editingTeamId  = id;
  pendingMembers = t.members.length
    ? t.members.map(m => ({ name: m.name, gender: m.gender }))
    : [{name:'',gender:'M'},{name:'',gender:'M'},{name:'',gender:'M'}];
  document.getElementById('team-modal-title').textContent = 'Edit Team';
  document.getElementById('team-name-input').value = t.name;
  renderBowlerRows();
  document.getElementById('team-modal-backdrop').classList.add('open');
  document.getElementById('team-name-input').focus();
}

function closeTeamModal() {
  document.getElementById('team-modal-backdrop').classList.remove('open');
}

function renderBowlerRows() {
  document.getElementById('bowler-rows').innerHTML = pendingMembers.map((m, i) => `
    <div class="bowler-entry-row" id="brow-${i}">
      <input type="text" value="${esc(m.name)}" placeholder="Bowler name"
             oninput="pendingMembers[${i}].name = this.value" autocomplete="off" />
      <button class="gender-pill ${m.gender}" onclick="toggleGender(${i})">${m.gender}</button>
      <button class="remove-bowler-btn" onclick="removeBowlerRow(${i})" title="Remove">&times;</button>
    </div>
  `).join('');
}

function toggleGender(idx) {
  pendingMembers[idx].gender = pendingMembers[idx].gender === 'M' ? 'F' : 'M';
  renderBowlerRows();
  // Re-focus the same row's name input to avoid losing place
  const input = document.querySelector(`#brow-${idx} input`);
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function removeBowlerRow(idx) {
  pendingMembers.splice(idx, 1);
  renderBowlerRows();
}

function addBowlerRow() {
  pendingMembers.push({ name: '', gender: 'M' });
  renderBowlerRows();
  // Focus the new row
  const rows = document.querySelectorAll('.bowler-entry-row input');
  if (rows.length) rows[rows.length - 1].focus();
}

async function saveTeam() {
  const name = document.getElementById('team-name-input').value.trim();
  if (!name) { toast('Team name required', 'error'); return; }
  // Sync name values from DOM (oninput keeps pendingMembers updated, but guard here too)
  document.querySelectorAll('.bowler-entry-row input').forEach((inp, i) => {
    if (pendingMembers[i]) pendingMembers[i].name = inp.value.trim();
  });
  const members = pendingMembers.filter(m => m.name);
  const body = JSON.stringify({ name, members });
  try {
    if (editingTeamId) {
      await api(`/api/teams/${editingTeamId}`, { method: 'PUT', body });
      toast('Team updated');
    } else {
      await api(`/api/leagues/${currentLeague.id}/teams`, { method: 'POST', body });
      toast('Team added');
    }
    closeTeamModal();
    await loadTeams();
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmDeleteTeam(id, name) {
  if (!confirm(`Delete "${name}"? Their scores will also be removed.`)) return;
  try {
    await api(`/api/teams/${id}`, { method: 'DELETE' });
    toast('Team deleted');
    await loadTeams();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

/* ═══════════════════════════════════════════════
   SCHEDULE
═══════════════════════════════════════════════ */
async function loadSchedule() {
  if (!currentLeague) {
    document.getElementById('schedule-list').innerHTML =
      '<div class="empty-state"><p>Select a league first.</p></div>';
    return;
  }
  try {
    leagueSchedule = await api(`/api/leagues/${currentLeague.id}/schedule`);
    renderSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSchedule() {
  const container = document.getElementById('schedule-list');
  if (!leagueSchedule.length) {
    container.innerHTML = '<div class="empty-state"><p>No schedule yet. Add teams and click Generate.</p></div>';
    return;
  }
  const byWeek = {};
  leagueSchedule.forEach(m => { (byWeek[m.week] = byWeek[m.week] || []).push(m); });

  container.innerHTML = Object.entries(byWeek).map(([week, matches]) => `
    <div class="week-group">
      <div class="week-label">Week ${week}</div>
      ${matches.map(matchRowHtml).join('')}
    </div>
  `).join('');
}

function matchRowHtml(m) {
  let summary = '';
  let statusHtml = `<span class="score-status pending">Pending</span>`;

  if (m.result) {
    const r   = m.result;
    const adj = currentLeague?.handicap_enabled;
    const s1  = adj ? r.t1_adj   : r.t1_series;
    const s2  = adj ? r.t2_adj   : r.t2_series;
    summary = `<span class="match-score-summary">${s1}–${s2} &nbsp;(<span class="pts">${fmt(r.t1_pts)}–${fmt(r.t2_pts)}</span> pts)</span>`;
    statusHtml = `<span class="score-status entered">Entered</span>`;
  }

  return `
    <div class="match-row ${m.has_scores ? 'has-scores' : ''}" onclick="openScoreModal(${m.id})">
      <div class="match-teams">
        <span>${esc(m.team1_name)}</span>
        <span class="vs-badge">vs</span>
        <span>${esc(m.team2_name)}</span>
      </div>
      ${summary}
      ${statusHtml}
    </div>`;
}

function fmt(n) { return Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, ''); }

async function generateSchedule() {
  if (!currentLeague) { toast('Select a league first', 'error'); return; }
  const weeks = document.getElementById('weeks-input').value;
  if (leagueSchedule.length && !confirm('Replace the current schedule? All entered scores will be lost.')) return;
  try {
    const res = await api(`/api/leagues/${currentLeague.id}/schedule/generate`, {
      method: 'POST',
      body: JSON.stringify({ weeks: weeks ? parseInt(weeks) : null }),
    });
    toast(`Schedule generated — ${res.weeks} week${res.weeks !== 1 ? 's' : ''}`);
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

/* ═══════════════════════════════════════════════
   SCORE MODAL
═══════════════════════════════════════════════ */
async function openScoreModal(matchId) {
  currentMatchId = matchId;
  try {
    currentMatchData = await api(`/api/matches/${matchId}`);
    buildScoreModal(currentMatchData);
    document.getElementById('score-modal-backdrop').classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
}

function buildScoreModal(data) {
  document.getElementById('score-modal-title').textContent =
    `Week ${data.week} — ${data.team1.name}  vs  ${data.team2.name}`;

  const hdcp = data.league.handicap_enabled;

  document.getElementById('score-modal-body').innerHTML = `
    ${teamBlock(data.team1, 't1', hdcp)}
    <div class="score-divider">vs</div>
    ${teamBlock(data.team2, 't2', hdcp)}
    <div id="score-preview" class="score-preview"></div>
  `;

  // Attach live-update listeners
  document.querySelectorAll('.game-input').forEach(inp =>
    inp.addEventListener('input', updateScorePreview)
  );
  updateScorePreview();
}

function teamBlock(team, side, hdcpEnabled) {
  const rows = team.members.map(m => {
    const avgStr  = m.average ? `Avg: ${m.average}` : 'No avg';
    const hdcpStr = hdcpEnabled ? ` · Hdcp: ${m.handicap}` : '';
    return `
      <div class="bowler-row" data-member="${m.id}" data-side="${side}">
        <div class="bowler-info">
          <div class="bn">${esc(m.name)} <span style="color:var(--muted);font-size:0.72rem">${m.gender}</span></div>
          <div class="ba">${avgStr}${hdcpStr ? `<span class="bh">${hdcpStr}</span>` : ''}</div>
        </div>
        <input type="number" class="game-input" data-member="${m.id}" data-side="${side}" data-game="1"
               min="0" max="300" placeholder="G1" value="${m.game1 ?? ''}">
        <input type="number" class="game-input" data-member="${m.id}" data-side="${side}" data-game="2"
               min="0" max="300" placeholder="G2" value="${m.game2 ?? ''}">
        <input type="number" class="game-input" data-member="${m.id}" data-side="${side}" data-game="3"
               min="0" max="300" placeholder="G3" value="${m.game3 ?? ''}">
        <div class="bowler-series" id="series-${m.id}">${seriesVal(m)}</div>
      </div>`;
  }).join('');

  return `
    <div class="score-team-block">
      <div class="score-team-header">
        <span>${esc(team.name)}</span>
        <div class="score-team-totals" id="totals-${side}">
          G1: <span class="val" id="${side}-g1">—</span>
          G2: <span class="val" id="${side}-g2">—</span>
          G3: <span class="val" id="${side}-g3">—</span>
          Series: <span class="val" id="${side}-ser">—</span>
          ${hdcpEnabled ? `<span style="color:var(--purple)">+Hdcp</span>` : ''}
        </div>
      </div>
      <div class="bowler-rows">${rows}</div>
    </div>`;
}

function seriesVal(m) {
  const g1 = m.game1 ?? '', g2 = m.game2 ?? '', g3 = m.game3 ?? '';
  if (g1 === '' && g2 === '' && g3 === '') return '—';
  return (parseInt(g1)||0) + (parseInt(g2)||0) + (parseInt(g3)||0);
}

function updateScorePreview() {
  if (!currentMatchData) return;
  const data = currentMatchData;

  // Collect all inputs
  const vals = {};
  document.querySelectorAll('.game-input').forEach(inp => {
    const mid  = inp.dataset.member;
    const game = inp.dataset.game;
    const side = inp.dataset.side;
    if (!vals[mid]) vals[mid] = { side, g1: null, g2: null, g3: null };
    vals[mid][`g${game}`] = inp.value === '' ? null : parseInt(inp.value);
  });

  // Update per-bowler series
  Object.entries(vals).forEach(([mid, v]) => {
    const el = document.getElementById(`series-${mid}`);
    if (!el) return;
    if (v.g1 === null && v.g2 === null && v.g3 === null) { el.textContent = '—'; return; }
    el.textContent = (v.g1||0) + (v.g2||0) + (v.g3||0);
  });

  // Compute team totals per game
  function teamTotals(side) {
    const members = data[side === 't1' ? 'team1' : 'team2'].members;
    const totals  = [0, 0, 0];
    let complete  = true;
    members.forEach(m => {
      const v = vals[m.id];
      if (!v) { complete = false; return; }
      for (let g = 0; g < 3; g++) {
        if (v[`g${g+1}`] === null) complete = false;
        totals[g] += v[`g${g+1}`] || 0;
      }
    });
    return { totals, complete };
  }

  const { totals: t1g, complete: t1ok } = teamTotals('t1');
  const { totals: t2g, complete: t2ok } = teamTotals('t2');

  // Update team totals display
  ['t1', 't2'].forEach(side => {
    const gt = side === 't1' ? t1g : t2g;
    const ok = side === 't1' ? t1ok : t2ok;
    ['g1','g2','g3'].forEach((k, i) => {
      const el = document.getElementById(`${side}-${k}`);
      if (el) el.textContent = ok ? gt[i] : '—';
    });
    const serEl = document.getElementById(`${side}-ser`);
    if (serEl) serEl.textContent = ok ? gt.reduce((a,b)=>a+b,0) : '—';
  });

  if (!t1ok || !t2ok) {
    document.getElementById('score-preview').classList.remove('visible');
    return;
  }

  // Calculate points preview (mirrors backend logic)
  const league   = data.league;
  const hdcpOn   = !!league.handicap_enabled;
  const base     = league.handicap_base;
  const pctVal   = league.handicap_pct;

  function teamHdcp(teamKey) {
    if (!hdcpOn) return 0;
    const members = data[teamKey === 't1' ? 'team1' : 'team2'].members;
    return members.reduce((sum, m) => sum + hdcpAmt(m.average, base, pctVal), 0);
  }

  const t1Hdcp = teamHdcp('t1');
  const t2Hdcp = teamHdcp('t2');

  let p1 = 0, p2 = 0;
  const gameLines = [];

  for (let g = 0; g < 3; g++) {
    const c1 = t1g[g] + t1Hdcp, c2 = t2g[g] + t2Hdcp;
    const a  = hdcpOn ? c1 : t1g[g];
    const b  = hdcpOn ? c2 : t2g[g];
    if (a > b)      { p1 += 1;    gameLines.push(`G${g+1}: ${a} vs ${b} → <b style="color:var(--green)">${esc(data.team1.name)} wins</b>`); }
    else if (b > a) { p2 += 1;    gameLines.push(`G${g+1}: ${a} vs ${b} → <b style="color:var(--green)">${esc(data.team2.name)} wins</b>`); }
    else            { p1+=0.5; p2+=0.5; gameLines.push(`G${g+1}: ${a} vs ${b} → <span class="tie-badge">Tie (0.5 each)</span>`); }
  }

  const s1s = t1g.reduce((a,b)=>a+b,0), s2s = t2g.reduce((a,b)=>a+b,0);
  const s1a = s1s + t1Hdcp*3, s2a = s2s + t2Hdcp*3;
  const sa  = hdcpOn ? s1a : s1s, sb = hdcpOn ? s2a : s2s;
  let serLine;
  if (sa > sb)      { p1 += 1;    serLine = `Series: ${sa} vs ${sb} → <b style="color:var(--green)">${esc(data.team1.name)} wins</b>`; }
  else if (sb > sa) { p2 += 1;    serLine = `Series: ${sa} vs ${sb} → <b style="color:var(--green)">${esc(data.team2.name)} wins</b>`; }
  else              { p1+=0.5; p2+=0.5; serLine = `Series: ${sa} vs ${sb} → <span class="tie-badge">Tie (0.5 each)</span>`; }

  const prev = document.getElementById('score-preview');
  prev.classList.add('visible');
  prev.innerHTML = `
    ${gameLines.map(l => `<div class="preview-row">${l}</div>`).join('')}
    <div class="preview-row">${serLine}</div>
    <hr style="border-color:var(--border);margin:0.5rem 0">
    <div class="preview-row">
      <span><b>${esc(data.team1.name)}</b></span>
      <span class="pts-val">${fmt(p1)} pts</span>
    </div>
    <div class="preview-row">
      <span><b>${esc(data.team2.name)}</b></span>
      <span class="pts-val">${fmt(p2)} pts</span>
    </div>`;
}

function hdcpAmt(avg, base, pct) {
  return Math.max(0, Math.floor((base - avg) * pct));
}

function closeScoreModal() {
  document.getElementById('score-modal-backdrop').classList.remove('open');
  currentMatchId   = null;
  currentMatchData = null;
}

async function saveScores() {
  if (!currentMatchId || !currentMatchData) return;

  const scores = [];
  const allMembers = [
    ...currentMatchData.team1.members,
    ...currentMatchData.team2.members,
  ];

  for (const m of allMembers) {
    const g1 = document.querySelector(`.game-input[data-member="${m.id}"][data-game="1"]`)?.value;
    const g2 = document.querySelector(`.game-input[data-member="${m.id}"][data-game="2"]`)?.value;
    const g3 = document.querySelector(`.game-input[data-member="${m.id}"][data-game="3"]`)?.value;

    if (g1 === '' || g2 === '' || g3 === '') {
      toast(`Please fill all scores for ${m.name}`, 'error'); return;
    }
    scores.push({
      member_id: m.id,
      game1: parseInt(g1), game2: parseInt(g2), game3: parseInt(g3),
    });
  }

  try {
    await api(`/api/matches/${currentMatchId}/scores`, {
      method: 'POST',
      body: JSON.stringify({ scores }),
    });
    toast('Scores saved');
    closeScoreModal();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

async function clearScores() {
  if (!currentMatchId) return;
  if (!confirm('Clear all scores for this match?')) return;
  try {
    await api(`/api/matches/${currentMatchId}/scores`, { method: 'DELETE' });
    toast('Scores cleared');
    closeScoreModal();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

/* ═══════════════════════════════════════════════
   STANDINGS
═══════════════════════════════════════════════ */
async function loadStandings() {
  if (!currentLeague) return;
  try {
    const data = await api(`/api/leagues/${currentLeague.id}/standings`);
    renderStandings(data);
  } catch (e) { toast(e.message, 'error'); }
}

const MEDALS = ['🥇','🥈','🥉'];

function renderStandings({ teams, summary, last_week }) {
  const tbody = document.getElementById('standings-body');

  if (!teams.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="center text-muted" style="padding:2rem">No data yet</td></tr>`;
    document.getElementById('standings-summary').style.display = 'none';
    return;
  }

  const hdcpOn = currentLeague?.handicap_enabled;

  // Build this-week series lookup by team ID
  const thisWeekMap = {};
  if (last_week && last_week.teams) {
    last_week.teams.forEach(t => { thisWeekMap[t.id] = t; });
  }

  tbody.innerHTML = teams.map((t, i) => {
    // Season record: total of all game + series W/L/T combined
    const totalW = t.game1_w + t.game2_w + t.game3_w + t.series_w;
    const totalL = t.game1_l + t.game2_l + t.game3_l + t.series_l;
    const totalT = t.game1_t + t.game2_t + t.game3_t + t.series_t;

    // This week: W-L-T across all 4 decisions (G1+G2+G3+Series) for the most recent week
    const rec = t.recent || {};
    const hasRec = rec.game1_w !== undefined;
    const twW = hasRec ? rec.game1_w + rec.game2_w + rec.game3_w + rec.series_w : null;
    const twL = hasRec ? rec.game1_l + rec.game2_l + rec.game3_l + rec.series_l : null;
    const twT = hasRec ? rec.game1_t + rec.game2_t + rec.game3_t + rec.series_t : null;
    const thisWeekSeries = (twW !== null && (twW + twL + twT) > 0) ? wlt(twW, twL, twT) : '—';

    return `
      <tr>
        <td class="rank">${i < 3 ? `<span class="rank-medal">${MEDALS[i]}</span>` : i+1}</td>
        <td class="team-nm">${esc(t.name)}</td>
        <td class="center">${t.matches}</td>
        <td class="center record">${thisWeekSeries}</td>
        <td class="center record">${wlt(totalW, totalL, totalT)}</td>
        <td class="pts center">${fmt(t.points)}</td>
        <td class="avg center">${t.game_average || '—'}</td>
      </tr>`;
  }).join('');

  // Summary / Last Week Recap
  const summEl = document.getElementById('standings-summary');
  if (summary.total_matches > 0) {
    summEl.style.display = 'block';
    const hdcpOn = currentLeague?.handicap_enabled;

    // Last week recap
    let recapHtml = '';
    if (last_week && last_week.week > 0) {
      const wk = last_week;

      // Team recap table
      const teamGameKey   = hdcpOn ? 'hdcp_game'   : 'scratch_game';
      const teamSeriesKey = hdcpOn ? 'hdcp_series'  : 'scratch_series';
      const topTeams = [...wk.teams].sort((a,b) => b[teamSeriesKey] - a[teamSeriesKey]).slice(0, 3);
      const teamRows = topTeams.map((t, idx) => `
        <tr>
          <td class="rank">${MEDALS[idx] || idx+1}</td>
          <td class="team-nm">${esc(t.name)}</td>
          <td class="center">${t[teamGameKey]}</td>
          <td class="center avg">${t[teamSeriesKey]}</td>
        </tr>`).join('');

      const indivSection = ['M','F'].map(g => {
        const icon  = g === 'M' ? '♂' : '♀';
        const label = g === 'M' ? "Men's" : "Women's";
        const bowlers = wk.individuals[g] || [];
        const gameKey   = hdcpOn ? 'hdcp_game'   : 'best_game';
        const seriesKey = hdcpOn ? 'hdcp_series'  : 'best_series';
        const rows = bowlers.map((b, idx) => `
          <tr>
            <td class="rank">${MEDALS[idx] || idx+1}</td>
            <td class="team-nm">${esc(b.name)}</td>
            <td class="text-muted" style="font-size:0.8rem">${esc(b.team_name)}</td>
            <td class="center">${b[gameKey]}</td>
            <td class="center avg">${b[seriesKey]}</td>
          </tr>`).join('');
        return `
          <div class="recap-section">
            <div class="recap-section-title">${icon} ${label}</div>
            <table class="recap-table">
              <thead><tr>
                <th class="center">#</th><th>Bowler</th><th>Team</th>
                <th class="center">Hi&nbsp;Game</th><th class="center">Hi&nbsp;Series</th>
              </tr></thead>
              <tbody>${rows || '<tr><td colspan="5" class="center text-muted">No data</td></tr>'}</tbody>
            </table>
          </div>`;
      }).join('');

      recapHtml = `
        <div class="last-week-recap">
          <h3 class="recap-title">Week ${wk.week} Recap</h3>
          <div class="recap-grid">
            <div class="recap-section">
              <div class="recap-section-title">&#127931; Team High Scores</div>
              <table class="recap-table">
                <thead><tr>
                  <th class="center">#</th><th>Team</th>
                  <th class="center">Hi&nbsp;Game</th><th class="center">Hi&nbsp;Series</th>
                </tr></thead>
                <tbody>${teamRows || '<tr><td colspan="4" class="center text-muted">No data</td></tr>'}</tbody>
              </table>
            </div>
            ${indivSection}
          </div>
        </div>`;
    }

    const totalPts = teams.reduce((a, t) => a + t.points, 0);
    summEl.innerHTML = `
      <div class="summary-stats">
        <div class="summary-cell">
          <div class="cell-label">Matches Played</div>
          <div class="cell-value">${summary.total_matches}</div>
        </div>
        <div class="summary-cell">
          <div class="cell-label">Total Points</div>
          <div class="cell-value">${fmt(totalPts)}</div>
        </div>
        ${['game1','game2','game3','series'].map((k, i) => {
          const s   = summary[k];
          const lbl = i < 3 ? `Game ${i+1}` : 'Series';
          const tied = s.ties ? ` · ${s.ties} tied` : '';
          return `<div class="summary-cell">
            <div class="cell-label">${lbl} Decided</div>
            <div class="cell-value">${s.wins}</div>
            ${tied ? `<div class="cell-sub">${s.ties} tied</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${recapHtml}`;
  } else {
    summEl.style.display = 'none';
  }
}

function wlt(w, l, t) {
  if (t) return `${w}-${l}-${t}`;
  return `${w}-${l}`;
}

/* ═══════════════════════════════════════════════
   AVERAGES
═══════════════════════════════════════════════ */
async function loadAverages() {
  if (!currentLeague) return;
  try {
    const rows = await api(`/api/leagues/${currentLeague.id}/averages`);
    renderAverages(rows);
  } catch (e) { toast(e.message, 'error'); }
}

function renderAverages(rows) {
  const tbody  = document.getElementById('averages-body');
  const hdcpOn = currentLeague?.handicap_enabled;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="center text-muted" style="padding:2rem">No bowler data yet</td></tr>`;
    return;
  }

  const sorted = [...rows].sort((a, b) => b.average - a.average);
  tbody.innerHTML = sorted.map(r => {
    const hdcpVal = hdcpOn ? `<span style="color:var(--purple);font-weight:600">${r.handicap || 0}</span>` : '<span class="text-muted">—</span>';
    return `
    <tr>
      <td>${esc(r.name)}</td>
      <td class="text-muted">${esc(r.team_name)}</td>
      <td class="center">${r.gender === 'M' ? '♂' : '♀'}</td>
      <td class="center">${r.games_bowled || '—'}</td>
      <td class="avg center">${r.average || '—'}</td>
      <td class="center">${hdcpVal}</td>
      <td class="center">${r.best_game || '—'}</td>
      <td class="center">${r.best_series || '—'}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   TOP PERFORMERS
═══════════════════════════════════════════════ */
async function loadPerformers() {
  if (!currentLeague) return;
  try {
    const data = await api(`/api/leagues/${currentLeague.id}/top-performers`);
    window._lastPerformers = data;
    renderPerformers(data);
  } catch (e) { toast(e.message, 'error'); }
}

function renderPerformers(data) {
  const grid = document.getElementById('performers-grid');
  if (!data) { grid.innerHTML = ''; return; }

  const hdcpOn  = data.handicap_enabled;

  // Hide handicap toggle if league doesn't use handicap
  document.getElementById('perf-type-toggle').style.display = hdcpOn ? 'flex' : 'none';
  const effectiveType = (hdcpOn && perfType === 'handicap') ? 'handicap' : 'scratch';
  const effectiveSec  = data[effectiveType];

  const indivCats = [
    { key: 'game',   label: "Men's Game",    gender: 'M' },
    { key: 'game',   label: "Women's Game",  gender: 'F' },
    { key: 'series', label: "Men's Series",  gender: 'M' },
    { key: 'series', label: "Women's Series",gender: 'F' },
  ];

  const scoreKey = effectiveType === 'handicap'
    ? { game: 'best_hdcp_game', series: 'best_hdcp_series' }
    : { game: 'best_scratch_game', series: 'best_scratch_series' };

  // Team section
  const teamData   = data.teams || {};
  const teamGameK  = effectiveType === 'handicap' ? 'best_hdcp_game'   : 'best_scratch_game';
  const teamSerK   = effectiveType === 'handicap' ? 'best_hdcp_series'  : 'best_scratch_series';
  const teamLabel  = effectiveType === 'handicap' ? ' (Hdcp)' : '';
  const teamCats   = [
    { key: teamGameK,  label: `Team High Game${teamLabel}`,   src: effectiveType === 'handicap' ? teamData.hdcp_game   : teamData.scratch_game   },
    { key: teamSerK,   label: `Team High Series${teamLabel}`, src: effectiveType === 'handicap' ? teamData.hdcp_series : teamData.scratch_series },
  ];

  const teamHtml = teamCats.map(tc => `
    <div class="performer-card">
      <div class="performer-card-header">&#127931; ${tc.label}</div>
      ${(tc.src || []).length
        ? (tc.src).map((t, i) => `
            <div class="performer-row">
              <div class="perf-rank">${MEDALS[i] || i+1}</div>
              <div class="perf-info">
                <div class="perf-name">${esc(t.name)}</div>
                <div class="perf-team">Team</div>
              </div>
              <div>
                <div class="perf-score">${t[tc.key]}</div>
              </div>
            </div>`).join('')
        : `<div class="perf-empty">No data yet</div>`}
    </div>`).join('');

  const indivHtml = indivCats.map(cat => {
    const performers = (effectiveSec[cat.key]?.[cat.gender]) || [];
    const genderIcon = cat.gender === 'M' ? '♂' : '♀';
    const label      = effectiveType === 'handicap' ? `${cat.label} (Hdcp)` : cat.label;
    return `
      <div class="performer-card">
        <div class="performer-card-header">${genderIcon} ${label}</div>
        ${performers.length
          ? performers.map((p, i) => `
              <div class="performer-row">
                <div class="perf-rank">${MEDALS[i] || i+1}</div>
                <div class="perf-info">
                  <div class="perf-name">${esc(p.name)}</div>
                  <div class="perf-team">${esc(p.team_name)}</div>
                </div>
                <div>
                  <div class="perf-score">${p[scoreKey[cat.key]]}</div>
                  <div class="perf-avg">Avg ${p.average}${hdcpOn ? ` · Hdcp ${p.handicap}` : ''}</div>
                </div>
              </div>`).join('')
          : `<div class="perf-empty">No data yet</div>`}
      </div>`;
  }).join('');

  grid.innerHTML = `
    <div class="perf-section-label">Team Records</div>
    ${teamHtml}
    <div class="perf-section-label">Individual Records</div>
    ${indivHtml}`;
}

/* ═══════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════ */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
