from flask import Flask, jsonify, request, render_template
import sqlite3
import random
import os

app = Flask(__name__)
DB = 'bowling.db'


def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with get_db() as conn:
        existing = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        # Migrate from v1 schema (no leagues table)
        if 'leagues' not in existing:
            conn.executescript(
                'DROP TABLE IF EXISTS scores;'
                'DROP TABLE IF EXISTS schedule;'
                'DROP TABLE IF EXISTS members;'
                'DROP TABLE IF EXISTS teams;'
            )
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS leagues (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                handicap_enabled INTEGER NOT NULL DEFAULT 0,
                handicap_base    INTEGER NOT NULL DEFAULT 200,
                handicap_pct     REAL    NOT NULL DEFAULT 0.8
            );
            CREATE TABLE IF NOT EXISTS teams (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                league_id INTEGER NOT NULL,
                name      TEXT    NOT NULL,
                FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS members (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                team_id INTEGER NOT NULL,
                name    TEXT    NOT NULL,
                gender  TEXT    NOT NULL DEFAULT 'M',
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS schedule (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                league_id INTEGER NOT NULL,
                week      INTEGER NOT NULL,
                team1_id  INTEGER NOT NULL,
                team2_id  INTEGER NOT NULL,
                FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
                FOREIGN KEY (team1_id)  REFERENCES teams(id)   ON DELETE CASCADE,
                FOREIGN KEY (team2_id)  REFERENCES teams(id)   ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS bowler_scores (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                schedule_id INTEGER NOT NULL,
                member_id   INTEGER NOT NULL,
                game1       INTEGER,
                game2       INTEGER,
                game3       INTEGER,
                UNIQUE(schedule_id, member_id),
                FOREIGN KEY (schedule_id) REFERENCES schedule(id)  ON DELETE CASCADE,
                FOREIGN KEY (member_id)   REFERENCES members(id)   ON DELETE CASCADE
            );
        ''')


# ─── Internal helpers ────────────────────────────────────────────────────────

def _get_league(conn, lid):
    return conn.execute('SELECT * FROM leagues WHERE id=?', (lid,)).fetchone()


def _hdcp(avg, base, pct):
    """Per-game handicap for a single bowler."""
    return max(0, int((base - avg) * pct))


def _bowler_stats(conn, league_id):
    """
    Returns {member_id: {avg, games_bowled, series_bowled, total_pins}} for
    every bowler who has at least one entry in this league.
    """
    rows = conn.execute('''
        SELECT bs.member_id,
               SUM(COALESCE(bs.game1,0) + COALESCE(bs.game2,0) + COALESCE(bs.game3,0)) AS total_pins,
               COUNT(*) AS series_count
        FROM bowler_scores bs
        JOIN schedule s ON bs.schedule_id = s.id
        WHERE s.league_id = ?
        GROUP BY bs.member_id
    ''', (league_id,)).fetchall()

    result = {}
    for r in rows:
        sc = r['series_count'] or 1
        total = r['total_pins'] or 0
        result[r['member_id']] = {
            'avg':          round(total / (sc * 3), 2),
            'total_pins':   total,
            'games_bowled': sc * 3,
            'series_bowled': sc,
        }

    # Best game and best series per bowler (separate pass so we can use MAX)
    bests = conn.execute('''
        SELECT bs.member_id,
               MAX(bs.game1) AS mx1, MAX(bs.game2) AS mx2, MAX(bs.game3) AS mx3,
               MAX(COALESCE(bs.game1,0)+COALESCE(bs.game2,0)+COALESCE(bs.game3,0)) AS mx_series
        FROM bowler_scores bs
        JOIN schedule s ON bs.schedule_id = s.id
        WHERE s.league_id = ?
        GROUP BY bs.member_id
    ''', (league_id,)).fetchall()

    for r in bests:
        mid = r['member_id']
        if mid in result:
            result[mid]['best_game']   = max(r['mx1'] or 0, r['mx2'] or 0, r['mx3'] or 0)
            result[mid]['best_series'] = r['mx_series'] or 0

    return result


def _match_result(conn, match_id, league, bowler_stats=None):
    """
    Compute points, scratch/adjusted totals for a match.
    Returns a dict or None if no scores exist yet.

    Points: 1 pt per game won + 1 pt for series.  Ties award 0.5 to each side.
    If handicap is enabled, adjusted totals are used for comparison.
    """
    hdcp_on  = bool(league['handicap_enabled'])
    base     = int(league['handicap_base'])
    pct      = float(league['handicap_pct'])
    lid      = league['id']

    match = conn.execute('SELECT * FROM schedule WHERE id=?', (match_id,)).fetchone()
    if not match:
        return None

    rows = conn.execute('''
        SELECT bs.member_id, bs.game1, bs.game2, bs.game3, m.team_id
        FROM bowler_scores bs
        JOIN members m ON bs.member_id = m.id
        WHERE bs.schedule_id = ?
    ''', (match_id,)).fetchall()

    if not rows:
        return None

    t1_rows = [r for r in rows if r['team_id'] == match['team1_id']]
    t2_rows = [r for r in rows if r['team_id'] == match['team2_id']]
    if not t1_rows or not t2_rows:
        return None

    if bowler_stats is None:
        bowler_stats = _bowler_stats(conn, lid)

    # Per-game team handicap = sum of individual bowler handicaps
    def team_hdcp(brows):
        if not hdcp_on:
            return 0
        total = 0
        for r in brows:
            avg = bowler_stats.get(r['member_id'], {}).get('avg', base)
            total += _hdcp(avg, base, pct)
        return total

    t1_hdcp = team_hdcp(t1_rows)
    t2_hdcp = team_hdcp(t2_rows)

    t1_pts, t2_pts = 0.0, 0.0
    game_results   = []   # 1=t1 won, 2=t2 won, 0=tie
    t1_scratch     = []
    t2_scratch     = []

    for g in range(1, 4):
        t1g = sum(r[f'game{g}'] or 0 for r in t1_rows)
        t2g = sum(r[f'game{g}'] or 0 for r in t2_rows)
        t1_scratch.append(t1g)
        t2_scratch.append(t2g)

        c1, c2 = (t1g + t1_hdcp, t2g + t2_hdcp) if hdcp_on else (t1g, t2g)
        if c1 > c2:
            t1_pts += 1;   game_results.append(1)
        elif c2 > c1:
            t2_pts += 1;   game_results.append(2)
        else:
            t1_pts += 0.5; t2_pts += 0.5; game_results.append(0)

    t1_series = sum(t1_scratch)
    t2_series = sum(t2_scratch)
    t1_adj    = t1_series + t1_hdcp * 3
    t2_adj    = t2_series + t2_hdcp * 3

    cs1, cs2 = (t1_adj, t2_adj) if hdcp_on else (t1_series, t2_series)
    if cs1 > cs2:
        t1_pts += 1;   series_result = 1
    elif cs2 > cs1:
        t2_pts += 1;   series_result = 2
    else:
        t1_pts += 0.5; t2_pts += 0.5; series_result = 0

    return {
        't1_pts': t1_pts,  't2_pts': t2_pts,
        'game_results':  game_results,
        'series_result': series_result,
        't1_scratch_games': t1_scratch, 't2_scratch_games': t2_scratch,
        't1_series': t1_series, 't2_series': t2_series,
        't1_adj': t1_adj,   't2_adj': t2_adj,
        't1_hdcp': t1_hdcp, 't2_hdcp': t2_hdcp,
    }


def _round_robin(team_ids):
    teams = list(team_ids)
    random.shuffle(teams)
    if len(teams) % 2 == 1:
        teams.append(None)
    n = len(teams)
    rounds = []
    for _ in range(n - 1):
        pairs = [
            (teams[i], teams[n - 1 - i])
            for i in range(n // 2)
            if teams[i] is not None and teams[n - 1 - i] is not None
        ]
        rounds.append(pairs)
        teams = [teams[0]] + [teams[-1]] + teams[1:-1]
    return rounds


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# Leagues ─────────────────────────────────────────────────────────────────────

@app.route('/api/leagues', methods=['GET'])
def get_leagues():
    with get_db() as conn:
        rows = conn.execute('SELECT * FROM leagues ORDER BY name').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/leagues', methods=['POST'])
def create_league():
    d    = request.json or {}
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Name required'}), 400
    try:
        with get_db() as conn:
            cur = conn.execute(
                'INSERT INTO leagues (name,handicap_enabled,handicap_base,handicap_pct) VALUES (?,?,?,?)',
                (name, int(bool(d.get('handicap_enabled', False))),
                 int(d.get('handicap_base', 200)), float(d.get('handicap_pct', 0.8)))
            )
        return jsonify({'id': cur.lastrowid, 'name': name}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'League name already exists'}), 409


@app.route('/api/leagues/<int:lid>', methods=['PUT'])
def update_league(lid):
    d    = request.json or {}
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Name required'}), 400
    try:
        with get_db() as conn:
            conn.execute(
                'UPDATE leagues SET name=?,handicap_enabled=?,handicap_base=?,handicap_pct=? WHERE id=?',
                (name, int(bool(d.get('handicap_enabled', False))),
                 int(d.get('handicap_base', 200)), float(d.get('handicap_pct', 0.8)), lid)
            )
        return jsonify({'success': True})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'League name already exists'}), 409


@app.route('/api/leagues/<int:lid>', methods=['DELETE'])
def delete_league(lid):
    with get_db() as conn:
        conn.execute('DELETE FROM leagues WHERE id=?', (lid,))
    return jsonify({'success': True})


# Teams ───────────────────────────────────────────────────────────────────────

@app.route('/api/leagues/<int:lid>/teams', methods=['GET'])
def get_teams(lid):
    with get_db() as conn:
        league = _get_league(conn, lid)
        bstats = _bowler_stats(conn, lid)
        hdcp_on = bool(league['handicap_enabled']) if league else False
        base    = int(league['handicap_base'])     if league else 200
        pct     = float(league['handicap_pct'])    if league else 0.8

        teams = conn.execute(
            'SELECT * FROM teams WHERE league_id=? ORDER BY name', (lid,)
        ).fetchall()
        result = []
        for t in teams:
            mems = conn.execute(
                'SELECT * FROM members WHERE team_id=? ORDER BY name', (t['id'],)
            ).fetchall()
            members_out = []
            for m in mems:
                s   = bstats.get(m['id'], {})
                avg = s.get('avg', 0)
                members_out.append({
                    'id': m['id'], 'name': m['name'], 'gender': m['gender'],
                    'average':  avg,
                    'handicap': _hdcp(avg, base, pct) if hdcp_on else None,
                    'games_bowled': s.get('games_bowled', 0),
                })
            result.append({
                'id': t['id'], 'league_id': t['league_id'], 'name': t['name'],
                'members': members_out,
            })
    return jsonify(result)


@app.route('/api/leagues/<int:lid>/teams', methods=['POST'])
def create_team(lid):
    d    = request.json or {}
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Team name required'}), 400
    with get_db() as conn:
        cur     = conn.execute('INSERT INTO teams (league_id,name) VALUES (?,?)', (lid, name))
        team_id = cur.lastrowid
        for m in d.get('members', []):
            mn = (m if isinstance(m, str) else m.get('name', '')).strip()
            g  = m.get('gender', 'M') if isinstance(m, dict) else 'M'
            if mn:
                conn.execute('INSERT INTO members (team_id,name,gender) VALUES (?,?,?)', (team_id, mn, g))
    return jsonify({'id': team_id, 'name': name}), 201


@app.route('/api/teams/<int:tid>', methods=['PUT'])
def update_team(tid):
    d    = request.json or {}
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Team name required'}), 400
    with get_db() as conn:
        conn.execute('UPDATE teams SET name=? WHERE id=?', (name, tid))
        if 'members' in d:
            conn.execute('DELETE FROM members WHERE team_id=?', (tid,))
            for m in d['members']:
                mn = (m if isinstance(m, str) else m.get('name', '')).strip()
                g  = m.get('gender', 'M') if isinstance(m, dict) else 'M'
                if mn:
                    conn.execute('INSERT INTO members (team_id,name,gender) VALUES (?,?,?)', (tid, mn, g))
    return jsonify({'success': True})


@app.route('/api/teams/<int:tid>', methods=['DELETE'])
def delete_team(tid):
    with get_db() as conn:
        conn.execute('DELETE FROM teams WHERE id=?', (tid,))
    return jsonify({'success': True})


# Template league ─────────────────────────────────────────────────────────────

_TEAM_NAMES = [
    "Pin Crushers", "Strike Force", "Spare Parts", "Lane Rangers",
    "Gutter Gang", "Rolling Thunder", "The Splits", "Turkey Club",
    "Perfect Game", "Lucky Frames",
]
_MALE_NAMES = [
    "James","John","Robert","Michael","William",
    "David","Richard","Joseph","Thomas","Charles",
    "Daniel","Matthew","Andrew","Kevin","Brian",
]
_FEMALE_NAMES = [
    "Mary","Patricia","Jennifer","Linda","Barbara",
    "Elizabeth","Susan","Jessica","Sarah","Karen",
    "Lisa","Nancy","Betty","Sandra","Ashley",
]

@app.route('/api/leagues/template', methods=['POST'])
def create_template_league():
    d    = request.json or {}
    name = d.get('name', 'Template League').strip() or 'Template League'

    # Build unique name pools by cycling through the lists
    all_male   = (_MALE_NAMES   * 2)[:20]
    all_female = (_FEMALE_NAMES * 2)[:10]
    random.shuffle(all_male)
    random.shuffle(all_female)
    male_pool   = iter(all_male)
    female_pool = iter(all_female)

    with get_db() as conn:
        try:
            cur = conn.execute(
                'INSERT INTO leagues (name,handicap_enabled,handicap_base,handicap_pct) VALUES (?,?,?,?)',
                (name,
                 int(bool(d.get('handicap_enabled', False))),
                 int(d.get('handicap_base', 200)),
                 float(d.get('handicap_pct', 0.8)))
            )
            lid = cur.lastrowid
        except sqlite3.IntegrityError:
            return jsonify({'error': f'League "{name}" already exists'}), 409

        # 10 teams × 3 bowlers (M/F/M pattern)
        team_ids      = []
        member_grid   = {}
        genders_cycle = ['M', 'F', 'M']

        for tname in _TEAM_NAMES:
            cur = conn.execute('INSERT INTO teams (league_id,name) VALUES (?,?)', (lid, tname))
            tid = cur.lastrowid
            team_ids.append(tid)
            member_grid[tid] = []
            for g in genders_cycle:
                bname = next(male_pool if g == 'M' else female_pool)
                cur2  = conn.execute(
                    'INSERT INTO members (team_id,name,gender) VALUES (?,?,?)', (tid, bname, g)
                )
                member_grid[tid].append(cur2.lastrowid)

        # 10-week schedule via round-robin (9 base rounds + 1 repeat)
        base_rounds = _round_robin(team_ids)
        rounds      = (base_rounds + [base_rounds[0]])[:10]

        for wk, pairs in enumerate(rounds, 1):
            for t1, t2 in pairs:
                cur = conn.execute(
                    'INSERT INTO schedule (league_id,week,team1_id,team2_id) VALUES (?,?,?,?)',
                    (lid, wk, t1, t2)
                )
                sched_id = cur.lastrowid
                # Random scores 1–300 for each bowler on both teams
                for mid in member_grid[t1] + member_grid[t2]:
                    conn.execute(
                        'INSERT INTO bowler_scores (schedule_id,member_id,game1,game2,game3) VALUES (?,?,?,?,?)',
                        (sched_id, mid,
                         random.randint(1, 300),
                         random.randint(1, 300),
                         random.randint(1, 300))
                    )

    return jsonify({'success': True, 'league_id': lid, 'name': name}), 201


# Schedule ────────────────────────────────────────────────────────────────────

@app.route('/api/leagues/<int:lid>/schedule', methods=['GET'])
def get_schedule(lid):
    with get_db() as conn:
        league = _get_league(conn, lid)
        if not league:
            return jsonify({'error': 'League not found'}), 404

        rows = conn.execute('''
            SELECT s.id, s.week,
                   t1.id AS t1_id, t1.name AS t1_name,
                   t2.id AS t2_id, t2.name AS t2_name
            FROM schedule s
            JOIN teams t1 ON s.team1_id = t1.id
            JOIN teams t2 ON s.team2_id = t2.id
            WHERE s.league_id = ?
            ORDER BY s.week, s.id
        ''', (lid,)).fetchall()

        # Matches that have at least one bowler score
        scored = {r[0] for r in conn.execute('''
            SELECT DISTINCT s.id FROM schedule s
            JOIN bowler_scores bs ON bs.schedule_id = s.id
            WHERE s.league_id = ?
        ''', (lid,)).fetchall()}

        bstats = _bowler_stats(conn, lid) if scored else {}

        result = []
        for r in rows:
            mid = r['id']
            entry = {
                'id': mid, 'week': r['week'],
                'team1_id': r['t1_id'], 'team1_name': r['t1_name'],
                'team2_id': r['t2_id'], 'team2_name': r['t2_name'],
                'has_scores': mid in scored,
                'result': None,
            }
            if mid in scored:
                res = _match_result(conn, mid, league, bstats)
                if res:
                    entry['result'] = {
                        't1_pts': res['t1_pts'], 't2_pts': res['t2_pts'],
                        't1_series': res['t1_series'], 't2_series': res['t2_series'],
                        't1_adj': res['t1_adj'],   't2_adj': res['t2_adj'],
                    }
            result.append(entry)
    return jsonify(result)


@app.route('/api/leagues/<int:lid>/schedule/generate', methods=['POST'])
def generate_schedule(lid):
    d = request.json or {}
    weeks = d.get('weeks')
    with get_db() as conn:
        tids = [r['id'] for r in conn.execute(
            'SELECT id FROM teams WHERE league_id=?', (lid,)
        ).fetchall()]
        if len(tids) < 2:
            return jsonify({'error': 'Need at least 2 teams'}), 400

        base   = _round_robin(tids)
        rounds = base

        if weeks and int(weeks) > 0:
            target = int(weeks)
            rounds = []
            passes = [base, list(reversed(base))]
            i = 0
            while len(rounds) < target:
                rounds += passes[i % 2]
                i += 1
            rounds = rounds[:target]

        conn.execute('DELETE FROM schedule WHERE league_id=?', (lid,))
        for wk, pairs in enumerate(rounds, 1):
            for t1, t2 in pairs:
                conn.execute(
                    'INSERT INTO schedule (league_id,week,team1_id,team2_id) VALUES (?,?,?,?)',
                    (lid, wk, t1, t2)
                )
    return jsonify({'success': True, 'weeks': len(rounds)})


# Match detail (for score-entry modal) ────────────────────────────────────────

@app.route('/api/matches/<int:mid>', methods=['GET'])
def get_match(mid):
    with get_db() as conn:
        match = conn.execute('''
            SELECT s.id, s.week, s.league_id, s.team1_id, s.team2_id,
                   t1.name AS t1_name, t2.name AS t2_name
            FROM schedule s
            JOIN teams t1 ON s.team1_id = t1.id
            JOIN teams t2 ON s.team2_id = t2.id
            WHERE s.id = ?
        ''', (mid,)).fetchone()
        if not match:
            return jsonify({'error': 'Match not found'}), 404

        league  = _get_league(conn, match['league_id'])
        bstats  = _bowler_stats(conn, match['league_id'])

        existing = {
            r['member_id']: dict(r)
            for r in conn.execute(
                'SELECT * FROM bowler_scores WHERE schedule_id=?', (mid,)
            ).fetchall()
        }

        def enrich_team(team_id):
            mems = conn.execute(
                'SELECT * FROM members WHERE team_id=? ORDER BY name', (team_id,)
            ).fetchall()
            out = []
            for m in mems:
                stats = bstats.get(m['id'], {})
                avg   = stats.get('avg', 0)
                h     = _hdcp(avg, int(league['handicap_base']), float(league['handicap_pct'])) \
                        if league['handicap_enabled'] else 0
                s = existing.get(m['id'], {})
                out.append({
                    'id': m['id'], 'name': m['name'], 'gender': m['gender'],
                    'average': avg, 'handicap': h,
                    'games_bowled': stats.get('games_bowled', 0),
                    'game1': s.get('game1'), 'game2': s.get('game2'), 'game3': s.get('game3'),
                })
            return out

    return jsonify({
        'id': match['id'], 'week': match['week'],
        'league_id': match['league_id'],
        'team1': {'id': match['team1_id'], 'name': match['t1_name'], 'members': enrich_team(match['team1_id'])},
        'team2': {'id': match['team2_id'], 'name': match['t2_name'], 'members': enrich_team(match['team2_id'])},
        'league': dict(league),
    })


# Scores ──────────────────────────────────────────────────────────────────────

@app.route('/api/matches/<int:mid>/scores', methods=['POST'])
def save_scores(mid):
    d      = request.json or {}
    scores = d.get('scores', [])
    with get_db() as conn:
        match = conn.execute('SELECT * FROM schedule WHERE id=?', (mid,)).fetchone()
        if not match:
            return jsonify({'error': 'Match not found'}), 404
        for s in scores:
            conn.execute('''
                INSERT INTO bowler_scores (schedule_id, member_id, game1, game2, game3)
                VALUES (?,?,?,?,?)
                ON CONFLICT(schedule_id, member_id) DO UPDATE
                SET game1=excluded.game1, game2=excluded.game2, game3=excluded.game3
            ''', (mid, s['member_id'], s.get('game1'), s.get('game2'), s.get('game3')))
        league = _get_league(conn, match['league_id'])
        result = _match_result(conn, mid, league)
    return jsonify({'success': True, 'result': result})


@app.route('/api/matches/<int:mid>/scores', methods=['DELETE'])
def delete_scores(mid):
    with get_db() as conn:
        conn.execute('DELETE FROM bowler_scores WHERE schedule_id=?', (mid,))
    return jsonify({'success': True})


# Standings ───────────────────────────────────────────────────────────────────

@app.route('/api/leagues/<int:lid>/standings', methods=['GET'])
def get_standings(lid):
    with get_db() as conn:
        league = _get_league(conn, lid)
        if not league:
            return jsonify({'error': 'League not found'}), 404

        teams = conn.execute(
            'SELECT * FROM teams WHERE league_id=? ORDER BY name', (lid,)
        ).fetchall()

        # ── per-team accumulators ──
        tm = {t['id']: {
            'id': t['id'], 'name': t['name'],
            'points': 0.0, 'matches': 0,
            'wins': 0, 'losses': 0, 'ties': 0,
            'game1_w': 0, 'game1_l': 0, 'game1_t': 0,
            'game2_w': 0, 'game2_l': 0, 'game2_t': 0,
            'game3_w': 0, 'game3_l': 0, 'game3_t': 0,
            'series_w': 0, 'series_l': 0, 'series_t': 0,
            'total_pins': 0, 'games_bowled': 0,
        } for t in teams}

        recent = {t['id']: {
            'wins': 0, 'losses': 0, 'ties': 0,
            'game1_w': 0, 'game1_l': 0, 'game1_t': 0,
            'game2_w': 0, 'game2_l': 0, 'game2_t': 0,
            'game3_w': 0, 'game3_l': 0, 'game3_t': 0,
            'series_w': 0, 'series_l': 0, 'series_t': 0,
        } for t in teams}

        summary = {
            'total_matches': 0,
            'game1':  {'wins': 0, 'ties': 0},
            'game2':  {'wins': 0, 'ties': 0},
            'game3':  {'wins': 0, 'ties': 0},
            'series': {'wins': 0, 'ties': 0},
        }

        matches = conn.execute('''
            SELECT s.id, s.week, s.team1_id, s.team2_id
            FROM schedule s
            WHERE s.league_id = ?
              AND EXISTS (SELECT 1 FROM bowler_scores b WHERE b.schedule_id = s.id)
            ORDER BY s.week
        ''', (lid,)).fetchall()

        most_recent_week = max((m['week'] for m in matches), default=0)
        bstats = _bowler_stats(conn, lid)

        for m in matches:
            t1, t2 = m['team1_id'], m['team2_id']
            if t1 not in tm or t2 not in tm:
                continue

            res = _match_result(conn, m['id'], league, bstats)
            if not res:
                continue

            summary['total_matches'] += 1

            # ── game breakdown ──
            for gi, gr in enumerate(res['game_results'], 1):
                key = f'game{gi}'
                if gr == 1:
                    summary[key]['wins'] += 1
                    tm[t1][f'{key}_w'] += 1;  tm[t2][f'{key}_l'] += 1
                elif gr == 2:
                    summary[key]['wins'] += 1
                    tm[t2][f'{key}_w'] += 1;  tm[t1][f'{key}_l'] += 1
                else:
                    summary[key]['ties'] += 1
                    tm[t1][f'{key}_t'] += 1;  tm[t2][f'{key}_t'] += 1

            sr = res['series_result']
            if sr == 1:
                summary['series']['wins'] += 1
                tm[t1]['series_w'] += 1;  tm[t2]['series_l'] += 1
            elif sr == 2:
                summary['series']['wins'] += 1
                tm[t2]['series_w'] += 1;  tm[t1]['series_l'] += 1
            else:
                summary['series']['ties'] += 1
                tm[t1]['series_t'] += 1;  tm[t2]['series_t'] += 1

            # ── match W/L/T ──
            p1, p2 = res['t1_pts'], res['t2_pts']
            tm[t1]['points'] += p1;  tm[t2]['points'] += p2
            tm[t1]['matches'] += 1;  tm[t2]['matches'] += 1

            if p1 > p2:
                tm[t1]['wins'] += 1;   tm[t2]['losses'] += 1
            elif p2 > p1:
                tm[t2]['wins'] += 1;   tm[t1]['losses'] += 1
            else:
                tm[t1]['ties'] += 1;   tm[t2]['ties'] += 1

            # ── recent week ──
            if m['week'] == most_recent_week:
                if p1 > p2:
                    recent[t1]['wins'] += 1;   recent[t2]['losses'] += 1
                elif p2 > p1:
                    recent[t2]['wins'] += 1;   recent[t1]['losses'] += 1
                else:
                    recent[t1]['ties'] += 1;   recent[t2]['ties'] += 1
                # Per-game breakdown for recent week
                for gi, gr in enumerate(res['game_results'], 1):
                    gk = f'game{gi}'
                    if gr == 1:
                        recent[t1][f'{gk}_w'] += 1; recent[t2][f'{gk}_l'] += 1
                    elif gr == 2:
                        recent[t2][f'{gk}_w'] += 1; recent[t1][f'{gk}_l'] += 1
                    else:
                        recent[t1][f'{gk}_t'] += 1; recent[t2][f'{gk}_t'] += 1
                sr = res['series_result']
                if sr == 1:
                    recent[t1]['series_w'] += 1; recent[t2]['series_l'] += 1
                elif sr == 2:
                    recent[t2]['series_w'] += 1; recent[t1]['series_l'] += 1
                else:
                    recent[t1]['series_t'] += 1; recent[t2]['series_t'] += 1

            # ── pins for game average ──
            for tid in (t1, t2):
                row = conn.execute('''
                    SELECT SUM(COALESCE(b.game1,0)+COALESCE(b.game2,0)+COALESCE(b.game3,0)) AS pins,
                           COUNT(*)*3 AS games
                    FROM bowler_scores b
                    JOIN members mem ON b.member_id = mem.id
                    WHERE b.schedule_id = ? AND mem.team_id = ?
                ''', (m['id'], tid)).fetchone()
                tm[tid]['total_pins']   += row['pins']  or 0
                tm[tid]['games_bowled'] += row['games'] or 0

        result = []
        for tid, t in tm.items():
            avg = round(t['total_pins'] / t['games_bowled'], 1) if t['games_bowled'] else 0
            result.append({
                **t,
                'game_average':      avg,
                'recent':            recent.get(tid),
                'most_recent_week':  most_recent_week,
            })

        result.sort(key=lambda x: (-x['points'], -x['game_average']))

        # ── last week recap (team and individual high scores) ──
        last_week = {'week': most_recent_week, 'teams': [], 'individuals': {'M': [], 'F': []}}
        if most_recent_week > 0:
            hdcp_on2 = bool(league['handicap_enabled'])
            base2    = int(league['handicap_base'])
            pct2     = float(league['handicap_pct'])

            # Team totals per match-slot this week
            wt_rows = conn.execute('''
                SELECT m.team_id, t.name AS team_name,
                       bs.schedule_id,
                       SUM(COALESCE(bs.game1,0)) AS g1t,
                       SUM(COALESCE(bs.game2,0)) AS g2t,
                       SUM(COALESCE(bs.game3,0)) AS g3t
                FROM bowler_scores bs
                JOIN members m ON bs.member_id = m.id
                JOIN teams t ON m.team_id = t.id
                JOIN schedule s ON bs.schedule_id = s.id
                WHERE s.league_id = ? AND s.week = ?
                GROUP BY bs.schedule_id, m.team_id
            ''', (lid, most_recent_week)).fetchall()

            team_wk = {}
            for r in wt_rows:
                tid2 = r['team_id']
                g1, g2, g3 = r['g1t'], r['g2t'], r['g3t']
                best_g = max(g1, g2, g3)
                series = g1 + g2 + g3
                if tid2 not in team_wk:
                    t_hdcp = 0
                    if hdcp_on2:
                        for mm in conn.execute('SELECT id FROM members WHERE team_id=?', (tid2,)).fetchall():
                            t_hdcp += _hdcp(bstats.get(mm['id'], {}).get('avg', base2), base2, pct2)
                    team_wk[tid2] = {'name': r['team_name'], 'best_game': 0, 'best_series': 0, 'hdcp': t_hdcp}
                team_wk[tid2]['best_game']   = max(team_wk[tid2]['best_game'],   best_g)
                team_wk[tid2]['best_series'] = max(team_wk[tid2]['best_series'], series)

            last_week['teams'] = sorted([
                {
                    'id':            tid2,
                    'name':          v['name'],
                    'scratch_game':  v['best_game'],
                    'scratch_series':v['best_series'],
                    'hdcp_game':     v['best_game']   + v['hdcp'],
                    'hdcp_series':   v['best_series'] + v['hdcp'] * 3,
                }
                for tid2, v in team_wk.items()
            ], key=lambda x: -x['scratch_game'])

            # Individual highs per gender
            wi_rows = conn.execute('''
                SELECT m.id, m.name, m.gender, t.name AS team_name,
                       bs.game1, bs.game2, bs.game3
                FROM bowler_scores bs
                JOIN members m ON bs.member_id = m.id
                JOIN teams t ON m.team_id = t.id
                JOIN schedule s ON bs.schedule_id = s.id
                WHERE s.league_id = ? AND s.week = ?
            ''', (lid, most_recent_week)).fetchall()

            bowler_wk = {}
            for r in wi_rows:
                mid = r['id']
                g1, g2, g3 = r['game1'] or 0, r['game2'] or 0, r['game3'] or 0
                if mid not in bowler_wk:
                    avg_v = bstats.get(mid, {}).get('avg', base2)
                    hdcp  = _hdcp(avg_v, base2, pct2) if hdcp_on2 else 0
                    bowler_wk[mid] = {
                        'name': r['name'], 'gender': r['gender'], 'team_name': r['team_name'],
                        'best_game': 0, 'best_series': 0, 'hdcp': hdcp,
                    }
                bowler_wk[mid]['best_game']   = max(bowler_wk[mid]['best_game'], g1, g2, g3)
                bowler_wk[mid]['best_series'] = max(bowler_wk[mid]['best_series'], g1+g2+g3)

            for gender in ('M', 'F'):
                glist = sorted(
                    [dict(v, hdcp_game=v['best_game']+v['hdcp'], hdcp_series=v['best_series']+v['hdcp']*3)
                     for v in bowler_wk.values() if v['gender'] == gender],
                    key=lambda x: -x['best_game']
                )[:3]
                last_week['individuals'][gender] = glist

    return jsonify({'teams': result, 'summary': summary, 'last_week': last_week})


# Bowler averages (for display) ───────────────────────────────────────────────

@app.route('/api/leagues/<int:lid>/averages', methods=['GET'])
def get_averages(lid):
    with get_db() as conn:
        league = _get_league(conn, lid)
        if not league:
            return jsonify({'error': 'League not found'}), 404
        bstats = _bowler_stats(conn, lid)
        rows = conn.execute('''
            SELECT m.id, m.name, m.gender, t.name AS team_name
            FROM members m
            JOIN teams t ON m.team_id = t.id
            WHERE t.league_id = ?
            ORDER BY t.name, m.name
        ''', (lid,)).fetchall()

        hdcp_on = bool(league['handicap_enabled'])
        base    = int(league['handicap_base'])
        pct     = float(league['handicap_pct'])

        result = []
        for r in rows:
            s   = bstats.get(r['id'], {})
            avg = s.get('avg', 0)
            result.append({
                'id':           r['id'],
                'name':         r['name'],
                'gender':       r['gender'],
                'team_name':    r['team_name'],
                'average':      avg,
                'games_bowled': s.get('games_bowled', 0),
                'series_bowled':s.get('series_bowled', 0),
                'total_pins':   s.get('total_pins', 0),
                'best_game':    s.get('best_game', 0),
                'best_series':  s.get('best_series', 0),
                'handicap':     _hdcp(avg, base, pct) if hdcp_on else 0,
            })
    return jsonify(result)


# Top performers ──────────────────────────────────────────────────────────────

@app.route('/api/leagues/<int:lid>/top-performers', methods=['GET'])
def get_top_performers(lid):
    with get_db() as conn:
        league = _get_league(conn, lid)
        if not league:
            return jsonify({'error': 'League not found'}), 404

        hdcp_on = bool(league['handicap_enabled'])
        base    = int(league['handicap_base'])
        pct     = float(league['handicap_pct'])

        rows = conn.execute('''
            SELECT bs.member_id, bs.game1, bs.game2, bs.game3,
                   m.name AS bowler_name, m.gender,
                   m.team_id, t.name AS team_name
            FROM bowler_scores bs
            JOIN members m  ON bs.member_id = m.id
            JOIN teams   t  ON m.team_id    = t.id
            JOIN schedule s ON bs.schedule_id = s.id
            WHERE s.league_id = ?
        ''', (lid,)).fetchall()

        bowlers = {}
        for r in rows:
            mid = r['member_id']
            if mid not in bowlers:
                bowlers[mid] = {
                    'id': mid, 'name': r['bowler_name'],
                    'gender': r['gender'], 'team_id': r['team_id'], 'team_name': r['team_name'],
                    'all_games': [], 'all_series': [],
                }
            g1, g2, g3 = r['game1'] or 0, r['game2'] or 0, r['game3'] or 0
            bowlers[mid]['all_games'].extend([g1, g2, g3])
            bowlers[mid]['all_series'].append(g1 + g2 + g3)

        performers = []
        team_hdcp_sums = {}   # team_id -> sum of bowler handicaps
        for mid, bd in bowlers.items():
            if not bd['all_games']:
                continue
            avg  = sum(bd['all_games']) / len(bd['all_games'])
            hdcp = _hdcp(avg, base, pct) if hdcp_on else 0

            best_s_game   = max(bd['all_games'])
            best_s_series = max(bd['all_series'])
            performers.append({
                'id':                 mid,
                'name':               bd['name'],
                'gender':             bd['gender'],
                'team_id':            bd['team_id'],
                'team_name':          bd['team_name'],
                'average':            round(avg, 1),
                'handicap':           hdcp,
                'best_scratch_game':  best_s_game,
                'best_scratch_series':best_s_series,
                'best_hdcp_game':     best_s_game   + hdcp,
                'best_hdcp_series':   best_s_series + hdcp * 3,
            })
            team_hdcp_sums[bd['team_id']] = team_hdcp_sums.get(bd['team_id'], 0) + hdcp

        # Team high game/series (best single-game total and best series total across all weeks)
        team_match_rows = conn.execute('''
            SELECT m.team_id, t.name AS team_name, bs.schedule_id,
                   SUM(COALESCE(bs.game1,0)) AS g1t,
                   SUM(COALESCE(bs.game2,0)) AS g2t,
                   SUM(COALESCE(bs.game3,0)) AS g3t
            FROM bowler_scores bs
            JOIN members m ON bs.member_id = m.id
            JOIN teams t ON m.team_id = t.id
            JOIN schedule s ON bs.schedule_id = s.id
            WHERE s.league_id = ?
            GROUP BY bs.schedule_id, m.team_id
        ''', (lid,)).fetchall()

        team_best = {}
        for r in team_match_rows:
            tid2 = r['team_id']
            g1, g2, g3 = r['g1t'], r['g2t'], r['g3t']
            if tid2 not in team_best:
                team_best[tid2] = {'name': r['team_name'], 'best_game': 0, 'best_series': 0}
            team_best[tid2]['best_game']   = max(team_best[tid2]['best_game'],   g1, g2, g3)
            team_best[tid2]['best_series'] = max(team_best[tid2]['best_series'], g1+g2+g3)

        team_performers = []
        for tid2, tb in team_best.items():
            t_hdcp = team_hdcp_sums.get(tid2, 0)
            team_performers.append({
                'name':                tb['name'],
                'best_scratch_game':   tb['best_game'],
                'best_scratch_series': tb['best_series'],
                'best_hdcp_game':      tb['best_game']   + t_hdcp,
                'best_hdcp_series':    tb['best_series'] + t_hdcp * 3,
            })

        def top3(lst, key):
            return sorted(lst, key=lambda x: -x[key])[:3]

        male   = [p for p in performers if p['gender'] == 'M']
        female = [p for p in performers if p['gender'] == 'F']

    return jsonify({
        'handicap_enabled': hdcp_on,
        'scratch': {
            'game':   {'M': top3(male, 'best_scratch_game'),   'F': top3(female, 'best_scratch_game')},
            'series': {'M': top3(male, 'best_scratch_series'), 'F': top3(female, 'best_scratch_series')},
        },
        'handicap': {
            'game':   {'M': top3(male, 'best_hdcp_game'),   'F': top3(female, 'best_hdcp_game')},
            'series': {'M': top3(male, 'best_hdcp_series'), 'F': top3(female, 'best_hdcp_series')},
        },
        'teams': {
            'scratch_game':   top3(team_performers, 'best_scratch_game'),
            'scratch_series': top3(team_performers, 'best_scratch_series'),
            'hdcp_game':      top3(team_performers, 'best_hdcp_game'),
            'hdcp_series':    top3(team_performers, 'best_hdcp_series'),
        },
    })


# Run at import time so gunicorn also initialises the schema
init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
