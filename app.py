#!/usr/bin/env python3
"""Chrono — local study-time tracker.

Run:  python app.py            (opens http://127.0.0.1:8765 in your browser)
      python app.py --no-browser --port 9000
"""
import argparse
import json
import os
import subprocess
import time
import sqlite3
import sys
import threading
import webbrowser
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
# Program files (static/) sit next to app.py, or inside the bundle of the packaged app.
RES_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))


def user_dir() -> Path:
    """Where your data lives. Run from the git folder: right here (data/, logs/), as before.
    The packaged app (AppImage, .exe, .app) can't write into itself, so it uses the usual
    per-user folder of the system. CHRONO_HOME overrides both."""
    if os.environ.get("CHRONO_HOME"):
        return Path(os.environ["CHRONO_HOME"]).expanduser()
    if not getattr(sys, "frozen", False):
        return BASE_DIR
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Chrono"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Chrono"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "chrono"


USER_DIR = user_dir()
DATA_DIR = USER_DIR / "data"
DB_PATH = DATA_DIR / "chrono.db"
STATIC_DIR = RES_DIR / "static"
LOGS_DIR = USER_DIR / "logs"
LOCAL_FILE = USER_DIR / "chrono.local.json"  # personal setup (activity types, GitHub user); gitignored

# Activity groups: tracked like courses, across all semesters, but never counted as study time.
ACTIVITY_GROUPS = {"sport": "Sport", "code": "Code"}
NON_STUDY = ("other",) + tuple(ACTIVITY_GROUPS)  # readable .txt copies of your sessions (see export_logs)

ECTS_HOURS = 30  # hours of work per ECTS credit

# Course categories. Keys are stored in the DB; label + colors are used by the UI.
# Colors: Okabe & Ito's colour-blind-safe palette (light / dark mode).
CATEGORIES = [
    {"key": "master", "label": "Master", "light": "#0072b2", "dark": "#4aa3df"},
    {"key": "lehrdiplom", "label": "Lehrdiplom", "light": "#e69f00", "dark": "#f0b030"},
    {"key": "job", "label": "Job", "light": "#cc79a7", "dark": "#e09ac4"},
    {"key": "energy_compatible", "label": "Energy (compatible)", "light": "#009e73", "dark": "#2fc79a"},
    {"key": "energy_incompatible", "label": "Energy (incompatible)", "light": "#d55e00", "dark": "#ee7a33"},
]
CATEGORY_KEYS = [c["key"] for c in CATEGORIES]

# Tips. Fill in your usernames; whatever stays empty is not shown. Both empty: no button.
KOFI_USER = "ecinef456"             # the end of your Ko-fi page address: ko-fi.com/<this>
GITHUB_SPONSORS_USER = "ecinef456"  # your GitHub username, once GitHub Sponsors has approved you
SUPPORT = [
    {"key": "kofi", "label": "Ko-fi", "url": f"https://ko-fi.com/{KOFI_USER}" if KOFI_USER else "",
     "when": "A one-off tip with a card, Apple Pay or Google Pay. No account needed."},
    {"key": "github", "label": "GitHub Sponsors", "url": f"https://github.com/sponsors/{GITHUB_SPONSORS_USER}" if GITHUB_SPONSORS_USER else "",
     "when": "If you have a GitHub account: one-off or monthly, and all of it reaches me (no fees)."},
]

# Break types offered when you resume after a pause. Add more here if you like.
BREAK_TYPES = ["Necessary", "Not necessary"]

ISO = "%Y-%m-%dT%H:%M:%S"

SCHEMA = """
CREATE TABLE IF NOT EXISTS semesters (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    start_date TEXT,              -- YYYY-MM-DD, first day of the semester
    end_date TEXT,                -- YYYY-MM-DD, last day you track (usually last exam)
    sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY,
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    ects REAL NOT NULL DEFAULT 0,
    deadline TEXT,                -- YYYY-MM-DD
    category TEXT,
    finished INTEGER NOT NULL DEFAULT 0,
    grade TEXT,
    sort INTEGER DEFAULT 0,
    start_date TEXT,              -- YYYY-MM-DD; only used when spans = 1
    spans INTEGER NOT NULL DEFAULT 0, -- 1 = runs across semesters (e.g. a thesis); semester_id = where its ECTS count
    kind TEXT NOT NULL DEFAULT 'course', -- 'course', 'other' (notes on days off), 'sport', 'code' (never study time)
    repo_path TEXT,               -- code projects: local git clone, for commit stats
    UNIQUE (semester_id, code)
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    start TEXT NOT NULL,          -- local time YYYY-MM-DDTHH:MM:SS
    end TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,-- time actually studied (excludes breaks)
    notes TEXT DEFAULT '',
    source TEXT DEFAULT 'timer',  -- timer | manual | legacy
    satisfaction INTEGER          -- 0-10 rating of the session; NULL = not rated
);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start);
CREATE TABLE IF NOT EXISTS breaks (
    id INTEGER PRIMARY KEY,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    type TEXT NOT NULL,
    source TEXT DEFAULT 'timer'
);
CREATE TABLE IF NOT EXISTS timer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    course_id INTEGER,
    session_start TEXT,           -- when Start was first pressed
    segment_start TEXT,           -- current running segment; NULL while paused
    pause_start TEXT,             -- when the current pause began
    accumulated_sec INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO timer (id) VALUES (1);
"""


# ---------------------------------------------------------------- database

def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)
        cols = [r["name"] for r in con.execute("PRAGMA table_info(sessions)")]
        if "satisfaction" not in cols:  # databases created before ratings existed
            con.execute("ALTER TABLE sessions ADD COLUMN satisfaction INTEGER")
        ccols = [r["name"] for r in con.execute("PRAGMA table_info(courses)")]
        if "spans" not in ccols:  # databases created before multi-semester courses existed
            con.execute("ALTER TABLE courses ADD COLUMN start_date TEXT")
            con.execute("ALTER TABLE courses ADD COLUMN spans INTEGER NOT NULL DEFAULT 0")
        if "kind" not in [r["name"] for r in con.execute("PRAGMA table_info(courses)")]:
            con.execute("ALTER TABLE courses ADD COLUMN kind TEXT NOT NULL DEFAULT 'course'")
        if "repo_path" not in [r["name"] for r in con.execute("PRAGMA table_info(courses)")]:
            con.execute("ALTER TABLE courses ADD COLUMN repo_path TEXT")
        con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        con.execute("""CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY,
            date TEXT NOT NULL,          -- YYYY-MM-DD
            start_min INTEGER NOT NULL,  -- minutes after midnight
            end_min INTEGER NOT NULL,
            title TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT '',  -- the Typst text it came from
            plan TEXT NOT NULL,               -- parsed timetable (JSON, read by teach.js)
            created TEXT NOT NULL
        )""")
        con.execute("CREATE INDEX IF NOT EXISTS lessons_date ON lessons(date)")
        con.execute("""CREATE TABLE IF NOT EXISTS sleep (
            id INTEGER PRIMARY KEY,
            night TEXT NOT NULL,           -- YYYY-MM-DD: the evening the night began (naps: their day)
            kind TEXT NOT NULL DEFAULT 'night',  -- night | nap
            bed TEXT NOT NULL,             -- lights out
            wake TEXT NOT NULL,            -- final awakening
            latency_min INTEGER,           -- minutes to fall asleep
            awake_min INTEGER,             -- minutes awake during the night
            quality INTEGER,               -- 1-5
            free INTEGER NOT NULL DEFAULT 0,   -- 1 = a free day followed (no obligations)
            alarm INTEGER NOT NULL DEFAULT 0,  -- 1 = woke with an alarm
            notes TEXT NOT NULL DEFAULT ''
        )""")
        con.execute("CREATE INDEX IF NOT EXISTS sleep_night ON sleep(night)")
        ensure_other(con)
        seed_activities(con)


def load_local():
    try:
        return json.loads(LOCAL_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def seed_activities(con):
    """Create the sport/code types listed in chrono.local.json, once. Later changes happen in the app."""
    if con.execute("SELECT value FROM settings WHERE key='activities_seeded'").fetchone():
        return
    anchor = con.execute("SELECT id FROM semesters ORDER BY sort, id LIMIT 1").fetchone()
    if not anchor:
        return
    if not LOCAL_FILE.exists():
        return  # nothing to seed yet; add types in the app, or create chrono.local.json and restart
    local = load_local()
    for kind in ACTIVITY_GROUPS:
        for i, item in enumerate(local.get(kind, [])):
            name, repo = (item, None) if isinstance(item, str) else (item.get("name"), item.get("repo"))
            if not name or con.execute("SELECT 1 FROM courses WHERE kind=? AND name=?", (kind, name)).fetchone():
                continue
            con.execute("INSERT INTO courses (semester_id,code,name,ects,category,sort,kind,repo_path)"
                        " VALUES (?,?,?,0,?,?,?,?)", (anchor[0], _slug(name), name, kind, 1000 + i, kind, repo))
    con.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('activities_seeded','1')")


def _slug(name):
    out = "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-")
    return "-".join(p for p in out.split("-") if p)[:24] or "item"


def ensure_other(con):
    """The built-in "Other" entry: one for all semesters. Its semester_id is only a technical anchor."""
    if con.execute("SELECT 1 FROM courses WHERE kind='other'").fetchone():
        return
    first = con.execute("SELECT id FROM semesters ORDER BY sort, id LIMIT 1").fetchone()
    if first:
        con.execute("INSERT INTO courses (semester_id,code,name,ects,category,sort,kind)"
                    " VALUES (?,'other','Other',0,NULL,9999,'other')", (first[0],))


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def now() -> datetime:
    return datetime.now().replace(microsecond=0)


