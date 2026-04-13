from flask import Flask, jsonify, request, render_template
import sqlite3
import random

app = Flask(__name__)
DB = 'bowling.db'


def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                team_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS schedule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                week INTEGER NOT NULL,
                team1_id INTEGER NOT NULL,
                team2_id INTEGER NOT NULL,
                FOREIGN KEY (team1_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (team2_id) REFERENCES teams(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                schedule_id INTEGER NOT NULL UNIQUE,
                team1_g1 INTEGER, team1_g2 INTEGER, team1_g3 INTEGER,
                team2_g1 INTEGER, team2_g2 INTEGER, team2_g3 INTEGER,
                FOREIGN KEY (schedule_id) REFERENCES schedule(id) ON DELETE CASCADE
            );
        ''')


def round_robin(team_ids):
    """
    Generate a balanced round-robin schedule.
    Returns a list of rounds; each round is a list of (team1_id, team2_id) pairs.
    Uses a standard circle rotation to ensure each pair meets exactly once.
    """
    teams = list(team_ids)
    random.shuffle(teams)

    if len(teams) % 2 == 1:
        teams.append(None)  # None = BYE week

    n = len(teams)
    rounds = []

    for _ in range(n - 1):
        round_matches = []
        for i in range(n // 2):
            t1 = teams[i]
            t2 = teams[n - 1 - i]
            if t1 is not None and t2 is not None:
                round_matches.append((t1, t2))
        rounds.append(round_matches)
        # Fix teams[0], rotate the rest
        teams = [teams[0]] + [teams[-1]] + teams[1:-1]

    return rounds


# ---------------------------------------------------------------------------
# Main page
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Teams
# ---------------------------------------------------------------------------

@app.route('/api/teams', methods=['GET'])
def get_teams():
    with get_db() as conn:
        teams = conn.execute('SELECT * FROM teams ORDER BY name').fetchall()
        result = []
        for t in teams:
            members = conn.execute(
                'SELECT * FROM members WHERE team_id = ? ORDER BY name', (t['id'],)
            ).fetchall()
            result.append({
                'id': t['id'],
                'name': t['name'],
                'members': [{'id': m['id'], 'name': m['name']} for m in members],
            })
    return jsonify(result)


@app.route('/api/teams', methods=['POST'])
def create_team():
    data = request.json or {}
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Team name is required'}), 400
    try:
        with get_db() as conn:
            cursor = conn.execute('INSERT INTO teams (name) VALUES (?)', (name,))
            team_id = cursor.lastrowid
            for m in data.get('members', []):
                m_name = (m if isinstance(m, str) else m.get('name', '')).strip()
                if m_name:
                    conn.execute(
                        'INSERT INTO members (team_id, name) VALUES (?, ?)', (team_id, m_name)
                    )
        return jsonify({'id': team_id, 'name': name}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'A team with that name already exists'}), 409


@app.route('/api/teams/<int:team_id>', methods=['PUT'])
def update_team(team_id):
    data = request.json or {}
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Team name is required'}), 400
    try:
        with get_db() as conn:
            conn.execute('UPDATE teams SET name = ? WHERE id = ?', (name, team_id))
            if 'members' in data:
                conn.execute('DELETE FROM members WHERE team_id = ?', (team_id,))
                for m in data['members']:
                    m_name = (m if isinstance(m, str) else m.get('name', '')).strip()
                    if m_name:
                        conn.execute(
                            'INSERT INTO members (team_id, name) VALUES (?, ?)', (team_id, m_name)
                        )
        return jsonify({'success': True})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'A team with that name already exists'}), 409


@app.route('/api/teams/<int:team_id>', methods=['DELETE'])
def delete_team(team_id):
    with get_db() as conn:
        conn.execute('DELETE FROM teams WHERE id = ?', (team_id,))
    return jsonify({'success': True})


# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------

@app.route('/api/schedule', methods=['GET'])
def get_schedule():
    with get_db() as conn:
        rows = conn.execute('''
            SELECT s.id, s.week,
                   t1.id AS team1_id, t1.name AS team1_name,
                   t2.id AS team2_id, t2.name AS team2_name,
                   sc.team1_g1, sc.team1_g2, sc.team1_g3,
                   sc.team2_g1, sc.team2_g2, sc.team2_g3
            FROM schedule s
            JOIN teams t1 ON s.team1_id = t1.id
            JOIN teams t2 ON s.team2_id = t2.id
            LEFT JOIN scores sc ON sc.schedule_id = s.id
            ORDER BY s.week, s.id
        ''').fetchall()

    result = []
    for r in rows:
        has_scores = r['team1_g1'] is not None
        result.append({
            'id': r['id'],
            'week': r['week'],
            'team1_id': r['team1_id'],
            'team1_name': r['team1_name'],
            'team2_id': r['team2_id'],
            'team2_name': r['team2_name'],
            'scores': {
                'team1_g1': r['team1_g1'],
                'team1_g2': r['team1_g2'],
                'team1_g3': r['team1_g3'],
                'team2_g1': r['team2_g1'],
                'team2_g2': r['team2_g2'],
                'team2_g3': r['team2_g3'],
            } if has_scores else None,
        })
    return jsonify(result)


@app.route('/api/schedule/generate', methods=['POST'])
def generate_schedule():
    data = request.json or {}
    requested_weeks = data.get('weeks')

    with get_db() as conn:
        teams = conn.execute('SELECT id FROM teams').fetchall()
        team_ids = [t['id'] for t in teams]

        if len(team_ids) < 2:
            return jsonify({'error': 'Need at least 2 teams to generate a schedule'}), 400

        base_rounds = round_robin(team_ids)

        if requested_weeks and int(requested_weeks) > 0:
            target = int(requested_weeks)
            rounds = []
            i = 0
            # Alternate forward/reverse on each pass to reduce back-to-back repeats
            passes = [base_rounds, list(reversed(base_rounds))]
            while len(rounds) < target:
                rounds += passes[len(rounds) // len(base_rounds) % 2]
            rounds = rounds[:target]
        else:
            rounds = base_rounds

        conn.execute('DELETE FROM schedule')
        for week_num, matches in enumerate(rounds, 1):
            for t1, t2 in matches:
                conn.execute(
                    'INSERT INTO schedule (week, team1_id, team2_id) VALUES (?, ?, ?)',
                    (week_num, t1, t2),
                )

    return jsonify({'success': True, 'weeks': len(rounds)})


# ---------------------------------------------------------------------------
# Scores
# ---------------------------------------------------------------------------

@app.route('/api/scores/<int:schedule_id>', methods=['POST'])
def save_scores(schedule_id):
    data = request.json or {}
    fields = ['team1_g1', 'team1_g2', 'team1_g3', 'team2_g1', 'team2_g2', 'team2_g3']
    vals = [data.get(f) for f in fields]

    with get_db() as conn:
        existing = conn.execute(
            'SELECT id FROM scores WHERE schedule_id = ?', (schedule_id,)
        ).fetchone()
        if existing:
            conn.execute(
                '''UPDATE scores
                   SET team1_g1=?, team1_g2=?, team1_g3=?,
                       team2_g1=?, team2_g2=?, team2_g3=?
                   WHERE schedule_id=?''',
                (*vals, schedule_id),
            )
        else:
            conn.execute(
                '''INSERT INTO scores
                   (schedule_id, team1_g1, team1_g2, team1_g3, team2_g1, team2_g2, team2_g3)
                   VALUES (?,?,?,?,?,?,?)''',
                (schedule_id, *vals),
            )
    return jsonify({'success': True})


@app.route('/api/scores/<int:schedule_id>', methods=['DELETE'])
def delete_scores(schedule_id):
    with get_db() as conn:
        conn.execute('DELETE FROM scores WHERE schedule_id = ?', (schedule_id,))
    return jsonify({'success': True})


# ---------------------------------------------------------------------------
# Standings
# ---------------------------------------------------------------------------

@app.route('/api/standings', methods=['GET'])
def get_standings():
    with get_db() as conn:
        teams = {
            t['id']: {
                'id': t['id'],
                'name': t['name'],
                'points': 0,
                'matches': 0,
                'wins': 0,
                'losses': 0,
                'ties': 0,
                'total_pins': 0,
                'games_bowled': 0,
                'series_total': 0,
                'series_count': 0,
            }
            for t in conn.execute('SELECT * FROM teams').fetchall()
        }

        matches = conn.execute('''
            SELECT s.team1_id, s.team2_id,
                   sc.team1_g1, sc.team1_g2, sc.team1_g3,
                   sc.team2_g1, sc.team2_g2, sc.team2_g3
            FROM schedule s
            JOIN scores sc ON sc.schedule_id = s.id
            WHERE sc.team1_g1 IS NOT NULL
              AND sc.team2_g1 IS NOT NULL
        ''').fetchall()

    for m in matches:
        t1_id = m['team1_id']
        t2_id = m['team2_id']
        if t1_id not in teams or t2_id not in teams:
            continue

        g = [
            m['team1_g1'], m['team1_g2'], m['team1_g3'],
            m['team2_g1'], m['team2_g2'], m['team2_g3'],
        ]

        t1_pts = 0
        t2_pts = 0

        # 1 point per game
        for i in range(3):
            t1g = g[i] or 0
            t2g = g[i + 3] or 0
            if t1g > t2g:
                t1_pts += 1
            elif t2g > t1g:
                t2_pts += 1
            # tie: neither gets the point

        # 1 point for overall series
        t1_series = sum(g[i] or 0 for i in range(3))
        t2_series = sum(g[i + 3] or 0 for i in range(3))
        if t1_series > t2_series:
            t1_pts += 1
        elif t2_series > t1_series:
            t2_pts += 1

        teams[t1_id]['points'] += t1_pts
        teams[t2_id]['points'] += t2_pts
        teams[t1_id]['matches'] += 1
        teams[t2_id]['matches'] += 1

        if t1_pts > t2_pts:
            teams[t1_id]['wins'] += 1
            teams[t2_id]['losses'] += 1
        elif t2_pts > t1_pts:
            teams[t2_id]['wins'] += 1
            teams[t1_id]['losses'] += 1
        else:
            teams[t1_id]['ties'] += 1
            teams[t2_id]['ties'] += 1

        for side, tid in enumerate([t1_id, t2_id]):
            offset = side * 3
            games = [g[offset], g[offset + 1], g[offset + 2]]
            valid = [x for x in games if x is not None]
            if valid:
                teams[tid]['total_pins'] += sum(valid)
                teams[tid]['games_bowled'] += len(valid)
                teams[tid]['series_total'] += sum(valid)
                teams[tid]['series_count'] += 1

    result = []
    for t in teams.values():
        game_avg = (
            round(t['total_pins'] / t['games_bowled'], 1) if t['games_bowled'] > 0 else 0
        )
        series_avg = (
            round(t['series_total'] / t['series_count'], 1) if t['series_count'] > 0 else 0
        )
        result.append({**t, 'game_average': game_avg, 'series_average': series_avg})

    result.sort(key=lambda x: (-x['points'], -x['game_average']))
    return jsonify(result)


if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5000)
