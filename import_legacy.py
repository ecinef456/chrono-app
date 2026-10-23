#!/usr/bin/env python3
"""One-time import of the old terminal chrono.py data into Chrono's database.

Usage:
    python import_legacy.py /path/to/study_logs            # dry run: shows what it would import
    python import_legacy.py /path/to/study_logs --apply    # actually imports
    python import_legacy.py /path/to/study_logs --apply --replace   # wipe the DB first

Reads:
    study_logs/config.json                    -> semesters + courses
    study_logs/<SEM>/<code>_study_log.txt     -> sessions (with notes)
    study_logs/breaks/breaks_data.json        -> breaks (daily totals)
"""
import argparse
import json
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import CATEGORY_KEYS, DB_PATH, LOGS_DIR, db, export_logs, init_db  # noqa: E402

# Semester dates used for weekly averages. Edit later in the app (Courses tab).
SEMESTER_DATES = {
    "FS26": ("2026-02-16", "2026-08-05"),
    "HS26": ("2026-09-14", "2027-01-25"),
}

DATE_RE = re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{4})\s*$")
SESSION_RE = re.compile(
    r"^\s*(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})\s*\(\s*(\d{2}):(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2}):(\d{2})\s*\)")
NOTE_RE = re.compile(r"^\s+-\s+(.*)$")


def parse_deadline(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%d.%m.%Y").date().isoformat()
    except ValueError:
        return None


def parse_log(path: Path):
    """Return list of dicts: start, end, duration_sec, notes."""
    sessions, cur_date, current = [], None, None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = DATE_RE.match(line)
        if m:
            cur_date = date(int(m[3]), int(m[2]), int(m[1]))
            current = None
            continue
        m = SESSION_RE.match(line)
        if m and cur_date:
            days = int(m[1] or 0)
            dur = days * 86400 + int(m[2]) * 3600 + int(m[3]) * 60 + int(m[4])
            s_t = datetime.combine(cur_date, datetime.min.time()).replace(
                hour=int(m[5]), minute=int(m[6]), second=int(m[7]))
            e_t = datetime.combine(cur_date, datetime.min.time()).replace(
                hour=int(m[8]), minute=int(m[9]), second=int(m[10]))
            # The log date is the day the session was SAVED. A start after the end means it began the day before.
            if s_t > e_t:
                s_t -= timedelta(days=1)
            # Manual entries in the old app were stamped "now - minutes"; keep start/end but never let
            # the duration exceed the span.
            span = int((e_t - s_t).total_seconds())
            if span < dur:
                s_t = e_t - timedelta(seconds=dur)
            current = {"start": s_t, "end": e_t, "duration_sec": dur, "notes": []}
            sessions.append(current)
            continue
        m = NOTE_RE.match(line)
        if m and current is not None:
            current["notes"].append(m[1].strip())
            continue
        if "SESSION END" in line:
            current = None
    for s in sessions:
        s["notes"] = "\n".join(s["notes"])
    return [s for s in sessions if s["duration_sec"] > 0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path, help="Path to the old study_logs folder")
    ap.add_argument("--apply", action="store_true", help="Write to the database (default: dry run)")
    ap.add_argument("--replace", action="store_true", help="Delete everything in the database first")
    args = ap.parse_args()

    folder = args.folder.expanduser().resolve()
    cfg_path = folder / "config.json"
    if not cfg_path.exists():
        sys.exit(f"Can't find {cfg_path}. Point this script at the study_logs folder.")
    config = json.loads(cfg_path.read_text())

    init_db()
    with db() as con:
        existing = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    if existing and args.apply and not args.replace:
        sys.exit(f"The database already holds {existing} sessions. Re-run with --replace to start over.")

    plan = []
    total_sessions = 0
    for sem_code, courses in config.items():
        sem_dir = folder / sem_code
        course_plans = []
        for code, c in courses.items():
            if not isinstance(c, dict):
                continue
            log = sem_dir / f"{code}_study_log.txt"
            sess = parse_log(log) if log.exists() else []
            total_sessions += len(sess)
            course_plans.append((code, c, sess))
        plan.append((sem_code, course_plans))

    print(f"Source: {folder}\n")
    for sem_code, course_plans in plan:
        print(f"{sem_code}")
        for code, c, sess in course_plans:
            h = sum(s["duration_sec"] for s in sess) / 3600
            print(f"  {code:<6} {c.get('name', '')[:50]:<50} {len(sess):>4} sessions  {h:7.2f} h")
    breaks_file = folder / "breaks" / "breaks_data.json"
    breaks = json.loads(breaks_file.read_text()) if breaks_file.exists() else {}
    print(f"\nBreaks: {sum(len(v) for v in breaks.values())} daily totals over {len(breaks)} days")
    print(f"Total sessions: {total_sessions}")

    if not args.apply:
        print("\nDry run only. Add --apply to import.")
        return

    with db() as con:
        if args.replace:
            for t in ("sessions", "breaks", "courses", "semesters"):
                con.execute(f"DELETE FROM {t}")
            con.execute("UPDATE timer SET course_id=NULL, session_start=NULL, segment_start=NULL,"
                        " pause_start=NULL, accumulated_sec=0 WHERE id=1")
        for si, (sem_code, course_plans) in enumerate(plan):
            sd, ed = SEMESTER_DATES.get(sem_code, (None, None))
            row = con.execute("SELECT id FROM semesters WHERE code=?", (sem_code,)).fetchone()
            if row:
                sem_id = row[0]
            else:
                sem_id = con.execute("INSERT INTO semesters (code,start_date,end_date,sort) VALUES (?,?,?,?)",
                                     (sem_code, sd, ed, si + 1)).lastrowid
            for ci, (code, c, sess) in enumerate(course_plans):
                cat = c.get("category") if c.get("category") in CATEGORY_KEYS else None
                grade = c.get("grade")
                row = con.execute("SELECT id FROM courses WHERE semester_id=? AND code=?",
                                  (sem_id, code)).fetchone()
                if row:
                    cid = row[0]
                else:
                    cid = con.execute(
                        "INSERT INTO courses (semester_id,code,name,ects,deadline,category,finished,grade,sort)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (sem_id, code, c.get("name", code), float(c.get("ects", 0)),
                         parse_deadline(c.get("deadline")), cat, int(bool(c.get("finished"))),
                         None if grade is None else str(grade), ci + 1)).lastrowid
                for s in sess:
                    con.execute("INSERT INTO sessions (course_id,start,end,duration_sec,notes,source)"
                                " VALUES (?,?,?,?,?,'legacy')",
                                (cid, s["start"].strftime("%Y-%m-%dT%H:%M:%S"),
                                 s["end"].strftime("%Y-%m-%dT%H:%M:%S"), s["duration_sec"], s["notes"]))
        for d, types in breaks.items():
            for b_type, secs in types.items():
                secs = int(secs)
                if secs <= 0:
                    continue
                st = datetime.strptime(d, "%Y-%m-%d").replace(hour=12)
                con.execute("INSERT INTO breaks (start,end,duration_sec,type,source) VALUES (?,?,?,?,'legacy')",
                            (st.strftime("%Y-%m-%dT%H:%M:%S"),
                             (st + timedelta(seconds=secs)).strftime("%Y-%m-%dT%H:%M:%S"), secs, b_type))
    export_logs()
    print(f"\nImported into {DB_PATH}\nText logs written to {LOGS_DIR}")


if __name__ == "__main__":
    main()