def parse(ts: str) -> datetime:
    return datetime.strptime(ts[:19], ISO)


def fmt(dt: datetime) -> str:
    return dt.strftime(ISO)


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------- models

class SemesterIn(BaseModel):
    code: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class CourseIn(BaseModel):
    semester_id: int
    code: str
    name: str
    ects: float
    deadline: Optional[str] = None
    category: Optional[str] = None
    finished: bool = False
    grade: Optional[str] = None
    spans: bool = False              # runs across several semesters (e.g. a master thesis)
    start_date: Optional[str] = None  # first day, for spanning courses


class SessionIn(BaseModel):
    course_id: int
    start: str                  # YYYY-MM-DDTHH:MM[:SS]
    end: str
    duration_sec: Optional[int] = None  # defaults to end - start
    notes: str = ""
    satisfaction: Optional[int] = Field(None, ge=0, le=10)


class StartIn(BaseModel):
    course_id: int


class ResumeIn(BaseModel):
    break_type: str


class StopIn(BaseModel):
    save: bool = True
    notes: str = ""
    satisfaction: Optional[int] = Field(None, ge=0, le=10)


app = FastAPI(title="Chrono")


def norm_ts(ts: str) -> str:
    ts = ts.strip().replace(" ", "T")
    if len(ts) == 16:
        ts += ":00"
    try:
        return fmt(parse(ts))
    except ValueError:
        raise HTTPException(400, f"Invalid time '{ts}'. Use YYYY-MM-DDTHH:MM.")


def check_category(cat):
    if cat is not None and cat not in CATEGORY_KEYS:
        raise HTTPException(400, f"Unknown category '{cat}'.")


# ---------------------------------------------------------------- meta

@app.get("/api/meta")
def meta():
    return {"categories": CATEGORIES, "break_types": BREAK_TYPES, "ects_hours": ECTS_HOURS,
            "today": date.today().isoformat(), "support": [x for x in SUPPORT if x["url"]]}


# ---------------------------------------------------------------- semesters

@app.get("/api/semesters")
def list_semesters():
    with db() as con:
        sems = rows(con.execute("SELECT * FROM semesters ORDER BY sort, id"))
        for s in sems:
            s["course_count"] = con.execute(
                "SELECT COUNT(*) FROM courses WHERE semester_id=?", (s["id"],)).fetchone()[0]
    return sems


@app.post("/api/semesters")
def create_semester(body: SemesterIn):
    with db() as con:
        try:
            sort = con.execute("SELECT COALESCE(MAX(sort),0)+1 FROM semesters").fetchone()[0]
            cur = con.execute("INSERT INTO semesters (code,start_date,end_date,sort) VALUES (?,?,?,?)",
                              (body.code.strip().upper(), body.start_date, body.end_date, sort))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"Semester {body.code} already exists.")
        ensure_other(con)
        seed_activities(con)
        return {"id": cur.lastrowid}


@app.put("/api/semesters/{sid}")
def update_semester(sid: int, body: SemesterIn):
    with db() as con:
        con.execute("UPDATE semesters SET code=?, start_date=?, end_date=? WHERE id=?",
                    (body.code.strip().upper(), body.start_date, body.end_date, sid))
    return {"ok": True}


# ---------------------------------------------------------------- courses

@app.get("/api/courses")
def list_courses(semester_id: Optional[int] = None):
    with db() as con:
        if semester_id:
            sem = con.execute("SELECT * FROM semesters WHERE id=?", (semester_id,)).fetchone()
            if not sem:
                raise HTTPException(404, "Semester not found.")
            return _visible_courses(con, dict(sem))
        return rows(con.execute("SELECT * FROM courses ORDER BY semester_id, sort, id"))


# ---------------------------------------------------------------- multi-semester courses
# A spanning course (e.g. a thesis) belongs to the semester where its ECTS count (semester_id),
# but also shows up in every other semester its start_date..deadline overlaps. In those
# semesters only the sessions inside the semester's window count for weekly numbers and charts.

def _sem_window(con, sem):
    """(first day, first day of the next semester or None). None if the semester has no start date."""
    if not sem.get("start_date"):
        return None
    nxt = con.execute("SELECT MIN(start_date) FROM semesters WHERE start_date > ?", (sem["start_date"],)).fetchone()[0]
    return date.fromisoformat(sem["start_date"]), (date.fromisoformat(nxt) if nxt else None)


def _in_window(window, d: date) -> bool:
    return window is None or (window[0] <= d and (window[1] is None or d < window[1]))


def _visible_courses(con, sem):
    own = rows(con.execute("SELECT * FROM courses WHERE semester_id=? AND kind = 'course' ORDER BY sort, id", (sem["id"],)))
    for c in own:
        c["home"] = True
    everywhere = [dict(r, home=False) for r in rows(con.execute(
        "SELECT * FROM courses WHERE kind != 'course' ORDER BY CASE kind WHEN 'sport' THEN 1 WHEN 'code' THEN 2 ELSE 9 END, sort, id"))]
    window = _sem_window(con, sem)
    if window is None:
        return own + everywhere
    others = rows(con.execute("SELECT c.*, s.code AS home_code FROM courses c JOIN semesters s ON s.id = c.semester_id"
                              " WHERE c.spans = 1 AND c.semester_id != ? ORDER BY c.sort, c.id", (sem["id"],)))
    for c in others:
        c_start = _d(c["start_date"]) or window[0]
        c_end = _d(c["deadline"])
        if (window[1] is None or c_start < window[1]) and (c_end is None or c_end >= window[0]):
            c["home"] = False
            own.append(c)
    return own + everywhere


def _counts_here(course, window, d: date) -> bool:
    """Does a session on day d count for this semester's weekly numbers?"""
    return not (course.get("spans") or course.get("kind", "course") != "course") or _in_window(window, d)


def check_spans(body: CourseIn):
    if not body.spans:
        return
    if not body.start_date or not body.deadline:
        raise HTTPException(400, "A course across semesters needs a start date and a deadline.")
    if body.start_date > body.deadline:
        raise HTTPException(400, "The start date is after the deadline.")


@app.post("/api/courses")
def create_course(body: CourseIn):
    check_category(body.category)
    check_spans(body)
    with db() as con:
        try:
            sort = con.execute("SELECT COALESCE(MAX(sort),0)+1 FROM courses WHERE semester_id=?",
                               (body.semester_id,)).fetchone()[0]
            cur = con.execute(
                "INSERT INTO courses (semester_id,code,name,ects,deadline,category,finished,grade,sort,spans,start_date)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (body.semester_id, body.code.strip().lower(), body.name.strip(), body.ects,
                 body.deadline, body.category, int(body.finished), body.grade, sort,
                 int(body.spans), body.start_date if body.spans else None))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"A course with initials '{body.code}' already exists in this semester.")
        return {"id": cur.lastrowid}


@app.put("/api/courses/{cid}")
def update_course(cid: int, body: CourseIn):
    check_category(body.category)
    check_spans(body)
    with db() as con:
        try:
            con.execute(
                "UPDATE courses SET semester_id=?, code=?, name=?, ects=?, deadline=?, category=?,"
                " finished=?, grade=?, spans=?, start_date=? WHERE id=?",
                (body.semester_id, body.code.strip().lower(), body.name.strip(), body.ects,
                 body.deadline, body.category, int(body.finished), body.grade,
                 int(body.spans), body.start_date if body.spans else None, cid))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"A course with initials '{body.code}' already exists in this semester.")
    return {"ok": True}


@app.delete("/api/courses/{cid}")
def delete_course(cid: int):
    with db() as con:
        if con.execute("SELECT 1 FROM courses WHERE id=? AND kind != 'course'", (cid,)).fetchone():
            raise HTTPException(409, "Other is built in and can't be deleted.")
        n = con.execute("SELECT COUNT(*) FROM sessions WHERE course_id=?", (cid,)).fetchone()[0]
        if n:
            raise HTTPException(409, f"This course has {n} logged sessions. Delete them first, "
                                     "or mark the course finished instead.")
        if con.execute("SELECT course_id FROM timer WHERE id=1").fetchone()[0] == cid:
            raise HTTPException(409, "The timer is running for this course. Stop it first.")
        con.execute("DELETE FROM courses WHERE id=?", (cid,))
    return {"ok": True}


# ---------------------------------------------------------------- sessions

@app.get("/api/sessions")
def list_sessions(semester_id: Optional[int] = None, course_id: Optional[int] = None, limit: int = 2000):
    q = ("SELECT s.*, c.code AS course_code, c.name AS course_name, c.category, c.kind AS course_kind"
         " FROM sessions s JOIN courses c ON c.id = s.course_id WHERE 1=1")
    args = []
    if course_id:
        q += " AND s.course_id=?"
        args.append(course_id)
    with db() as con:
        if not semester_id:
            return rows(con.execute(q + " ORDER BY s.start DESC LIMIT ?", args + [limit]))
        sem = con.execute("SELECT * FROM semesters WHERE id=?", (semester_id,)).fetchone()
        if not sem:
            raise HTTPException(404, "Semester not found.")
        sem = dict(sem)
        return _semester_sessions(con, sem, q, args)[:limit]


def _semester_sessions(con, sem, q, args):
    """Sessions of the semester's courses, plus those of spanning courses that fall in its window."""
    courses = {c["id"]: c for c in _visible_courses(con, sem)}
    if not courses:
        return []
    window = _sem_window(con, sem)
    marks = ",".join("?" * len(courses))
    out = rows(con.execute(q + f" AND s.course_id IN ({marks}) ORDER BY s.start DESC", args + list(courses)))
    return [s for s in out if _counts_here(courses[s["course_id"]], window, parse(s["start"]).date())]


