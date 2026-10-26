# Chrono

A local study-time tracker. It's a small Python server with a SQLite database, and you use it in the browser or as an installed app window. Everything stays on your laptop, and it works offline.

## First start

```bash
cd chrono-app
./start.sh
```

The first run creates `.venv` and installs FastAPI and Uvicorn. After that, Chrono opens at http://127.0.0.1:8765. Leave the terminal running, or see "Run in the background" below.

## Import your old logs (once)

Point the importer at your old `study_logs` folder, the one containing `config.json`:

```bash
.venv/bin/python import_legacy.py ~/path/to/study_logs            # dry run: shows what it found
.venv/bin/python import_legacy.py ~/path/to/study_logs --apply    # imports
```

The importer brings in:
- Semesters and courses from `config.json`, including category, deadline, finished status and grade.
- Every session from `<SEM>/<code>_study_log.txt`, with its notes. A session that ran past midnight is dated to the day it started.
- Break totals from `breaks/breaks_data.json`.

Semester start dates are preset (FS26: 16.02.2026, HS26: 14.09.2026). You can change them in the Courses tab. Weekly averages count from the start date.

To import again from scratch, add `--replace`. This wipes the database first.

## Using it

- **Start / Pause / Stop.** Pick a course chip and press Start, or press the space bar. Space also pauses.
- **Resume after a pause.** Resuming asks whether the break was necessary, which logs the break like before.
- **Stop.** Stop asks for notes before saving, and you can also discard the session there.
- **The timer lives in the database.** Closing the tab, closing the browser or rebooting won't lose a running session.
- **Add past entry** (on the timer, or in the Log tab). Pick a date and the from/to times, or type a duration: it keeps the end time and moves the start. Breaks in between go in their own field and are subtracted from the time counted.
- **Rate your sessions.** When you stop (or add/edit an entry), you can rate from 0 to 10 *how satisfied you are with what you got done*, compared with what you hoped to get done in that time. It's optional; unrated sessions, including all imported ones, are simply left out of the satisfaction charts.
- **Log tab.** Shows every session grouped by day. You can edit or delete any entry.
- **Courses tab.** Add, edit or finish courses (with grade), set semester dates, and create new semesters.

## What the numbers mean

| Column | Meaning |
|---|---|
| Deadline | The course deadline and the days left |
| This week | Hours since Monday |
| Ø semester | Total hours ÷ weeks since the semester start date |
| Needed | (ECTS × 30 h − hours done) ÷ weeks left until the deadline. Green when Ø semester ≥ Needed, red otherwise |

### Satisfaction

All satisfaction averages are weighted by time studied, so a 3 h session counts six times as much as a 30 min one. The hour-of-day chart spreads each session over the clock hours it covers and hides hours with less than 15 min of rated study. The hour axis runs from 05:00 to 04:00, so late-night sessions appear after 23:00.

For the semester's ECTS total, finished courses count in full, the same as in the old script.

## Make it an app

Run this once to get Chrono as its own desktop app, with no browser involved:

```bash
./install-desktop.sh
```

Chrono then appears in your app menu (search for "Chrono") with its own window, icon and taskbar entry. Right-click it to pin it. If the background service from `./install.sh` is running, the window connects to it. Otherwise the window starts the server itself and stops it when you close the window. The first run downloads the Qt window toolkit (about 150 MB). Re-run the script if you move the folder.

You can still open http://127.0.0.1:8765 in any browser at the same time; both show the same data.

## Start automatically (Linux, recommended)

Run this once:

```bash
./install.sh
```

It sets up a small background service that starts Chrono every time you log in. You never touch the terminal again: open the installed app icon, or http://127.0.0.1:8765. To turn autostart off, run `systemctl --user disable --now chrono`.

## Your data

- `data/chrono.db` is the real data store, a single SQLite file. To back it up, copy it somewhere safe.
- `logs/<SEMESTER>/<code>_study_log.txt` holds readable text logs in the same format as the old script: a header with progress and pace, sessions grouped by day, notes, and the rating as `[satisfaction 7/10]` at the end of a session line. They are rewritten after every change (start/stop, a manual entry, an edit, a deletion), so they always match the app. Editing them has no effect, so make changes in the app. They also stay compatible with `import_legacy.py`.

## Customise

- **Categories and colours:** `CATEGORIES` in `app.py`. The CSS colour variables are `--c-<key>` in `static/style.css`.
- **Break types:** `BREAK_TYPES` in `app.py`.
- **Hours per ECTS:** `ECTS_HOURS` in `app.py`.
