/* ===== State ===== */
let teams = [];
let schedule = [];
let editingTeamId = null;
let pendingMembers = [];   // for team modal
let scoreMatchId = null;

/* ===== Bootstrap ===== */
document.addEventListener('DOMContentLoaded', () => {
  // Tab routing
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Team modal
  document.getElementById('btn-add-team').addEventListener('click', openAddTeam);
  document.getElementById('team-modal-close').addEventListener('click', closeTeamModal);
  document.getElementById('team-modal-cancel').addEventListener('click', closeTeamModal);
  document.getElementById('team-modal-save').addEventListener('click', saveTeam);
  document.getElementById('btn-add-member').addEventListener('click', addMemberFromInput);
  document.getElementById('member-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addMemberFromInput(); }
  });
  document.getElementById('team-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('team-modal-backdrop')) closeTeamModal();
  });

  // Score modal
  document.getElementById('score-modal-close').addEventListener('click', closeScoreModal);
  document.getElementById('score-modal-cancel').addEventListener('click', closeScoreModal);
  document.getElementById('score-modal-save').addEventListener('click', saveScores);
  document.getElementById('score-modal-clear').addEventListener('click', clearScores);
  document.getElementById('score-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('score-modal-backdrop')) closeScoreModal();
  });
  ['t1g1','t1g2','t1g3','t2g1','t2g2','t2g3'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateScorePreview);
  });

  // Schedule generation
  document.getElementById('btn-generate').addEventListener('click', generateSchedule);

  loadTeams();
  loadSchedule();
  loadStandings();
});

/* ===== Tabs ===== */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'standings') loadStandings();
  if (tab === 'schedule') loadSchedule();
}

/* ===== Toast ===== */
function toast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ===== API helpers ===== */
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ===== Teams ===== */
async function loadTeams() {
  try {
    teams = await api('/api/teams');
    renderTeams();
  } catch (e) { toast(e.message, 'error'); }
}

function renderTeams() {
  const grid = document.getElementById('teams-grid');
  if (!teams.length) {
    grid.innerHTML = `<div class="empty-state"><p>No teams yet. Add one to get started!</p></div>`;
    return;
  }
  grid.innerHTML = teams.map(t => `
    <div class="team-card">
      <div class="team-card-header">
        <div class="team-name">${esc(t.name)}</div>
        <div class="team-actions">
          <button class="btn btn-ghost btn-sm" onclick="openEditTeam(${t.id})" title="Edit">&#9998;</button>
          <button class="btn btn-ghost btn-sm" onclick="confirmDeleteTeam(${t.id}, '${esc(t.name)}')" title="Delete" style="color:var(--red)">&#128465;</button>
        </div>
      </div>
      ${t.members.length
        ? `<ul class="members-list">${t.members.map(m => `<li class="member-chip">${esc(m.name)}</li>`).join('')}</ul>`
        : `<span class="no-members">No members</span>`}
    </div>
  `).join('');
}

function openAddTeam() {
  editingTeamId = null;
  pendingMembers = [];
  document.getElementById('team-modal-title').textContent = 'Add Team';
  document.getElementById('team-name-input').value = '';
  document.getElementById('member-input').value = '';
  renderMemberTags();
  document.getElementById('team-modal-backdrop').classList.add('open');
  document.getElementById('team-name-input').focus();
}

function openEditTeam(id) {
  const team = teams.find(t => t.id === id);
  if (!team) return;
  editingTeamId = id;
  pendingMembers = team.members.map(m => m.name);
  document.getElementById('team-modal-title').textContent = 'Edit Team';
  document.getElementById('team-name-input').value = team.name;
  document.getElementById('member-input').value = '';
  renderMemberTags();
  document.getElementById('team-modal-backdrop').classList.add('open');
  document.getElementById('team-name-input').focus();
}

function closeTeamModal() {
  document.getElementById('team-modal-backdrop').classList.remove('open');
}

function addMemberFromInput() {
  const input = document.getElementById('member-input');
  const name = input.value.trim();
  if (!name) return;
  if (!pendingMembers.includes(name)) {
    pendingMembers.push(name);
    renderMemberTags();
  }
  input.value = '';
  input.focus();
}

function removeMember(name) {
  pendingMembers = pendingMembers.filter(m => m !== name);
  renderMemberTags();
}