def _session_values(body: SessionIn):
    start, end = norm_ts(body.start), norm_ts(body.end)
    span = int((parse(end) - parse(start)).total_seconds())
    if span <= 0:
        raise HTTPException(400, "End must be after start.")
    dur = span if body.duration_sec is None else int(body.duration_sec)
    with db() as con:
        kind = con.execute("SELECT kind FROM courses WHERE id=?", (body.course_id,)).fetchone()
    if not kind:
        raise HTTPException(404, "Course not found.")
    if kind[0] == "other":
        if dur < 0 or dur > span:
            raise HTTPException(400, "The time must fit between start and end.")
        if not body.notes.strip():
            raise HTTPException(400, "Write what you did, that's the point of an Other entry.")
        return start, end, dur
    if dur <= 0 or dur > span:
        raise HTTPException(400, "Studied time must be positive and fit between start and end.")
    return start, end, dur


@app.post("/api/sessions")
def create_session(body: SessionIn):
    start, end, dur = _session_values(body)
    with db() as con:
        cur = con.execute("INSERT INTO sessions (course_id,start,end,duration_sec,notes,source,satisfaction)"
                          " VALUES (?,?,?,?,?,'manual',?)",
                          (body.course_id, start, end, dur, body.notes.strip(), body.satisfaction))
        return {"id": cur.lastrowid}


@app.put("/api/sessions/{sid}")
def update_session(sid: int, body: SessionIn):
    start, end, dur = _session_values(body)
    with db() as con:
        con.execute("UPDATE sessions SET course_id=?, start=?, end=?, duration_sec=?, notes=?, satisfaction=?"
                    " WHERE id=?",
                    (body.course_id, start, end, dur, body.notes.strip(), body.satisfaction, sid))
    return {"ok": True}


@app.delete("/api/sessions/{sid}")
def delete_session(sid: int):
    with db() as con:
        con.execute("DELETE FROM sessions WHERE id=?", (sid,))
    return {"ok": True}


# ---------------------------------------------------------------- timer
# State lives in the DB, so closing the tab or rebooting never loses a running timer.

def _timer(con):
    t = dict(con.execute("SELECT * FROM timer WHERE id=1").fetchone())
    n = now()
    if not t["course_id"]:
        return {"state": "idle", "server_now": fmt(n)}
    elapsed = t["accumulated_sec"] or 0
    if t["segment_start"]:
        elapsed += int((n - parse(t["segment_start"])).total_seconds())
    c = con.execute("SELECT id, code, name, category, kind FROM courses WHERE id=?", (t["course_id"],)).fetchone()
    return {
        "state": "running" if t["segment_start"] else "paused",
        "course": dict(c) if c else None,
        "session_start": t["session_start"],
        "segment_start": t["segment_start"],
        "pause_start": t["pause_start"],
        "accumulated_sec": t["accumulated_sec"] or 0,
        "elapsed_sec": elapsed,
        "pause_sec": int((n - parse(t["pause_start"])).total_seconds()) if t["pause_start"] else 0,
        "server_now": fmt(n),
    }


@app.get("/api/timer")
def get_timer():
    with db() as con:
        return _timer(con)


@app.post("/api/timer/start")
def timer_start(body: StartIn):
    with db() as con:
        if con.execute("SELECT course_id FROM timer WHERE id=1").fetchone()[0]:
            raise HTTPException(409, "A timer is already running. Stop it first.")
        if not con.execute("SELECT 1 FROM courses WHERE id=?", (body.course_id,)).fetchone():
            raise HTTPException(404, "Course not found.")
        n = fmt(now())
        con.execute("UPDATE timer SET course_id=?, session_start=?, segment_start=?, pause_start=NULL,"
                    " accumulated_sec=0 WHERE id=1", (body.course_id, n, n))
        return _timer(con)


@app.post("/api/timer/pause")
def timer_pause():
    with db() as con:
        t = con.execute("SELECT * FROM timer WHERE id=1").fetchone()
        if not t["course_id"] or not t["segment_start"]:
            raise HTTPException(409, "The timer isn't running.")
        n = now()
        acc = (t["accumulated_sec"] or 0) + int((n - parse(t["segment_start"])).total_seconds())
        con.execute("UPDATE timer SET accumulated_sec=?, segment_start=NULL, pause_start=? WHERE id=1",
                    (acc, fmt(n)))
        return _timer(con)


@app.post("/api/timer/resume")
def timer_resume(body: ResumeIn):
    with db() as con:
        t = con.execute("SELECT * FROM timer WHERE id=1").fetchone()
        if not t["course_id"] or t["segment_start"]:
            raise HTTPException(409, "The timer isn't paused.")
        n = now()
        ps = parse(t["pause_start"])
        dur = int((n - ps).total_seconds())
        if dur > 0:
            con.execute("INSERT INTO breaks (start,end,duration_sec,type) VALUES (?,?,?,?)",
                        (fmt(ps), fmt(n), dur, body.break_type))
        con.execute("UPDATE timer SET segment_start=?, pause_start=NULL WHERE id=1", (fmt(n),))
        return _timer(con)


@app.post("/api/timer/stop")
def timer_stop(body: StopIn):
    with db() as con:
        t = con.execute("SELECT * FROM timer WHERE id=1").fetchone()
        if not t["course_id"]:
            raise HTTPException(409, "No timer to stop.")
        n = now()
        acc = t["accumulated_sec"] or 0
        if t["segment_start"]:
            acc += int((n - parse(t["segment_start"])).total_seconds())
            end = n
        else:
            end = parse(t["pause_start"])  # a pause before Stop doesn't count as study time
        saved = None
        if body.save and acc > 0:
            cur = con.execute("INSERT INTO sessions (course_id,start,end,duration_sec,notes,source,satisfaction)"
                              " VALUES (?,?,?,?,?,'timer',?)",
                              (t["course_id"], t["session_start"], fmt(end), acc, body.notes.strip(),
                               body.satisfaction))
            saved = cur.lastrowid
        con.execute("UPDATE timer SET course_id=NULL, session_start=NULL, segment_start=NULL,"
                    " pause_start=NULL, accumulated_sec=0 WHERE id=1")
        return {"saved_session_id": saved, "duration_sec": acc}


# ---------------------------------------------------------------- stats

def _d(s):
    return date.fromisoformat(s) if s else None


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _satisfaction(sess, week0, n_weeks, this_monday, today):
    """Averages of the 0-10 session ratings. Unrated sessions are ignored.

    Every average is weighted by time studied, so a 3 h session counts six times as much
    as a 30 min one. For the hour-of-day profile, a session's studied time is spread over
    the clock hours it covers (breaks inside it are spread evenly).
    """
    def acc():
        return [0.0, 0.0]  # [sum of rating*hours, hours]

    daily, weekly, hourly, total, week_now = defaultdict(acc), defaultdict(acc), defaultdict(acc), acc(), acc()
    rated = 0
    for s in sess:
        r = s.get("satisfaction")
        if r is None:
            continue
        rated += 1
        st, en = parse(s["start"]), parse(s.get("end") or s["start"])
        h = s["duration_sec"] / 3600
        d = st.date()
        for bucket in (daily[d.isoformat()], total):
            bucket[0] += r * h
            bucket[1] += h
        wi = (_monday(d) - week0).days // 7
        if 0 <= wi < n_weeks:
            weekly[wi][0] += r * h
            weekly[wi][1] += h
        if this_monday <= d <= today:
            week_now[0] += r * h
            week_now[1] += h
        span = (en - st).total_seconds()
        if span <= 0:
            hourly[st.hour][0] += r * h
            hourly[st.hour][1] += h
            continue
        studied_share = s["duration_sec"] / span
        t = st
        while t < en:
            nxt = min(en, t.replace(minute=0, second=0) + timedelta(hours=1))
            w = (nxt - t).total_seconds() * studied_share / 3600
            hourly[t.hour][0] += r * w
            hourly[t.hour][1] += w
            t = nxt

    def avg(b):
        return round(b[0] / b[1], 2) if b[1] > 0 else None

    return {
        "rated_sessions": rated,
        "rated_hours": round(total[1], 2),
        "average": avg(total),
        "this_week": avg(week_now),
        "daily": {k: avg(v) for k, v in daily.items()},
        "weekly": [avg(weekly[i]) for i in range(n_weeks)],
        "weekly_hours": [round(weekly[i][1], 2) for i in range(n_weeks)],
        "by_hour": [{"hour": hr, "average": avg(hourly[hr]), "hours": round(hourly[hr][1], 2)} for hr in range(24)],
    }


