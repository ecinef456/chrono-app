#!/usr/bin/env python3
"""Chrono — local study-time tracker.

Run:  python app.py            (opens http://127.0.0.1:8765 in your browser)
      python app.py --no-browser --port 9000
"""
import argparse
import sqlite3
import threading
import webbrowser
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "chrono.db"
STATIC_DIR = BASE_DIR / "static"
LOGS_DIR = BASE_DIR / "logs"  # readable .txt copies of your sessions (see export_logs)

ECTS_HOURS = 30  # hours of work per ECTS credit

# Course categories. Keys are stored in the DB; label + colors are used by the UI.
# Colors are a validated colour-blind-safe order (light / dark mode).
CATEGORIES = [
    {"key": "master", "label": "Master", "light": "#2a78d6", "dark": "#3987e5"},
    {"key": "lehrdiplom", "label": "Lehrdiplom", "light": "#eda100", "dark": "#c98500"},
    {"key": "job", "label": "Job", "light": "#6250d6", "dark": "#9085e9"},
    {"key": "energy_compatible", "label": "Energy (compatible)", "light": "#1baf7a", "dark": "#199e70"},
    {"key": "energy_incompatible", "label": "Energy (incompatible)", "light": "#eb6834", "dark": "#d95926"},
]
CATEGORY_KEYS = [c["key"] for c in CATEGORIES]

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
    UNIQUE (semester_id, code)
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    start TEXT NOT NULL,          -- local time YYYY-MM-DDTHH:MM:SS
    end TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,-- time actually studied (excludes breaks)
    notes TEXT DEFAULT '',
    source TEXT DEFAULT 'timer'   -- timer | manual | legacy
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
    DATA_DIR.mkdir(exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)


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


class SessionIn(BaseModel):
    course_id: int
    start: str                  # YYYY-MM-DDTHH:MM[:SS]
    end: str
    duration_sec: Optional[int] = None  # defaults to end - start
    notes: str = ""


class StartIn(BaseModel):
    course_id: int


class ResumeIn(BaseModel):
    break_type: str


class StopIn(BaseModel):
    save: bool = True
    notes: str = ""


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
            "today": date.today().isoformat()}


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
            return rows(con.execute("SELECT * FROM courses WHERE semester_id=? ORDER BY sort, id",
                                    (semester_id,)))
        return rows(con.execute("SELECT * FROM courses ORDER BY semester_id, sort, id"))


@app.post("/api/courses")
def create_course(body: CourseIn):
    check_category(body.category)
    with db() as con:
        try:
            sort = con.execute("SELECT COALESCE(MAX(sort),0)+1 FROM courses WHERE semester_id=?",
                               (body.semester_id,)).fetchone()[0]
            cur = con.execute(
                "INSERT INTO courses (semester_id,code,name,ects,deadline,category,finished,grade,sort)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (body.semester_id, body.code.strip().lower(), body.name.strip(), body.ects,
                 body.deadline, body.category, int(body.finished), body.grade, sort))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"A course with initials '{body.code}' already exists in this semester.")
        return {"id": cur.lastrowid}


@app.put("/api/courses/{cid}")
def update_course(cid: int, body: CourseIn):
    check_category(body.category)
    with db() as con:
        try:
            con.execute(
                "UPDATE courses SET semester_id=?, code=?, name=?, ects=?, deadline=?, category=?,"
                " finished=?, grade=? WHERE id=?",
                (body.semester_id, body.code.strip().lower(), body.name.strip(), body.ects,
                 body.deadline, body.category, int(body.finished), body.grade, cid))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"A course with initials '{body.code}' already exists in this semester.")
    return {"ok": True}


@app.delete("/api/courses/{cid}")
def delete_course(cid: int):
    with db() as con:
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
    q = ("SELECT s.*, c.code AS course_code, c.name AS course_name, c.category"
         " FROM sessions s JOIN courses c ON c.id = s.course_id WHERE 1=1")
    args = []
    if semester_id:
        q += " AND c.semester_id=?"
        args.append(semester_id)
    if course_id:
        q += " AND s.course_id=?"
        args.append(course_id)
    q += " ORDER BY s.start DESC LIMIT ?"
    args.append(limit)
    with db() as con:
        return rows(con.execute(q, args))


def _session_values(body: SessionIn):
    start, end = norm_ts(body.start), norm_ts(body.end)
    span = int((parse(end) - parse(start)).total_seconds())
    if span <= 0:
        raise HTTPException(400, "End must be after start.")
    dur = span if body.duration_sec is None else int(body.duration_sec)
    if dur <= 0 or dur > span:
        raise HTTPException(400, "Studied time must be positive and fit between start and end.")
    return start, end, dur