function renderMemberTags() {
  document.getElementById('member-tags').innerHTML = pendingMembers.map(m => `
    <span class="member-tag">${esc(m)}<button onclick="removeMember('${esc(m)}')" title="Remove">&times;</button></span>
  `).join('');
}

async function saveTeam() {
  const name = document.getElementById('team-name-input').value.trim();
  if (!name) { toast('Team name is required', 'error'); return; }

  const body = { name, members: pendingMembers };
  try {
    if (editingTeamId) {
      await api(`/api/teams/${editingTeamId}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Team updated');
    } else {
      await api('/api/teams', { method: 'POST', body: JSON.stringify(body) });
      toast('Team added');
    }
    closeTeamModal();
    await loadTeams();
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmDeleteTeam(id, name) {
  if (!confirm(`Delete team "${name}"? This will also remove their schedule entries and scores.`)) return;
  try {
    await api(`/api/teams/${id}`, { method: 'DELETE' });
    toast('Team deleted');
    await loadTeams();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

/* ===== Schedule ===== */
async function loadSchedule() {
  try {
    schedule = await api('/api/schedule');
    renderSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSchedule() {
  const container = document.getElementById('schedule-list');
  if (!schedule.length) {
    container.innerHTML = `<div class="empty-state"><p>No schedule yet. Add teams and generate a schedule above.</p></div>`;
    return;
  }

  // Group by week
  const byWeek = {};
  schedule.forEach(m => {
    if (!byWeek[m.week]) byWeek[m.week] = [];
    byWeek[m.week].push(m);
  });

  container.innerHTML = Object.entries(byWeek).map(([week, matches]) => `
    <div class="week-group">
      <div class="week-label">Week ${week}</div>
      ${matches.map(m => matchRowHtml(m)).join('')}
    </div>
  `).join('');
}

function matchRowHtml(m) {
  let scoreSummary = '';
  let statusHtml = `<span class="score-status pending">Pending</span>`;

  if (m.scores) {
    const s = m.scores;
    const [pts1, pts2] = calcPoints(s);
    const t1s = (s.team1_g1||0) + (s.team1_g2||0) + (s.team1_g3||0);
    const t2s = (s.team2_g1||0) + (s.team2_g2||0) + (s.team2_g3||0);
    scoreSummary = `<span class="match-score-summary">${t1s}–${t2s} &nbsp;(<span class="pts">${pts1}–${pts2}</span> pts)</span>`;
    statusHtml = `<span class="score-status entered">Entered</span>`;
  }

  return `
    <div class="match-row ${m.scores ? 'has-scores' : ''}" onclick="openScoreModal(${m.id})">
      <div class="match-teams">
        <span>${esc(m.team1_name)}</span>
        <span class="vs-badge">vs</span>
        <span>${esc(m.team2_name)}</span>
      </div>
      ${scoreSummary}
      ${statusHtml}
    </div>
  `;
}

async function generateSchedule() {
  const weeksInput = document.getElementById('weeks-input').value;
  const weeks = weeksInput ? parseInt(weeksInput) : null;
  if (schedule.length && !confirm('This will replace the current schedule. Entered scores will be deleted. Continue?')) return;
  try {
    const res = await api('/api/schedule/generate', {
      method: 'POST',
      body: JSON.stringify({ weeks }),
    });
    toast(`Schedule generated — ${res.weeks} week${res.weeks !== 1 ? 's' : ''}`);
    await loadSchedule();
    await loadStandings();
  } catch (e) { toast(e.message, 'error'); }
}

/* ===== Score Modal ===== */
function openScoreModal(matchId) {
  const match = schedule.find(m => m.id === matchId);
  if (!match) return;
  scoreMatchId = matchId;

  document.getElementById('score-modal-title').textContent =
    `${match.team1_name}  vs  ${match.team2_name}`;
  document.getElementById('score-team1-label').textContent = match.team1_name;
  document.getElementById('score-team2-label').textContent = match.team2_name;

  const s = match.scores || {};
  document.getElementById('t1g1').value = s.team1_g1 ?? '';
  document.getElementById('t1g2').value = s.team1_g2 ?? '';
  document.getElementById('t1g3').value = s.team1_g3 ?? '';
  document.getElementById('t2g1').value = s.team2_g1 ?? '';
  document.getElementById('t2g2').value = s.team2_g2 ?? '';
  document.getElementById('t2g3').value = s.team2_g3 ?? '';

  updateScorePreview();
  document.getElementById('score-modal-backdrop').classList.add('open');
}

function closeScoreModal() {
  document.getElementById('score-modal-backdrop').classList.remove('open');
  scoreMatchId = null;
}

function getScoreInputs() {
  return {
    team1_g1: intOrNull('t1g1'),
    team1_g2: intOrNull('t1g2'),
    team1_g3: intOrNull('t1g3'),
    team2_g1: intOrNull('t2g1'),
    team2_g2: intOrNull('t2g2'),
    team2_g3: intOrNull('t2g3'),
  };
}

function intOrNull(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : parseInt(v);
}

function calcPoints(s) {
  let p1 = 0, p2 = 0;
  const games = [
    [s.team1_g1||0, s.team2_g1||0],
    [s.team1_g2||0, s.team2_g2||0],
    [s.team1_g3||0, s.team2_g3||0],
  ];
  games.forEach(([a, b]) => {
    if (a > b) p1++;
    else if (b > a) p2++;
  });
  const t1s = games.reduce((acc, [a]) => acc + a, 0);
  const t2s = games.reduce((acc, [, b]) => acc + b, 0);
  if (t1s > t2s) p1++;
  else if (t2s > t1s) p2++;
  return [p1, p2];
}

function updateScorePreview() {
  const s = getScoreInputs();
  const filled = Object.values(s).every(v => v !== null);
  const preview = document.getElementById('score-preview');
  if (!filled) { preview.classList.remove('visible'); return; }

  const match = schedule.find(m => m.id === scoreMatchId);
  const [p1, p2] = calcPoints(s);
  const t1s = (s.team1_g1||0) + (s.team1_g2||0) + (s.team1_g3||0);
  const t2s = (s.team2_g1||0) + (s.team2_g2||0) + (s.team2_g3||0);

  preview.classList.add('visible');
  preview.innerHTML = `
    <div class="score-preview-row">
      <span>${match ? esc(match.team1_name) : 'Team 1'}</span>
      <span>Series: ${t1s} &nbsp; Points: <span class="pts-val">${p1}</span></span>
    </div>
    <div class="score-preview-row">
      <span>${match ? esc(match.team2_name) : 'Team 2'}</span>
      <span>Series: ${t2s} &nbsp; Points: <span class="pts-val">${p2}</span></span>
    </div>
  `;
}

async function saveScores() {
  if (!scoreMatchId) return;
  const data = getScoreInputs();
  const allFilled = Object.values(data).every(v => v !== null);
  if (!allFilled) { toast('Please fill in all 6 game scores', 'error'); return; }
  const anyNegative = Object.values(data).some(v => v < 0);
  if (anyNegative) { toast('Scores must be 0 or higher', 'error'); return; }

  try {
    await api(`/api/scores/${scoreMatchId}`, { method: 'POST', body: JSON.stringify(data) });
    toast('Scores saved');
    closeScoreModal();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

async function clearScores() {
  if (!scoreMatchId) return;
  if (!confirm('Clear scores for this match?')) return;
  try {
    await api(`/api/scores/${scoreMatchId}`, { method: 'DELETE' });
    toast('Scores cleared');
    closeScoreModal();
    await loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}

/* ===== Standings ===== */
async function loadStandings() {
  try {
    const standings = await api('/api/standings');
    renderStandings(standings);
  } catch (e) { toast(e.message, 'error'); }
}

const MEDALS = ['🥇', '🥈', '🥉'];

function renderStandings(data) {
  const tbody = document.getElementById('standings-body');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:2rem">No data yet</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((t, i) => `
    <tr>
      <td class="rank">${i < 3 ? `<span class="rank-medal">${MEDALS[i]}</span>` : i + 1}</td>
      <td class="team-name-td">${esc(t.name)}</td>
      <td>${t.matches}</td>
      <td class="record">${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ''}</td>
      <td class="pts">${t.points}</td>
      <td class="avg">${t.game_average || '—'}</td>
      <td class="avg">${t.series_average || '—'}</td>
    </tr>
  `).join('');
}

/* ===== Utils ===== */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