@app.get("/api/stats")
def stats(semester_id: int):
    today = date.today()
    with db() as con:
        sem = con.execute("SELECT * FROM semesters WHERE id=?", (semester_id,)).fetchone()
        if not sem:
            raise HTTPException(404, "Semester not found.")
        sem = dict(sem)
        courses = [c for c in _visible_courses(con, sem) if c.get("kind") == "course"]
        window = _sem_window(con, sem)
        ids = [c["id"] for c in courses]
        all_sess = rows(con.execute(
            "SELECT s.course_id, s.start, s.end, s.duration_sec, s.satisfaction FROM sessions s"
            f" WHERE s.course_id IN ({','.join('?' * len(ids)) or 'NULL'})", ids)) if ids else []
        timer = _timer(con)

    # Include the live timer so numbers move while you study.
    if timer["state"] != "idle" and timer.get("course") and timer["course"]["id"] in ids:
        all_sess.append({"course_id": timer["course"]["id"], "start": timer["session_start"],
                         "duration_sec": timer["elapsed_sec"]})

    by_id = {c["id"]: c for c in courses}
    # Progress counts every hour of a course; everything weekly counts only this semester's hours.
    all_hours = defaultdict(float)
    for s in all_sess:
        all_hours[s["course_id"]] += s["duration_sec"] / 3600
    sess = [s for s in all_sess if _counts_here(by_id[s["course_id"]], window, parse(s["start"]).date())]

    sess_dates = [parse(s["start"]).date() for s in sess]
    start = _d(sem["start_date"]) or (min(sess_dates) if sess_dates else today)
    end = _d(sem["end_date"]) or max([_d(c["deadline"]) for c in courses if c["deadline"]] or [today])
    upto = min(today, end)
    if upto < start:
        upto = start
    elapsed_weeks = max(((upto - start).days + 1) / 7.0, 1.0)

    week0 = _monday(start)
    last_week = _monday(max(upto, max(sess_dates) if sess_dates else upto))
    n_weeks = (last_week - week0).days // 7 + 1
    this_monday = _monday(today)

    cat_of = {c["id"]: c["category"] or "none" for c in courses}
    per_course = defaultdict(lambda: {"total": 0, "week": 0, "first": None, "last": None})
    weekly_cat = defaultdict(lambda: defaultdict(float))
    weekly_course = defaultdict(lambda: defaultdict(float))
    daily = defaultdict(float)

    for s, d in zip(sess, sess_dates):
        h = s["duration_sec"] / 3600
        pc = per_course[s["course_id"]]
        pc["total"] += h
        if this_monday <= d <= today:
            pc["week"] += h
        pc["last"] = max(pc["last"], d) if pc["last"] else d
        wi = (_monday(d) - week0).days // 7
        if 0 <= wi < n_weeks:
            weekly_cat[wi][cat_of.get(s["course_id"], "none")] += h
            weekly_course[wi][s["course_id"]] += h
        daily[d.isoformat()] += h

    out_courses = []
    for c in courses:
        pc = per_course[c["id"]]
        done_h = all_hours[c["id"]]  # all semesters, for a spanning course
        target = c["ects"] * ECTS_HOURS
        remaining = max(target - done_h, 0)
        dl = _d(c["deadline"])
        needed = None
        days_left = None
        if dl and not c["finished"]:
            days_left = (dl - today).days
            if days_left > 0:
                needed = remaining / (days_left / 7.0)
        out_courses.append({
            **c,
            "finished": bool(c["finished"]),
            "spans": bool(c.get("spans")),
            "hours": round(done_h, 3),
            "hours_here": round(pc["total"], 3),
            "target_hours": target,
            "ects_done": round(done_h / ECTS_HOURS, 3),
            "avg_week": round(pc["total"] / elapsed_weeks, 3),
            "this_week": round(pc["week"], 3),
            "needed_week": round(needed, 3) if needed is not None else None,
            "days_left": days_left,
            "last_session": pc["last"].isoformat() if pc["last"] else None,
        })

    total_h = sum(c["hours_here"] for c in out_courses)
    # ECTS count only in the semester a course belongs to, so a thesis isn't counted twice.
    ects_courses = [c for c in out_courses if c["home"]]
    ects_target = sum(c["ects"] for c in ects_courses)
    ects_done = sum(c["ects"] if c["finished"] else min(c["ects_done"], c["ects"]) for c in ects_courses)

    weeks = []
    for i in range(n_weeks):
        ws = week0 + timedelta(weeks=i)
        weeks.append({
            "index": i + 1,
            "start": ws.isoformat(),
            "by_category": {k: round(v, 3) for k, v in weekly_cat[i].items()},
            "by_course": {str(k): round(v, 3) for k, v in weekly_course[i].items()},
            "total": round(sum(weekly_cat[i].values()), 3),
        })

    # Breaks (all sources), grouped by the same weeks.
    with db() as con:
        brk = rows(con.execute("SELECT start, duration_sec, type FROM breaks WHERE start >= ? AND start < ?",
                               (week0.isoformat(), (week0 + timedelta(weeks=n_weeks)).isoformat())))
    weekly_breaks = defaultdict(lambda: defaultdict(float))
    break_totals = defaultdict(float)
    for b in brk:
        wi = (_monday(parse(b["start"]).date()) - week0).days // 7
        weekly_breaks[wi][b["type"]] += b["duration_sec"] / 3600
        break_totals[b["type"]] += b["duration_sec"] / 3600
    for i, w in enumerate(weeks):
        w["breaks"] = {k: round(v, 3) for k, v in weekly_breaks[i].items()}

    # Streak of consecutive study days ending today (or yesterday).
    streak, d = 0, today
    if daily.get(d.isoformat(), 0) == 0:
        d -= timedelta(days=1)
    while daily.get(d.isoformat(), 0) > 0:
        streak += 1
        d -= timedelta(days=1)

    return {
        "semester": sem,
        "range": {"start": start.isoformat(), "end": end.isoformat(), "upto": upto.isoformat(),
                  "elapsed_weeks": round(elapsed_weeks, 2), "week_index": (this_monday - week0).days // 7 + 1},
        "summary": {
            "hours": round(total_h, 2),
            "ects_done": round(ects_done, 2),
            "ects_target": ects_target,
            "avg_week": round(total_h / elapsed_weeks, 2),
            "this_week": round(sum(c["this_week"] for c in out_courses), 2),
            "today": round(daily.get(today.isoformat(), 0), 2),
            "streak": streak,
        },
        "courses": out_courses,
        "weeks": weeks,
        "daily": {k: round(v, 3) for k, v in daily.items()},
        "break_totals": {k: round(v, 2) for k, v in break_totals.items()},
        "satisfaction": _satisfaction(sess, week0, n_weeks, this_monday, today),
    }


# ---------------------------------------------------------------- sport & code (activities)

class ActivityTypeIn(BaseModel):
    kind: str
    name: str
    repo_path: Optional[str] = None
    archived: bool = False


def _check_kind(kind):
    if kind not in ACTIVITY_GROUPS:
        raise HTTPException(400, f"Unknown group '{kind}'.")


@app.post("/api/activity-types")
def create_activity_type(body: ActivityTypeIn):
    _check_kind(body.kind)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give it a name.")
    with db() as con:
        anchor = con.execute("SELECT id FROM semesters ORDER BY sort, id LIMIT 1").fetchone()
        if not anchor:
            raise HTTPException(409, "Create a semester first.")
        if con.execute("SELECT 1 FROM courses WHERE kind=? AND lower(name)=lower(?)", (body.kind, name)).fetchone():
            raise HTTPException(409, f"'{name}' already exists.")
        sort = con.execute("SELECT COALESCE(MAX(sort),1000)+1 FROM courses WHERE kind=?", (body.kind,)).fetchone()[0]
        code = _slug(name)
        while con.execute("SELECT 1 FROM courses WHERE semester_id=? AND code=?", (anchor[0], code)).fetchone():
            code += "-2"
        cur = con.execute("INSERT INTO courses (semester_id,code,name,ects,category,sort,kind,repo_path)"
                          " VALUES (?,?,?,0,?,?,?,?)",
                          (anchor[0], code, name, body.kind, sort, body.kind, (body.repo_path or "").strip() or None))
        return {"id": cur.lastrowid}


@app.put("/api/activity-types/{tid}")
def update_activity_type(tid: int, body: ActivityTypeIn):
    _check_kind(body.kind)
    with db() as con:
        if not con.execute("SELECT 1 FROM courses WHERE id=? AND kind=?", (tid, body.kind)).fetchone():
            raise HTTPException(404, "Not found.")
        con.execute("UPDATE courses SET name=?, repo_path=?, finished=? WHERE id=?",
                    (body.name.strip(), (body.repo_path or "").strip() or None, int(body.archived), tid))
    _GIT_CACHE.clear()
    return {"ok": True}


@app.delete("/api/activity-types/{tid}")
def delete_activity_type(tid: int):
    with db() as con:
        if not con.execute("SELECT 1 FROM courses WHERE id=? AND kind IN ('sport','code')", (tid,)).fetchone():
            raise HTTPException(404, "Not found.")
        n = con.execute("SELECT COUNT(*) FROM sessions WHERE course_id=?", (tid,)).fetchone()[0]
        if n:
            raise HTTPException(409, f"It has {n} logged sessions. Hide it instead, so they stay in your history.")
        con.execute("DELETE FROM courses WHERE id=?", (tid,))
    return {"ok": True}


_GIT_CACHE = {}


def git_commits(path, since: date, github_user=None):
    """Your commits in a local clone since a date (all branches, incl. fetched remote ones).
    Returns (list of {when, subject, added, deleted}, error or None). Cached for a minute."""
    key = (path, since, github_user)
    hit = _GIT_CACHE.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    result = _git_commits(path, since, github_user)
    _GIT_CACHE[key] = (time.time(), result)
    return result


def _git_commits(path, since, github_user):
    if not path:
        return [], "No local folder set."
    repo = Path(os.path.expanduser(path))
    if not (repo / ".git").exists():
        return [], f"No git repository at {path}."
    def run(*args):
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=20)
    try:
        email = run("config", "user.email").stdout.strip().lower()
        out = run("log", "--all", "--no-merges", f"--since={since.isoformat()}",
                  "--pretty=format:%x1e%H%x1f%ae%x1f%an%x1f%aI%x1f%s", "--numstat")
    except (OSError, subprocess.SubprocessError) as e:
        return [], f"Could not run git: {e}"
    if out.returncode:
        return [], (out.stderr.strip() or "git log failed")[:200]
    user = (github_user or "").lower()
    commits = []
    for rec in out.stdout.split("\x1e"):
        if not rec.strip():
            continue
        head, *stat = rec.strip("\n").split("\n")
        parts = head.split("\x1f")
        if len(parts) < 5:
            continue
        _, ae, an, when, subject = parts[:5]
        ae, an = ae.lower(), an.lower()
        if (email or user) and not ((email and ae == email) or (user and (user in ae or user == an))):
            continue
        added = deleted = 0
        for line in stat:
            cols = line.split("\t")
            if len(cols) >= 2:
                added += int(cols[0]) if cols[0].isdigit() else 0
                deleted += int(cols[1]) if cols[1].isdigit() else 0
        commits.append({"when": datetime.fromisoformat(when).astimezone().replace(tzinfo=None),
                        "subject": subject, "added": added, "deleted": deleted})
    return commits, None


