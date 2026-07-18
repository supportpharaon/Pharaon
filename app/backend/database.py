import sqlite3
import os
import json
from datetime import datetime


def get_db_path():
    data_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'Pharaon')
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, 'pharaon.db')


def get_connection():
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_connection()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS topics (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 3,
            description TEXT DEFAULT '',
            color TEXT DEFAULT '#1D4ED8',
            ease_factor REAL DEFAULT 2.5,
            interval INTEGER DEFAULT 1,
            repetitions INTEGER DEFAULT 0,
            next_review_date TEXT,
            last_review_date TEXT,
            last_rating INTEGER,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL,
            topic_name TEXT NOT NULL,
            subject TEXT NOT NULL,
            scheduled_date TEXT NOT NULL,
            scheduled_time TEXT,
            scheduled_duration INTEGER DEFAULT 25,
            completed_date TEXT,
            actual_duration INTEGER,
            rating INTEGER,
            notes TEXT DEFAULT '',
            status TEXT DEFAULT 'scheduled',
            is_rescheduled INTEGER DEFAULT 0,
            original_date TEXT,
            reschedule_reason TEXT,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS exams (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            exam_date TEXT NOT NULL,
            importance INTEGER DEFAULT 2,
            topic_ids TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS flashcards (
            id TEXT PRIMARY KEY,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            subject TEXT DEFAULT '',
            topic_id TEXT DEFAULT '',
            ease_factor REAL DEFAULT 2.5,
            interval INTEGER DEFAULT 1,
            repetitions INTEGER DEFAULT 0,
            next_review_date TEXT,
            last_review_date TEXT,
            last_correct INTEGER DEFAULT 0,
            times_correct INTEGER DEFAULT 0,
            times_shown INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS special_dates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            date_type TEXT DEFAULT 'reduced',
            max_priority INTEGER DEFAULT 2,
            start_time TEXT,
            end_time TEXT,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS study_restrictions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            scope TEXT NOT NULL,
            subject TEXT,
            topic_id TEXT,
            topic_name TEXT,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

    # Fitness
    c.execute("""
        CREATE TABLE IF NOT EXISTS fitness_sports (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#7C3AED',
            icon TEXT DEFAULT '💪',
            show_in_calendar INTEGER DEFAULT 1,
            use_scheduling INTEGER DEFAULT 0,
            ease_factor REAL DEFAULT 2.5,
            interval INTEGER DEFAULT 2,
            repetitions INTEGER DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS fitness_workouts (
            id TEXT PRIMARY KEY,
            sport_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            scheduled_date TEXT,
            scheduled_time TEXT,
            duration INTEGER DEFAULT 60,
            status TEXT DEFAULT 'planned',
            difficulty INTEGER,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS fitness_exercises (
            id TEXT PRIMARY KEY,
            sport_id TEXT NOT NULL,
            workout_id TEXT,
            name TEXT NOT NULL,
            sets INTEGER,
            reps TEXT,
            weight TEXT,
            duration_min INTEGER,
            distance TEXT,
            notes TEXT DEFAULT '',
            order_index INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    defaults = {
        'auto_start':              'false',
        'max_sessions_per_day':    '6',
        'default_session_duration':'25',
        'daily_goal_minutes':      '120',
        'desired_retention':       '0.9',
        'memory_calibration':      '1.0',
        'subject_colors':          '{}',
        'today_view_mode':         '"importance"',
        'first_run':               'true',
        'user_name':               '""',
    }
    for key, value in defaults.items():
        c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))

    # Migrations
    _migrate(c)

    conn.commit()
    conn.close()


def _migrate(c):
    for col, coltype in [('scheduled_time', 'TEXT'), ('rating', 'INTEGER')]:
        try:
            c.execute(f"ALTER TABLE sessions ADD COLUMN {col} {coltype}")
        except Exception:
            pass
    for col, coltype in [('start_time', 'TEXT'), ('end_time', 'TEXT')]:
        try:
            c.execute(f"ALTER TABLE special_dates ADD COLUMN {col} {coltype}")
        except Exception:
            pass
    try:
        c.execute("ALTER TABLE flashcards ADD COLUMN last_correct INTEGER DEFAULT 0")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE topics ADD COLUMN session_duration INTEGER")
    except Exception:
        pass
    # DSR memory model state (FSRS): stability in days, difficulty 1-10
    for col in ('stability REAL', 'difficulty REAL'):
        try:
            c.execute(f"ALTER TABLE topics ADD COLUMN {col}")
        except Exception:
            pass


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


# ── Topics ─────────────────────────────────────────────────

def get_all_topics():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM topics ORDER BY priority ASC, name ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def get_topic(topic_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
    conn.close()
    return row_to_dict(row)

def add_topic(topic):
    topic.setdefault('stability', None)
    topic.setdefault('difficulty', None)
    conn = get_connection()
    conn.execute("""
        INSERT INTO topics (id, name, subject, priority, description, color,
                           ease_factor, interval, repetitions, next_review_date,
                           session_duration, stability, difficulty, created_at)
        VALUES (:id, :name, :subject, :priority, :description, :color,
                :ease_factor, :interval, :repetitions, :next_review_date,
                :session_duration, :stability, :difficulty, :created_at)
    """, topic)
    conn.commit()
    conn.close()

def update_topic(topic_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [topic_id]
    conn.execute(f"UPDATE topics SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_topic(topic_id):
    conn = get_connection()
    conn.execute("DELETE FROM sessions WHERE topic_id = ?", (topic_id,))
    conn.execute("DELETE FROM topics WHERE id = ?", (topic_id,))
    conn.commit()
    conn.close()


# ── Sessions ────────────────────────────────────────────────

def get_all_sessions():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM sessions ORDER BY scheduled_date ASC, scheduled_time ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def get_sessions_for_date(date_str):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE scheduled_date = ? ORDER BY scheduled_time ASC, topic_name ASC",
        (date_str,)
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def get_sessions_for_topic(topic_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE topic_id = ? ORDER BY scheduled_date DESC",
        (topic_id,)
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def get_today_sessions():
    today = datetime.now().strftime('%Y-%m-%d')
    return get_sessions_for_date(today)

def add_session(session):
    conn = get_connection()
    conn.execute("""
        INSERT INTO sessions (id, topic_id, topic_name, subject, scheduled_date, scheduled_time,
                             scheduled_duration, status, is_rescheduled,
                             original_date, reschedule_reason, created_at)
        VALUES (:id, :topic_id, :topic_name, :subject, :scheduled_date, :scheduled_time,
                :scheduled_duration, :status, :is_rescheduled,
                :original_date, :reschedule_reason, :created_at)
    """, session)
    conn.commit()
    conn.close()

def update_session(session_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [session_id]
    conn.execute(f"UPDATE sessions SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_session(session_id):
    conn = get_connection()
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()

def restore_topic(topic_data):
    """Re-insert a topic from a snapshot dict (used by undo)."""
    t = topic_data
    conn = get_connection()
    conn.execute("""
        INSERT OR IGNORE INTO topics
        (id, name, subject, priority, description, color,
         ease_factor, interval, repetitions, next_review_date, last_review_date,
         last_rating, session_duration, stability, difficulty, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        t.get('id'), t.get('name'), t.get('subject'), t.get('priority', 3),
        t.get('description', ''), t.get('color', '#1D4ED8'),
        t.get('ease_factor', 2.5), t.get('interval', 1), t.get('repetitions', 0),
        t.get('next_review_date'), t.get('last_review_date'), t.get('last_rating'),
        t.get('session_duration'), t.get('stability'), t.get('difficulty'),
        t.get('created_at'),
    ))
    conn.commit()
    conn.close()


def restore_session(session_data):
    """Re-insert a session from a snapshot dict (used by undo)."""
    s = session_data
    conn = get_connection()
    conn.execute("""
        INSERT OR IGNORE INTO sessions
        (id, topic_id, topic_name, subject, scheduled_date, scheduled_time,
         scheduled_duration, completed_date, actual_duration, rating, notes,
         status, is_rescheduled, original_date, reschedule_reason, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        s.get('id'), s.get('topic_id'), s.get('topic_name'), s.get('subject'),
        s.get('scheduled_date'), s.get('scheduled_time'), s.get('scheduled_duration', 25),
        s.get('completed_date'), s.get('actual_duration'), s.get('rating'), s.get('notes', ''),
        s.get('status', 'scheduled'), s.get('is_rescheduled', 0),
        s.get('original_date'), s.get('reschedule_reason'), s.get('created_at'),
    ))
    conn.commit()
    conn.close()


def clear_all_data():
    """Delete all user data from all tables (used by import)."""
    conn = get_connection()
    for table in ('topics', 'sessions', 'exams', 'flashcards', 'special_dates',
                  'study_restrictions', 'fitness_sports', 'fitness_workouts',
                  'fitness_exercises'):
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()


def delete_auto_scheduled_sessions(from_date):
    """
    Delete future auto-scheduled sessions on or after from_date.
    Keeps user-committed sessions: 'manual' (pinned moves), 'skipped'
    (pushed forward by the user) and 'extra' (added on top of the plan) —
    all of which must stay put across rebuilds.
    """
    conn = get_connection()
    conn.execute(
        """DELETE FROM sessions
           WHERE status = 'scheduled'
           AND scheduled_date >= ?
           AND (reschedule_reason IS NULL
                OR reschedule_reason NOT IN ('manual', 'skipped', 'extra'))""",
        (from_date,)
    )
    conn.commit()
    conn.close()

def count_sessions_on_date(date_str, topic_id=None, exclude_status=('completed', 'missed', 'skipped')):
    conn = get_connection()
    placeholders = ",".join("?" * len(exclude_status))
    if topic_id:
        count = conn.execute(
            f"SELECT COUNT(*) FROM sessions WHERE scheduled_date = ? AND topic_id != ? AND status NOT IN ({placeholders})",
            [date_str, topic_id] + list(exclude_status)
        ).fetchone()[0]
    else:
        count = conn.execute(
            f"SELECT COUNT(*) FROM sessions WHERE scheduled_date = ? AND status NOT IN ({placeholders})",
            [date_str] + list(exclude_status)
        ).fetchone()[0]
    conn.close()
    return count

def get_missed_sessions():
    today = datetime.now().strftime('%Y-%m-%d')
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE status = 'scheduled' AND scheduled_date < ?",
        (today,)
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def get_sessions_in_range(start_date, end_date):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE scheduled_date BETWEEN ? AND ? ORDER BY scheduled_date ASC, scheduled_time ASC",
        (start_date, end_date)
    ).fetchall()
    conn.close()
    return rows_to_list(rows)


# ── Exams ──────────────────────────────────────────────────

def get_all_exams():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM exams ORDER BY exam_date ASC").fetchall()
    conn.close()
    result = rows_to_list(rows)
    for exam in result:
        exam['topic_ids'] = json.loads(exam.get('topic_ids') or '[]')
    return result

def add_exam(exam):
    conn = get_connection()
    exam_copy = dict(exam)
    if isinstance(exam_copy.get('topic_ids'), list):
        exam_copy['topic_ids'] = json.dumps(exam_copy['topic_ids'])
    conn.execute("""
        INSERT INTO exams (id, name, subject, exam_date, importance, topic_ids, notes, created_at)
        VALUES (:id, :name, :subject, :exam_date, :importance, :topic_ids, :notes, :created_at)
    """, exam_copy)
    conn.commit()
    conn.close()

def update_exam(exam_id, updates):
    conn = get_connection()
    updates_copy = dict(updates)
    if isinstance(updates_copy.get('topic_ids'), list):
        updates_copy['topic_ids'] = json.dumps(updates_copy['topic_ids'])
    sets = ", ".join(f"{k} = ?" for k in updates_copy.keys())
    vals = list(updates_copy.values()) + [exam_id]
    conn.execute(f"UPDATE exams SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_exam(exam_id):
    conn = get_connection()
    conn.execute("DELETE FROM exams WHERE id = ?", (exam_id,))
    conn.commit()
    conn.close()


# ── Flashcards ─────────────────────────────────────────────

def get_all_flashcards():
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM flashcards ORDER BY next_review_date ASC, created_at DESC"
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def add_flashcard(card):
    conn = get_connection()
    conn.execute("""
        INSERT INTO flashcards (id, question, answer, subject, topic_id,
                               ease_factor, interval, repetitions, next_review_date, created_at)
        VALUES (:id, :question, :answer, :subject, :topic_id,
                :ease_factor, :interval, :repetitions, :next_review_date, :created_at)
    """, card)
    conn.commit()
    conn.close()

def update_flashcard(card_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [card_id]
    conn.execute(f"UPDATE flashcards SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_flashcard(card_id):
    conn = get_connection()
    conn.execute("DELETE FROM flashcards WHERE id = ?", (card_id,))
    conn.commit()
    conn.close()


# ── Special Dates ───────────────────────────────────────────

def get_all_special_dates():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM special_dates ORDER BY start_date ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def add_special_date(sd):
    conn = get_connection()
    conn.execute("""
        INSERT INTO special_dates (id, name, start_date, end_date, date_type, max_priority, start_time, end_time, created_at)
        VALUES (:id, :name, :start_date, :end_date, :date_type, :max_priority, :start_time, :end_time, :created_at)
    """, sd)
    conn.commit()
    conn.close()

def update_special_date(sd_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [sd_id]
    conn.execute(f"UPDATE special_dates SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_special_date(sd_id):
    conn = get_connection()
    conn.execute("DELETE FROM special_dates WHERE id = ?", (sd_id,))
    conn.commit()
    conn.close()

def get_special_date_for_date(date_str):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM special_dates WHERE start_date <= ? AND end_date >= ? LIMIT 1",
        (date_str, date_str)
    ).fetchone()
    conn.close()
    return row_to_dict(row)


# ── Study Restrictions ──────────────────────────────────────────────────────

def get_all_study_restrictions():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM study_restrictions ORDER BY start_date ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def add_study_restriction(r):
    conn = get_connection()
    conn.execute("""
        INSERT INTO study_restrictions
            (id, name, scope, subject, topic_id, topic_name, start_date, end_date, created_at)
        VALUES
            (:id, :name, :scope, :subject, :topic_id, :topic_name, :start_date, :end_date, :created_at)
    """, r)
    conn.commit()
    conn.close()

def delete_study_restriction(rid):
    conn = get_connection()
    conn.execute("DELETE FROM study_restrictions WHERE id = ?", (rid,))
    conn.commit()
    conn.close()


# ── Settings ────────────────────────────────────────────────

def get_settings():
    conn = get_connection()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    settings = {}
    for row in rows:
        try:
            settings[row['key']] = json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            settings[row['key']] = row['value']
    return settings

def update_settings(updates):
    conn = get_connection()
    for key, value in updates.items():
        serialized = json.dumps(value)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, serialized)
        )
    conn.commit()
    conn.close()
    return get_settings()


# ── Fitness ─────────────────────────────────────────────────

def get_all_fitness_sports():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM fitness_sports ORDER BY name ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def get_fitness_sport(sport_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM fitness_sports WHERE id = ?", (sport_id,)).fetchone()
    conn.close()
    return row_to_dict(row)

def add_fitness_sport(sport):
    conn = get_connection()
    conn.execute("""
        INSERT INTO fitness_sports (id, name, color, icon, show_in_calendar, use_scheduling,
                                   ease_factor, interval, repetitions, notes, created_at)
        VALUES (:id, :name, :color, :icon, :show_in_calendar, :use_scheduling,
                :ease_factor, :interval, :repetitions, :notes, :created_at)
    """, sport)
    conn.commit()
    conn.close()

def update_fitness_sport(sport_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [sport_id]
    conn.execute(f"UPDATE fitness_sports SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_fitness_sport(sport_id):
    conn = get_connection()
    conn.execute("DELETE FROM fitness_exercises WHERE sport_id = ?", (sport_id,))
    conn.execute("DELETE FROM fitness_workouts WHERE sport_id = ?", (sport_id,))
    conn.execute("DELETE FROM fitness_sports WHERE id = ?", (sport_id,))
    conn.commit()
    conn.close()

def get_workouts_for_sport(sport_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM fitness_workouts WHERE sport_id = ? ORDER BY scheduled_date DESC, created_at DESC",
        (sport_id,)
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def get_all_fitness_workouts():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM fitness_workouts ORDER BY scheduled_date ASC, created_at ASC").fetchall()
    conn.close()
    return rows_to_list(rows)

def add_fitness_workout(workout):
    conn = get_connection()
    conn.execute("""
        INSERT INTO fitness_workouts (id, sport_id, name, scheduled_date, scheduled_time,
                                     duration, status, notes, created_at)
        VALUES (:id, :sport_id, :name, :scheduled_date, :scheduled_time,
                :duration, :status, :notes, :created_at)
    """, workout)
    conn.commit()
    conn.close()

def update_fitness_workout(workout_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [workout_id]
    conn.execute(f"UPDATE fitness_workouts SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_fitness_workout(workout_id):
    conn = get_connection()
    conn.execute("DELETE FROM fitness_exercises WHERE workout_id = ?", (workout_id,))
    conn.execute("DELETE FROM fitness_workouts WHERE id = ?", (workout_id,))
    conn.commit()
    conn.close()

def get_all_fitness_exercises():
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM fitness_exercises ORDER BY order_index ASC, created_at ASC"
    ).fetchall()
    conn.close()
    return rows_to_list(rows)

def get_exercises_for_sport(sport_id, workout_id=None):
    conn = get_connection()
    if workout_id:
        rows = conn.execute(
            "SELECT * FROM fitness_exercises WHERE workout_id = ? ORDER BY order_index ASC, created_at ASC",
            (workout_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM fitness_exercises WHERE sport_id = ? AND (workout_id IS NULL OR workout_id = '') ORDER BY order_index ASC, created_at ASC",
            (sport_id,)
        ).fetchall()
    conn.close()
    return rows_to_list(rows)

def add_fitness_exercise(exercise):
    conn = get_connection()
    conn.execute("""
        INSERT INTO fitness_exercises (id, sport_id, workout_id, name, sets, reps, weight,
                                      duration_min, distance, notes, order_index, created_at)
        VALUES (:id, :sport_id, :workout_id, :name, :sets, :reps, :weight,
                :duration_min, :distance, :notes, :order_index, :created_at)
    """, exercise)
    conn.commit()
    conn.close()

def update_fitness_exercise(exercise_id, updates):
    if not updates:
        return
    conn = get_connection()
    sets = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [exercise_id]
    conn.execute(f"UPDATE fitness_exercises SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()

def delete_fitness_exercise(exercise_id):
    conn = get_connection()
    conn.execute("DELETE FROM fitness_exercises WHERE id = ?", (exercise_id,))
    conn.commit()
    conn.close()