@app.post("/api/sessions")
def create_session(body: SessionIn):
    start, end, dur = _session_values(body)
    with db() as con:
        cur = con.execute("INSERT INTO sessions (course_id,start,end,duration_sec,notes,source)"
                          " VALUES (?,?,?,?,?, 'manual')",
                          (body.course_id, start, end, dur, body.notes.strip()))
        return {"id": cur.lastrowid}


@app.put("/api/sessions/{sid}")
def update_session(sid: int, body: SessionIn):
    start, end, dur = _session_values(body)
    with db() as con:
        con.execute("UPDATE sessions SET course_id=?, start=?, end=?, duration_sec=?, notes=? WHERE id=?",
                    (body.course_id, start, end, dur, body.notes.strip(), sid))
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
    c = con.execute("SELECT id, code, name, category FROM courses WHERE id=?", (t["course_id"],)).fetchone()
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
            cur = con.execute("INSERT INTO sessions (course_id,start,end,duration_sec,notes,source)"
                              " VALUES (?,?,?,?,?,'timer')",
                              (t["course_id"], t["session_start"], fmt(end), acc, body.notes.strip()))
            saved = cur.lastrowid
        con.execute("UPDATE timer SET course_id=NULL, session_start=NULL, segment_start=NULL,"
                    " pause_start=NULL, accumulated_sec=0 WHERE id=1")
        return {"saved_session_id": saved, "duration_sec": acc}


# ---------------------------------------------------------------- stats

def _d(s):
    return date.fromisoformat(s) if s else None


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


@app.get("/api/stats")
def stats(semester_id: int):
    today = date.today()
    with db() as con:
        sem = con.execute("SELECT * FROM semesters WHERE id=?", (semester_id,)).fetchone()
        if not sem:
            raise HTTPException(404, "Semester not found.")
        sem = dict(sem)
        courses = rows(con.execute("SELECT * FROM courses WHERE semester_id=? ORDER BY sort, id",
                                   (semester_id,)))
        sess = rows(con.execute(
            "SELECT s.course_id, s.start, s.duration_sec FROM sessions s JOIN courses c ON c.id=s.course_id"
            " WHERE c.semester_id=?", (semester_id,)))
        timer = _timer(con)

    # Include the live timer so numbers move while you study.
    if timer["state"] != "idle" and timer.get("course") and any(c["id"] == timer["course"]["id"] for c in courses):
        sess.append({"course_id": timer["course"]["id"], "start": timer["session_start"],
                     "duration_sec": timer["elapsed_sec"]})

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
        target = c["ects"] * ECTS_HOURS
        remaining = max(target - pc["total"], 0)
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
            "hours": round(pc["total"], 3),
            "target_hours": target,
            "ects_done": round(pc["total"] / ECTS_HOURS, 3),
            "avg_week": round(pc["total"] / elapsed_weeks, 3),
            "this_week": round(pc["week"], 3),
            "needed_week": round(needed, 3) if needed is not None else None,
            "days_left": days_left,
            "last_session": pc["last"].isoformat() if pc["last"] else None,
        })

    total_h = sum(c["hours"] for c in out_courses)
    ects_target = sum(c["ects"] for c in courses)
    ects_done = sum(c["ects"] if c["finished"] else min(c["ects_done"], c["ects"]) for c in out_courses)

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
    }


# ---------------------------------------------------------------- static

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

def export_logs():
    today = date.today()
    with db() as con:
        sems = rows(con.execute("SELECT * FROM semesters"))
        for sem in sems:
            courses = rows(con.execute("SELECT * FROM courses WHERE semester_id=?", (sem["id"],)))
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
                current_day = None
                for s in sess:
                    st, en = parse(s["start"]), parse(s["end"])
                    if st.date() != current_day:
                        current_day = st.date()
                        lines += ["", "=" * 50, current_day.strftime("%d.%m.%Y"), "=" * 50]
                    lines += ["", "--- SESSION START ---",
                              f"{timedelta(seconds=s['duration_sec'])} ({st:%H:%M:%S} - {en:%H:%M:%S})"]
                    lines += [f"  - {n}" for n in (s["notes"] or "").splitlines() if n.strip()]
                    lines += ["--- SESSION END ---"]
                path = folder / f"{c['code']}_study_log.txt"
                tmp = path.with_suffix(".tmp")
                tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
                tmp.replace(path)


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