def _month_start(d: date, back: int) -> date:
    y, m = d.year, d.month - back
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


@app.get("/api/activities")
def activities(weeks: int = 16, months: int = 12):
    today = date.today()
    week0 = _monday(today) - timedelta(weeks=weeks - 1)
    month0 = _month_start(today, months - 1)
    since = min(week0, month0)
    week_starts = [week0 + timedelta(weeks=i) for i in range(weeks)]
    month_starts = [_month_start(today, months - 1 - i) for i in range(months)]
    def wi(d):
        i = (_monday(d) - week0).days // 7
        return i if 0 <= i < weeks else None
    def mi(d):
        i = (d.year - month0.year) * 12 + d.month - month0.month
        return i if 0 <= i < months else None

    github_user = load_local().get("github_user")
    with db() as con:
        types = rows(con.execute("SELECT id, kind, name, code, repo_path, finished AS archived, sort FROM courses"
                                 " WHERE kind IN ('sport','code') ORDER BY kind, sort, id"))
        sess = rows(con.execute("SELECT s.course_id, s.start, s.duration_sec FROM sessions s JOIN courses c ON c.id = s.course_id"
                                " WHERE c.kind IN ('sport','code') AND s.start >= ?", (since.isoformat(),)))
        timer = _timer(con)
    if timer["state"] != "idle" and timer.get("course") and any(t["id"] == timer["course"]["id"] for t in types):
        sess.append({"course_id": timer["course"]["id"], "start": timer["session_start"], "duration_sec": timer["elapsed_sec"]})

    by_id = {t["id"]: t for t in types}
    out = {}
    for kind, label in ACTIVITY_GROUPS.items():
        ktypes = [t for t in types if t["kind"] == kind]
        for n, t in enumerate(ktypes):
            t["slot"] = n  # fixed colour slot, in creation order
            t["archived"] = bool(t["archived"])
        wk = [[0.0] * weeks for _ in ktypes]
        mo = [[0.0] * months for _ in ktypes]
        idx = {t["id"]: n for n, t in enumerate(ktypes)}
        days = set()
        for s in sess:
            if by_id[s["course_id"]]["kind"] != kind:
                continue
            d = parse(s["start"]).date()
            h = s["duration_sec"] / 3600
            n = idx[s["course_id"]]
            if (i := wi(d)) is not None:
                wk[n][i] += h
            if (i := mi(d)) is not None:
                mo[n][i] += h
            if wi(d) is not None:
                days.add(d)
        group = {
            "label": label,
            "types": ktypes,
            "weeks": [w.isoformat() for w in week_starts],
            "months": [m.isoformat() for m in month_starts],
            "weekly": [[round(v, 3) for v in row] for row in wk],
            "monthly": [[round(v, 3) for v in row] for row in mo],
            "this_week": round(sum(row[-1] for row in wk), 2),
            "this_month": round(sum(row[-1] for row in mo), 2),
            "avg_week": round(sum(sum(row[:-1]) for row in wk) / max(weeks - 1, 1), 2),  # full weeks only
            "days_this_week": len([d for d in days if d >= _monday(today)]),
        }
        if kind == "code":
            for t in ktypes:
                commits, err = git_commits(t["repo_path"], since, github_user)
                cw, aw, dw = [0] * weeks, [0] * weeks, [0] * weeks
                cm = [0] * months
                for c in commits:
                    d = c["when"].date()
                    if (i := wi(d)) is not None:
                        cw[i] += 1; aw[i] += c["added"]; dw[i] += c["deleted"]
                    if (i := mi(d)) is not None:
                        cm[i] += 1
                recent = sorted(commits, key=lambda c: c["when"], reverse=True)[:5]
                t["git"] = {"error": err, "commits_week": cw, "added_week": aw, "deleted_week": dw, "commits_month": cm,
                            "recent": [{"when": fmt(c["when"]), "subject": c["subject"], "added": c["added"],
                                        "deleted": c["deleted"]} for c in recent]}
        out[kind] = group
    return out


# ---------------------------------------------------------------- static

# ---------------------------------------------------------------- features (chosen on first launch)
# The study timer (Dashboard, Log, Courses) is always on. The rest can be switched on or off;
# nothing is deleted when a feature is switched off, it is only hidden.

FEATURES = {
    "sport": "Sport: track your sport time, never counted as study time",
    "code": "Code: track coding time on your projects, with commit stats from your local git folders",
    "teach": "Teach: lesson calendar and live lesson timetables from Typst notes",
    "sleep": "Sleep: sleep diary, schedule, statistics and evidence-based advice",
}


def _feature_guess(con):
    """What an existing installation already uses, to pre-tick the first-launch choice."""
    return {
        "sport": bool(con.execute("SELECT 1 FROM courses WHERE kind='sport'").fetchone()) or LOCAL_FILE.exists(),
        "code": bool(con.execute("SELECT 1 FROM courses WHERE kind='code'").fetchone()) or LOCAL_FILE.exists(),
        "teach": bool(con.execute("SELECT 1 FROM lessons").fetchone()),
        "sleep": bool(con.execute("SELECT 1 FROM sleep").fetchone()),
    }


@app.get("/api/features")
def get_features():
    with db() as con:
        r = con.execute("SELECT value FROM settings WHERE key='features'").fetchone()
        chosen = json.loads(r["value"]) if r else None
        if chosen and "sport_code" in chosen:            # before Sport and Code were separate
            both = chosen.pop("sport_code")
            chosen.setdefault("sport", both)
            chosen.setdefault("code", both)
        return {"available": FEATURES, "chosen": chosen, "suggested": _feature_guess(con)}


class FeaturesIn(BaseModel):
    chosen: dict


@app.put("/api/features")
def put_features(body: FeaturesIn):
    chosen = {k: bool(body.chosen.get(k, False)) for k in FEATURES}
    with db() as con:
        con.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('features',?)", (json.dumps(chosen),))
    return {"available": FEATURES, "chosen": chosen}


# ---------------------------------------------------------------- sleep: diary, schedule, statistics, advice
# One row per sleep: a night (kind 'night') or a nap. `night` is the date of the evening the
# night began (a nap: its own date). Times are local, like everything else in Chrono.

SLEEP_DEFAULT_SCHEDULE = {
    "need_h": 8.0,                      # how much sleep you aim for
    "free_days": [5, 6],                # days you wake up without obligations (0 = Monday ... 6 = Sunday)
    "work": {"bed": "23:00", "wake": "07:00"},
    "free": {"bed": "23:30", "wake": "08:00"},
}


class SleepIn(BaseModel):
    night: str                           # YYYY-MM-DD
    kind: str = "night"                  # night | nap
    bed: str                             # YYYY-MM-DDTHH:MM(:SS): lights out, trying to sleep
    wake: str                            # final awakening
    latency_min: Optional[int] = Field(default=None, ge=0, le=600)   # time to fall asleep
    awake_min: Optional[int] = Field(default=None, ge=0, le=900)     # awake during the night
    quality: Optional[int] = Field(default=None, ge=1, le=5)
    free: Optional[bool] = None          # a free day (no obligation in the morning); None = from the schedule
    alarm: bool = False                  # woke up with an alarm
    notes: str = ""


class ScheduleIn(BaseModel):
    need_h: float = Field(ge=4, le=12)
    free_days: list[int]
    work: dict
    free: dict


def sleep_schedule(con):
    r = con.execute("SELECT value FROM settings WHERE key='sleep_schedule'").fetchone()
    try:
        return {**SLEEP_DEFAULT_SCHEDULE, **json.loads(r["value"])} if r else dict(SLEEP_DEFAULT_SCHEDULE)
    except ValueError:
        return dict(SLEEP_DEFAULT_SCHEDULE)


def _sleep_values(body: SleepIn, con):
    if body.kind not in ("night", "nap"):
        raise HTTPException(400, "kind must be night or nap")
    try:
        date.fromisoformat(body.night)
        bed, wake = parse(norm_ts(body.bed)), parse(norm_ts(body.wake))
    except ValueError:
        raise HTTPException(400, "Dates look like 2026-11-09, times like 2026-11-09T23:30.")
    if wake <= bed:
        raise HTTPException(400, "The wake-up time must come after the bedtime.")
    if wake - bed > timedelta(hours=20):
        raise HTTPException(400, "That is more than 20 hours in bed. Check the dates.")
    lat, awk = body.latency_min or 0, body.awake_min or 0
    if (wake - bed).total_seconds() / 60 <= lat + awk:
        raise HTTPException(400, "Falling asleep and time awake take longer than the whole time in bed.")
    free = body.free
    if free is None:
        free = wake.weekday() in sleep_schedule(con)["free_days"]
    return (body.night, body.kind, fmt(bed), fmt(wake), body.latency_min, body.awake_min, body.quality,
            int(bool(free)), int(body.alarm), body.notes.strip())


@app.get("/api/sleep")
def list_sleep(start: Optional[str] = None, end: Optional[str] = None):
    q, args = "SELECT * FROM sleep", []
    if start and end:
        q += " WHERE night BETWEEN ? AND ?"
        args = [start, end]
    with db() as con:
        return rows(con.execute(q + " ORDER BY bed DESC", args))


@app.post("/api/sleep")
def create_sleep(body: SleepIn):
    with db() as con:
        v = _sleep_values(body, con)
        if body.kind == "night" and con.execute("SELECT 1 FROM sleep WHERE kind='night' AND night=?", (body.night,)).fetchone():
            raise HTTPException(409, "This night is already logged. Edit it in the list instead.")
        cur = con.execute("INSERT INTO sleep (night,kind,bed,wake,latency_min,awake_min,quality,free,alarm,notes)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?)", v)
        return dict(con.execute("SELECT * FROM sleep WHERE id=?", (cur.lastrowid,)).fetchone())


@app.put("/api/sleep/{sid}")
def update_sleep(sid: int, body: SleepIn):
    with db() as con:
        v = _sleep_values(body, con)
        if body.kind == "night" and con.execute("SELECT 1 FROM sleep WHERE kind='night' AND night=? AND id<>?", (body.night, sid)).fetchone():
            raise HTTPException(409, "Another entry already logs this night.")
        con.execute("UPDATE sleep SET night=?,kind=?,bed=?,wake=?,latency_min=?,awake_min=?,quality=?,free=?,alarm=?,notes=? WHERE id=?", (*v, sid))
        return dict(con.execute("SELECT * FROM sleep WHERE id=?", (sid,)).fetchone())


@app.delete("/api/sleep/{sid}")
def delete_sleep(sid: int):
    with db() as con:
        con.execute("DELETE FROM sleep WHERE id=?", (sid,))
    return {"ok": True}


@app.get("/api/sleep/schedule")
def get_sleep_schedule():
    with db() as con:
        return sleep_schedule(con)


@app.put("/api/sleep/schedule")
def put_sleep_schedule(body: ScheduleIn):
    for part in (body.work, body.free):
        for k in ("bed", "wake"):
            try:
                datetime.strptime(str(part.get(k, "")), "%H:%M")
            except ValueError:
                raise HTTPException(400, "Times look like 23:00.")
    if any(d not in range(7) for d in body.free_days):
        raise HTTPException(400, "Free days are 0 (Monday) to 6 (Sunday).")
    with db() as con:
        con.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('sleep_schedule',?)", (json.dumps(body.model_dump()),))
        return sleep_schedule(con)


def _night_facts(r):
    """Derived numbers of one night. Clock times are minutes after noon of the evening's date,
    so 23:30 = 690 and 07:00 next morning = 1140 (no wrap at midnight)."""
    bed, wake = parse(r["bed"]), parse(r["wake"])
    noon = datetime.fromisoformat(r["night"] + "T12:00:00")
    onset = bed + timedelta(minutes=r["latency_min"] or 0)
    in_bed = (wake - bed).total_seconds() / 60
    asleep = (wake - onset).total_seconds() / 60 - (r["awake_min"] or 0)
    m = lambda t: (t - noon).total_seconds() / 60
    return {
        "id": r["id"], "night": r["night"], "free": bool(r["free"]), "alarm": bool(r["alarm"]), "quality": r["quality"],
        "bed": m(bed), "onset": m(onset), "wake": m(wake), "mid": m(onset) + (wake - onset).total_seconds() / 120,
        "in_bed": in_bed, "asleep": asleep,
        "latency": r["latency_min"], "awake": r["awake_min"],
        "efficiency": asleep / in_bed if (r["latency_min"] is not None or r["awake_min"] is not None) else None,
        "_on": onset, "_off": wake,
    }


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _sd(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return None
    mu = sum(xs) / len(xs)
    return (sum((x - mu) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5


def _sri(entries, nights):
    """Sleep Regularity Index (Phillips et al. 2017): how likely you are in the same state
    (asleep / awake) at two moments 24 h apart; 100 = identical days, 0 = random.
    From the diary: 5-min epochs, only over days whose night is logged on both sides."""
    covered = set(nights)
    if len(covered) < 4:
        return None, 0
    origin = datetime.combine(date.fromisoformat(min(covered)), datetime.min.time())
    ep = lambda t: int((t - origin).total_seconds() // 300)          # 5-min epoch number
    asleep = set()
    for e in entries:
        a = parse(e["bed"]) + timedelta(minutes=e["latency_min"] or 0)
        asleep.update(range(ep(a), ep(parse(e["wake"]))))
    same = total = 0
    for n in sorted(covered):
        d = date.fromisoformat(n)
        if (d + timedelta(days=1)).isoformat() not in covered:
            continue
        k0 = ep(datetime.combine(d, datetime.min.time()) + timedelta(hours=12))   # noon to noon, around night n
        for k in range(k0, k0 + 288):
            same += (k in asleep) == (k + 288 in asleep)
            total += 1
    if not total:
        return None, 0
    return 200 * same / total - 100, total // (24 * 12)


def _clock(m):
    if m is None:
        return None
    m = round(m) + 12 * 60
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def _hm_dur(minutes):
    m = round(abs(minutes))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


SOURCES = {
    "aasm": ("Watson et al. 2015, AASM & SRS consensus (J Clin Sleep Med)", "https://www.aasm.org/resources/pdf/adultsleepdurationconsensus.pdf"),
    "windred": ("Windred et al. 2024, Sleep 47(1)", "https://pubmed.ncbi.nlm.nih.gov/37738616/"),
    "phillips": ("Phillips et al. 2017, Scientific Reports 7:3216", "https://doi.org/10.1038/s41598-017-03171-4"),
    "roenneberg": ("Roenneberg et al. 2012, Current Biology 22:939", "https://doi.org/10.1016/j.cub.2012.03.038"),
    "depner": ("Depner et al. 2019, Current Biology 29:957", "https://doi.org/10.1016/j.cub.2019.01.069"),
    "edinger": ("Edinger et al. 2021, AASM guideline (J Clin Sleep Med 17:255)", "https://pmc.ncbi.nlm.nih.gov/articles/PMC7853203/"),
    "mctq": ("Roenneberg et al. 2004, Current Biology (MCTQ)", "https://doi.org/10.1016/j.cub.2004.11.039"),
}


def _tip(level, title, text, *src):
    return {"level": level, "title": title, "text": text,
            "sources": [{"label": SOURCES[s][0], "url": SOURCES[s][1]} for s in src]}


def sleep_advice(st, sched):
    """Rules on the statistics, each tied to a published finding. Not medical advice."""
    out = []
    n = st["nights"]
    if n < 7:
        out.append(_tip("info", "Log a week or two first",
                        f"{n} night{'s' if n != 1 else ''} so far. Averages and regularity get meaningful after about 7 nights, "
                        "and the free-day comparison needs a few free days too."))
        if n == 0:
            return out
    need = sched["need_h"] * 60
    avg = st["asleep_avg"]
    if avg is not None:
        if avg < 7 * 60:
            out.append(_tip("warn", "You sleep less than 7 hours on average",
                            f"Average {_hm_dur(avg)} of sleep; {st['short_nights']} of {n} nights were under 7 h. "
                            "The AASM and the Sleep Research Society recommend 7 or more hours per night on a regular basis for adults; "
                            "less is associated with impaired performance, more errors, weight gain and other health risks. "
                            f"With your usual time to fall asleep, being in bed by {st['suggested_bed'] or 'an earlier time'} on work nights would give you {sched['need_h']:g} h.",
                            "aasm"))
        elif avg > 9 * 60:
            out.append(_tip("info", "You sleep more than 9 hours on average",
                            f"Average {_hm_dur(avg)}. The consensus statement says regularly sleeping more than 9 hours may be appropriate for young adults "
                            "and people recovering from sleep debt. If you still feel sleepy during the day, talk to a doctor.", "aasm"))
        else:
            out.append(_tip("good", "Enough sleep on average",
                            f"Average {_hm_dur(avg)}, within the recommended 7 hours or more. "
                            + (f"Still, {st['short_nights']} of {n} nights were under 7 h; the recommendation is about most nights, not the average." if st["short_nights"] >= max(2, n // 4) else ""),
                            "aasm"))
    sri = st["sri"]
    if sri is not None:
        if sri < 72:
            out.append(_tip("warn", "Your sleep times vary a lot",
                            f"Sleep Regularity Index {sri:.0f} (100 = same times every day). In a UK Biobank study (accelerometers, median 81), "
                            "people in the least regular fifth (below about 72) had a higher risk of death than the other four fifths, and regularity "
                            "predicted it better than duration. In Harvard students, irregular sleepers had a body clock shifted about 2.5 h later and lower grades. "
                            "The single most effective step: get up at the same time every day, weekends included (±30 min), and get daylight soon after waking. "
                            "Note: a diary misses awakenings at night, so diary values come out somewhat higher than accelerometer values.",
                            "windred", "phillips"))
        else:
            out.append(_tip("good", "Regular sleep times",
                            f"Sleep Regularity Index {sri:.0f}. In the UK Biobank study the median was 81; regularity predicted mortality better than duration did. Keep it up.",
                            "windred"))
    elif st["wake_sd"] is not None and st["wake_sd"] > 60:
        out.append(_tip("warn", "Your wake-up time moves a lot",
                        f"Your wake-up time varies by ±{st['wake_sd']:.0f} min. Getting up at the same time every day anchors the body clock.",
                        "phillips"))
    sjl = st["social_jetlag"]
    if sjl is not None:
        if sjl >= 60:
            out.append(_tip("warn", f"Social jet lag of {_hm_dur(sjl)}",
                            "The middle of your sleep shifts this much between work days and free days, as if you flew across time zones every weekend. "
                            "In a study of about 65 000 people, each hour of social jet lag went with roughly 33 % higher odds of being overweight (an association, not proof of cause). "
                            "Keep free-day wake-up within about an hour of work days, and go outside in the morning on free days too.",
                            "roenneberg"))
        else:
            out.append(_tip("good", "Little social jet lag",
                            f"Your mid-sleep moves only {_hm_dur(sjl)} between work and free days.", "roenneberg"))
    if st["catch_up"] is not None and st["catch_up"] >= 60:
        out.append(_tip("tip", "You catch up on free days",
                        f"You sleep {_hm_dur(st['catch_up'])} more on free days than on work days: a sign of sleep debt during the week. "
                        "In a controlled study, sleeping in at the weekend did not undo the metabolic effects of too little sleep during the week. "
                        "Shift some of that sleep to work nights instead.", "depner"))
    lat_bad = st["long_latency_nights"]
    eff = st["efficiency"]
    if (st["latency_avg"] is not None and st["latency_avg"] > 30) or (lat_bad and lat_bad >= max(3, st["latency_n"] * 0.4)) or (eff is not None and eff < 0.85):
        parts = []
        if st["latency_avg"] is not None:
            parts.append(f"you take {st['latency_avg']:.0f} min on average to fall asleep ({lat_bad} nights over 30 min)")
        if eff is not None:
            parts.append(f"you sleep {eff * 100:.0f} % of the time in bed")
        out.append(_tip("warn", "Trouble falling or staying asleep",
                        "In your diary, " + " and ".join(parts) + ". What helps most, per the AASM guideline, is cognitive behavioural therapy for insomnia (CBT-I); "
                        "one part you can start now is stimulus control: go to bed only when sleepy, get up if you can't sleep after about 20 minutes, "
                        "and get up at the same time every morning. Sleep hygiene tips alone are not recommended as a treatment. "
                        "If this happens three or more nights a week for three months and affects your days, see a doctor: that matches the definition of chronic insomnia.",
                        "edinger"))
    chrono = st["chronotype"]
    if chrono is not None and chrono >= 17 * 60 and sjl is not None and sjl >= 60:   # MSFsc at 5:00 or later
        out.append(_tip("tip", "You are a late type",
                        f"Your sleep-corrected mid-sleep on free days is {_clock(chrono)}, which counts as late. Late types carry the most sleep debt into the work week. "
                        "Morning daylight and dim light in the evening move the body clock earlier.", "mctq", "phillips"))
    if st["bed_dev"] is not None and st["bed_dev"] > 45:
        out.append(_tip("tip", "Your plan and your nights differ",
                        f"You go to bed {_hm_dur(st['bed_dev'])} away from your planned time on average. A plan you keep beats an ideal one: "
                        "set the planned wake-up time you can hold every day, then count back the sleep you need."))
    return out


@app.get("/api/sleep/stats")
def sleep_stats(days: int = 28):
    days = max(7, min(days, 365))
    end = date.today()
    start = end - timedelta(days=days)
    with db() as con:
        sched = sleep_schedule(con)
        entries = rows(con.execute("SELECT * FROM sleep WHERE night BETWEEN ? AND ? ORDER BY bed", (start.isoformat(), end.isoformat())))
    nights = [e for e in entries if e["kind"] == "night"]
    naps = [e for e in entries if e["kind"] == "nap"]
    f = [_night_facts(e) for e in nights]
    need = sched["need_h"] * 60
    work, free = [x for x in f if not x["free"]], [x for x in f if x["free"]]
    sri, sri_days = _sri(entries, [e["night"] for e in nights])

    sd_w, sd_f = _mean(x["asleep"] for x in work), _mean(x["asleep"] for x in free)
    msw, msf = _mean(x["mid"] for x in work), _mean(x["mid"] for x in free)
    sjl = abs(msf - msw) if (len(work) >= 2 and len(free) >= 2) else None
    chrono = None
    free_noalarm = [x for x in free if not x["alarm"]]
    if len(free_noalarm) >= 2 and sd_w is not None:
        msf_na, sdf_na = _mean(x["mid"] for x in free_noalarm), _mean(x["asleep"] for x in free_noalarm)
        nf = len(sched["free_days"])
        week = ((7 - nf) * sd_w + nf * sdf_na) / 7
        chrono = msf_na - (sdf_na - week) / 2 if sdf_na > sd_w else msf_na    # MCTQ: MSFsc
    lat = [x["latency"] for x in f if x["latency"] is not None]

    def target(x, k):
        part = sched["free" if x["free"] else "work"]
        h, m = map(int, part[k].split(":"))
        t = h * 60 + m - 12 * 60
        return t + 24 * 60 if t < 0 else t     # minutes after noon
    bed_dev = _mean(abs(x["bed"] - target(x, "bed")) for x in f)
    wake_dev = _mean(abs(x["wake"] - target(x, "wake")) for x in f)
    lat_avg = _mean(lat) or 0
    wh, wm = map(int, sched["work"]["wake"].split(":"))
    sugg = wh * 60 + wm - need - lat_avg - (_mean(x["awake"] for x in f if x["awake"] is not None) or 0)

    st = {
        "days": days, "nights": len(f), "naps": len(naps),
        "nap_avg": _mean((parse(e["wake"]) - parse(e["bed"])).total_seconds() / 60 for e in naps),
        "asleep_avg": _mean(x["asleep"] for x in f), "asleep_sd": _sd([x["asleep"] for x in f]),
        "in_bed_avg": _mean(x["in_bed"] for x in f),
        "short_nights": sum(x["asleep"] < 7 * 60 for x in f),
        "enough_nights": sum(x["asleep"] >= need - 15 for x in f),
        "bed_avg": _clock(_mean(x["bed"] for x in f)), "bed_sd": _sd([x["bed"] for x in f]),
        "wake_avg": _clock(_mean(x["wake"] for x in f)), "wake_sd": _sd([x["wake"] for x in f]),
        "mid_avg": _clock(_mean(x["mid"] for x in f)), "mid_sd": _sd([x["mid"] for x in f]),
        "sri": sri, "sri_days": sri_days,
        "work_asleep": sd_w, "free_asleep": sd_f,
        "work_mid": _clock(msw), "free_mid": _clock(msf),
        "social_jetlag": sjl, "catch_up": (sd_f - sd_w) if (sd_f is not None and sd_w is not None and len(free) >= 2) else None,
        "chronotype": chrono, "chronotype_clock": _clock(chrono),
        "latency_avg": _mean(lat) if lat else None, "latency_n": len(lat),
        "long_latency_nights": sum(v > 30 for v in lat),
        "efficiency": _mean(x["efficiency"] for x in f),
        "quality_avg": _mean(x["quality"] for x in f),
        "debt_7": sum(max(0, need - x["asleep"]) for x in f[-7:]) if f else None,
        "bed_dev": bed_dev, "wake_dev": wake_dev,
        "on_plan": sum(abs(x["wake"] - target(x, "wake")) <= 30 for x in f),
        "suggested_bed": f"{int(sugg // 60) % 24:02d}:{int(sugg % 60):02d}",
    }
    plain = [{k: v for k, v in x.items() if not k.startswith("_")} for x in f]
    return {"stats": st, "advice": sleep_advice(st, sched), "nights": plain, "schedule": sched,
            "naps": [{"night": e["night"], "bed": e["bed"], "wake": e["wake"]} for e in naps]}


# ---------------------------------------------------------------- teach: lesson calendar
# Timetables parsed in the browser (teach.js) and kept per day. Two timetables of the
# same day may not overlap in time.

class LessonIn(BaseModel):
    date: str
    start_min: int = Field(ge=0, le=48 * 60)
    end_min: int = Field(ge=0, le=48 * 60)
    title: str = Field(min_length=1, max_length=300)
    source: str = ""
    plan: dict


def _lesson_out(r):
    d = dict(r)
    d["plan"] = json.loads(d["plan"])
    return d


def _check_lesson(con, body: LessonIn, own_id=None):
    try:
        date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(400, "The date must look like 2026-11-09.")
    if body.end_min <= body.start_min:
        raise HTTPException(400, "The timetable ends before it starts.")
    for o in con.execute("SELECT id, title, start_min, end_min FROM lessons WHERE date = ?", (body.date,)):
        if o["id"] != own_id and body.start_min < o["end_min"] and o["start_min"] < body.end_min:
            hm = lambda m: f"{m // 60:02d}:{m % 60:02d}"
            raise HTTPException(409, f"It collides with \u201c{o['title']}\u201d ({hm(o['start_min'])}\u2013{hm(o['end_min'])}) on the same day. "
                                     "Change the start time or delete the other one first.")


@app.get("/api/lessons")
def list_lessons(start: Optional[str] = None, end: Optional[str] = None):
    q, args = "SELECT * FROM lessons", []
    if start and end:
        q += " WHERE date BETWEEN ? AND ?"
        args = [start, end]
    with db() as con:
        return [_lesson_out(r) for r in con.execute(q + " ORDER BY date, start_min", args)]


@app.get("/api/lessons/{lid}")
def get_lesson(lid: int):
    with db() as con:
        r = con.execute("SELECT * FROM lessons WHERE id = ?", (lid,)).fetchone()
        if not r:
            raise HTTPException(404, "No such timetable.")
        return _lesson_out(r)


@app.post("/api/lessons")
def create_lesson(body: LessonIn):
    with db() as con:
        _check_lesson(con, body)
        cur = con.execute("INSERT INTO lessons (date, start_min, end_min, title, source, plan, created) VALUES (?,?,?,?,?,?,?)",
                          (body.date, body.start_min, body.end_min, body.title, body.source, json.dumps(body.plan), fmt(now())))
        return _lesson_out(con.execute("SELECT * FROM lessons WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/lessons/{lid}")
def update_lesson(lid: int, body: LessonIn):
    with db() as con:
        if not con.execute("SELECT 1 FROM lessons WHERE id = ?", (lid,)).fetchone():
            raise HTTPException(404, "No such timetable.")
        _check_lesson(con, body, own_id=lid)
        con.execute("UPDATE lessons SET date=?, start_min=?, end_min=?, title=?, source=?, plan=? WHERE id=?",
                    (body.date, body.start_min, body.end_min, body.title, body.source, json.dumps(body.plan), lid))
        return _lesson_out(con.execute("SELECT * FROM lessons WHERE id = ?", (lid,)).fetchone())


@app.delete("/api/lessons/{lid}")
def delete_lesson(lid: int):
    with db() as con:
        con.execute("DELETE FROM lessons WHERE id = ?", (lid,))
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js")
def service_worker():
    # Served from the root so the app can be installed as a standalone window.
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")


# ---------------------------------------------------------------- text logs
# Human-readable mirror of the database, in the same format as the old chrono.py:
#   logs/<SEMESTER>/<code>_study_log.txt
# Regenerated after every change, so it always matches what the app shows.

def _hm(sec):
    m = round(sec / 60)
    return f"{m // 60} h {m % 60:02d} min"


def session_blocks(sess, with_course=False, day_totals=False):
    """Sessions (sorted by start) in the text-log format, grouped by day."""
    lines, current_day = [], None
    day_sum = defaultdict(int)
    for s in sess:
        if s.get("course_kind", "course") == "course":
            day_sum[parse(s["start"]).date()] += s["duration_sec"]
    for s in sess:
        st, en = parse(s["start"]), parse(s["end"])
        if st.date() != current_day:
            current_day = st.date()
            lines += ["", "=" * 50, current_day.strftime("%d.%m.%Y"), "=" * 50]
            if day_totals:
                lines.append(f"Day total: {_hm(day_sum[current_day])}" if day_sum[current_day] else "Day total: no study time")
        kind = s.get("course_kind", "course")
        prefix = ""
        if with_course:
            name = s.get("course_name") or s.get("course_code", "")
            prefix = f"[{ACTIVITY_GROUPS[kind].upper()}: {name}] " if kind in ACTIVITY_GROUPS else f"[{s['course_code'].upper()}] "
        if s.get("course_kind") == "other" and s["duration_sec"] == 0:
            lines += ["", "--- OTHER ---", prefix + "whole day"]
            lines += [f"  - {n}" for n in (s["notes"] or "").splitlines() if n.strip()]
            lines += ["--- END ---"]
            continue
        lines += ["", "--- OTHER ---" if kind == "other" else ("--- SESSION START ---" if kind == "course" else f"--- {kind.upper()} ---"),
                  prefix + f"{timedelta(seconds=s['duration_sec'])} ({st:%H:%M:%S} - {en:%H:%M:%S})"
                  + ("" if s["satisfaction"] is None else f"  [satisfaction {s['satisfaction']}/10]")]
        lines += [f"  - {n}" for n in (s["notes"] or "").splitlines() if n.strip()]
        lines += ["--- SESSION END ---" if kind == "course" else "--- END ---"]
    return lines


@app.get("/api/export")
def export_range(start: str, end: str, course_id: int = 0, semester_id: int = 0):
    """Plain-text log of one course (or all courses of a semester) between two dates, both included."""
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError:
        raise HTTPException(400, "Dates must look like 2026-10-19.")
    if d1 < d0:
        raise HTTPException(400, "The end date is before the start date.")
    q = ("SELECT s.*, c.code AS course_code, c.name AS course_name, c.kind AS course_kind FROM sessions s"
         " JOIN courses c ON c.id = s.course_id WHERE s.start >= ? AND s.start < ?")
    args = [d0.isoformat(), (d1 + timedelta(days=1)).isoformat()]
    with db() as con:
        if course_id:
            course = con.execute("SELECT * FROM courses WHERE id=?", (course_id,)).fetchone()
            if not course:
                raise HTTPException(404, "Course not found.")
            title, slug = f"{course['name']} ({course['code'].upper()})", course["code"]
            q += " AND s.course_id=?"
            args.append(course_id)
        else:
            sem = con.execute("SELECT * FROM semesters WHERE id=?", (semester_id,)).fetchone()
            if not sem:
                raise HTTPException(404, "Semester not found.")
            title, slug = f"All courses, {sem['code']}", f"{sem['code'].lower()}_all"
            sess = sorted(_semester_sessions(con, dict(sem), q, args), key=lambda s: s["start"])
        if course_id:
            sess = rows(con.execute(q + " ORDER BY s.start", args))

    study = [s for s in sess if s["course_kind"] == "course"]
    n_other = sum(1 for s in sess if s["course_kind"] == "other")
    total = sum(s["duration_sec"] for s in study)
    lines = [title, f"Period: {d0:%d.%m.%Y} - {d1:%d.%m.%Y}"]
    if study or len(study) == len(sess):
        lines.append(f"Total: {_hm(total)} in {len(study)} session{'s' if len(study) != 1 else ''}")
    for kind, label in ACTIVITY_GROUPS.items():
        act = [s for s in sess if s["course_kind"] == kind]
        if act:
            lines.append(f"{label}: {_hm(sum(s['duration_sec'] for s in act))} in {len(act)} session{'s' if len(act) != 1 else ''}"
                         " (not study time)")
    if n_other:
        lines.append(f"Other: {n_other} entr{'ies' if n_other != 1 else 'y'} (not counted as study time)")
    rated = [s for s in study if s["satisfaction"] is not None]
    if rated:
        w = sum(s["duration_sec"] for s in rated)
        lines.append(f"Satisfaction: {sum(s['satisfaction'] * s['duration_sec'] for s in rated) / w:.1f}/10"
                     f" ({len(rated)} rated)")
    if not course_id and sess:
        per = defaultdict(int)
        for s in study:
            per[s["course_code"].upper()] += s["duration_sec"]
        if per:
            lines.append("By course: " + ", ".join(f"{k} {_hm(v)}" for k, v in sorted(per.items(), key=lambda kv: -kv[1])))
    lines.append("=" * 50)
    lines += session_blocks(sess, with_course=not course_id, day_totals=True) if sess else ["", "No sessions in this period."]
    filename = f"{slug}_{d0.isoformat()}_to_{d1.isoformat()}.txt"
    return PlainTextResponse("\n".join(lines) + "\n",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def export_logs():
    today = date.today()
    with db() as con:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        for kind, title in [("other", "Other (not study time)")] + [(k, f"{v} (not study time)") for k, v in ACTIVITY_GROUPS.items()]:
            sess = rows(con.execute("SELECT s.*, c.kind AS course_kind, c.code AS course_code, c.name AS course_name"
                                    " FROM sessions s JOIN courses c ON c.id = s.course_id WHERE c.kind=? ORDER BY s.start", (kind,)))
            if not sess and kind != "other":
                continue
            text = "\n".join([title, "=" * 50] + session_blocks(sess, with_course=kind != "other")) + "\n"
            tmp = LOGS_DIR / f"{kind}_log.tmp"
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(LOGS_DIR / f"{kind}_log.txt")
        sems = rows(con.execute("SELECT * FROM semesters"))
        for sem in sems:
            courses = rows(con.execute("SELECT * FROM courses WHERE semester_id=? AND kind = 'course'", (sem["id"],)))
            if not courses:
                continue
            folder = LOGS_DIR / sem["code"]
            folder.mkdir(parents=True, exist_ok=True)
            for c in courses:
                sess = rows(con.execute("SELECT * FROM sessions WHERE course_id=? ORDER BY start", (c["id"],)))
                total_h = sum(s["duration_sec"] for s in sess) / 3600
                lines = [c["name"], f"Progress: {total_h / ECTS_HOURS:.2f} / {c['ects']:g} ECTS"]
                if c["finished"]:
                    lines.append(f"Finished: {c['grade'] or 'yes'}")
                elif c["deadline"]:
                    days = max((date.fromisoformat(c["deadline"]) - today).days, 1)
                    remaining = max(c["ects"] * ECTS_HOURS - total_h, 0)
                    lines.append(f"Pace Needed: {remaining / max(days / 7, 0.1):.2f} h/week ({days} days left)")
                lines.append("=" * 50)
                lines += session_blocks(sess)
                path = folder / f"{c['code']}_study_log.txt"
                tmp = path.with_suffix(".tmp")
                tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
                tmp.replace(path)


@app.middleware("http")
async def always_fresh(request, call_next):
    # Make the window/browser check for a newer file on every load, so edits to static/
    # show up after a plain reload instead of an old cached copy being used.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def mirror_logs(request, call_next):
    response = await call_next(request)
    if request.method != "GET" and request.url.path.startswith("/api/") and response.status_code < 400:
        try:
            export_logs()
        except Exception as e:  # never let the text mirror break the app
            print(f"Could not write text logs: {e}")
    return response


init_db()
try:
    export_logs()
except Exception as e:
    print(f"Could not write text logs: {e}")

if __name__ == "__main__":
    import uvicorn

    ap = argparse.ArgumentParser(description="Chrono study tracker")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"Chrono running at {url}  (Ctrl+C to stop the server)")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
