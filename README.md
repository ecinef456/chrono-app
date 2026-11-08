# Chrono

A local study-time tracker. It's a small Python server with a SQLite database, and you use it in the browser or as an installed app window. Everything stays on your laptop, and it works offline.

## First start

```bash
cd chrono-app
./start.sh
```

The first run creates `.venv` and installs FastAPI and Uvicorn. After that, Chrono opens at http://127.0.0.1:8765. Leave the terminal running, or see "Run in the background" below.

## Download the app (Linux, Windows, macOS)

You don't need Python or a terminal for this: on the GitHub page, open **Releases** and download the file for your system.

| System | File | First start |
|---|---|---|
| Linux | `Chrono-x86_64.AppImage` | Make it executable (right-click → Properties → "Allow executing", or `chmod +x Chrono-x86_64.AppImage`), then double-click it. |
| Windows | `Chrono-windows.exe` | Double-click. Windows SmartScreen warns about an unknown publisher: *More info* → *Run anyway*. |
| macOS | `Chrono-macos.zip` | Unzip, drag `Chrono.app` into Applications. The first time, right-click → *Open* → *Open* (the app is not signed by Apple). |

The app keeps its data in your user folder, outside the app file, so a new version keeps everything: `~/.local/share/chrono` (Linux), `%APPDATA%\Chrono` (Windows), `~/Library/Application Support/Chrono` (macOS). Run from this git folder instead, Chrono keeps using `data/` and `logs/` here, as before. `CHRONO_HOME=/some/folder` overrides both.

On first launch Chrono asks which parts you want (see *Features* below).

**Making a release** (for the maintainer): `git tag v1.0.0 && git push origin v1.0.0`. GitHub Actions (`.github/workflows/release.yml`) builds the three files on Linux, Windows and macOS machines and attaches them to the release in about ten minutes. *Actions → Build desktop apps → Run workflow* builds them without a release (download under the run's *Artifacts*).

## Features

The study timer (Dashboard, Log, Courses) is always there. Sport & Code, Teach and Sleep are optional: Chrono asks on first launch, and the ⚙ button in the header changes the choice any time. Switching a feature off only hides it; its data stays in the database. An existing installation that already uses a feature finds it pre-ticked.

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
- **Export .txt** (Log tab). Pick a course (or all courses) and a date range, or use *This week* / *Last week*, then press *Export .txt*. You get the entries shown, both dates included, in the same format as the text logs plus totals per day and for the period.
- **Other** (in the entry form's course list). For noting what you did on a day you didn't study: sick, moving, a trip. Tick *Whole day* for a day note without times, or give a time span. It is the same in every semester, needs a note, and never counts as study time (no hours, charts, ECTS or streak). It shows in the Log and the exports, and in `logs/other_log.txt`.
- **Courses tab.** Add, edit or finish courses (with grade), set semester dates, and create new semesters.
- **Courses across semesters** (e.g. a master thesis). In the course form, tick *Runs across several semesters*, set a start date and deadline, and pick the semester where its ECTS count. It then appears in every semester between those dates (each semester needs a start date). Progress adds up all its hours; *Ø semester* and the charts count only the hours of the semester you are viewing, including the break before the next one starts. Its ECTS are counted only once, in the semester you picked.

## Sport & Code

Sport and coding are tracked like courses, in every semester, but **never count as study time** (not in hours, ECTS, charts, streak or the "studied today" figure).

- **Timing:** their chips sit after the courses, with a dashed outline. Start, pause and stop work as usual; past entries go through *Add past entry* (grouped as Courses / Sport / Code / Not study time).
- **Today bar:** sport, code and timed *Other* entries show as dotted blocks, so the bar has no unexplained gaps but study time stays solid.
- **Sport & Code tab:** for each group, this week / this month / average per week, and stacked bars per week (16 weeks) and per month (12 months), one colour per type.
- **Commits:** each code project can point to its local clone (e.g. `~/git/chrono-app`). Chrono reads your commits there with `git log` (all branches, including fetched remote ones), so private repos work and no GitHub login is needed. It shows commits per week, lines added/removed and the latest commits. Commits made elsewhere show up after a `git pull` / `git fetch`. Only your commits count: those matching the repo's `user.email` or your GitHub user.
- **Types:** add, rename, hide or delete sport types and code projects under *Edit sport types* / *Edit code projects*. A type with history can only be hidden, so its hours stay in your charts.

### chrono.local.json (personal, not in git)

Your starting types and GitHub user live in `chrono.local.json`, which is gitignored (see `chrono.local.example.json`). It is read once, the first time the server starts with it; after that, change types in the app.

## Teach (lesson calendar and live lesson plan)

The *Teach* tab keeps your lesson timetables in a calendar and shows, live, where you should be in a lesson. It is completely separate from the study timer and saves nothing in your study logs.

- **Calendar.** Two school years to pick from (this one and the next, e.g. *2026 – 2027* and *2027 – 2028*; the list moves on by itself each August). Below, the twelve months from August to July, one square per day. Days with a timetable are coloured; today is outlined.
- **A day.** Click a square: you see that day's timetables and can add as many as you like, as long as their times do not overlap (otherwise you get a message naming the one it collides with). Add them by dropping `.typ` files (notes or timetables, several at once), choosing files, pasting the `#let lesson = ( … )` block, or with the editor. A timetable that carries its own `date` goes to that date; one without goes to the day you opened. Dropping a file anywhere in Chrono works too.
- **Titles.** A timetable is named after four fields: `date` (yyyy.mm.dd), `institution` (ETH, a school), `class` (Physics, Physik SF) and `topic` (Elektromotor), joined as *2026.11.09 · ETH · Physics · Elektromotor*.
- **Editor** (*New in the editor*, or *Edit* on a timetable). Date, the four fields, start, hour length, break, buffer, then hours → activities → steps, with buttons to add, move and remove them and steppers for the minutes. Each hour shows *planned / target* minutes; *fit* puts the missing minutes into the last activity. *Save to calendar*, *▶ Run now* (without saving), *Copy Typst* / *Download .typ* for your notes.
- **Examples.** A 1-hour and a 2-hour timetable on every day page: *▶ live* shows them at once, *edit* opens them in the editor, *.typ* downloads them (they also sit in `static/examples/`).
- **Live, with a buffer** (`buffer: 20` in the timetable: 20 % of every hour kept free at its start, for questions and interruptions). The activities of an hour then fill 80 % of it. Chrono stretches them evenly (whole minutes) over the full hour and draws the whole lesson as one wide strip: each activity in its own colour, breaks always green, the steps as dotted lines. A red bar marks the exact time, and a framed *window* of ±10 % of an hour around it shows the allowed zone; the rest of the strip is dimmed. At the very start the window runs from the bar 20 % ahead, at the very end 20 % back. Under the strip: what lies in the window, the current part in bold. The clock sits alone on the top line, the *Day*, *Calendar* and *Edit* buttons on the right.
- **Live, without a buffer** (`buffer: 0` or none): the classic view with the current part in large type, the current step, time left and what comes next.
- **Settings come from the timetable** (`start`, `hour-length`, `break-length`, `buffer`, optional `hour-2-start`). You can change them while it runs; for a saved timetable the change is saved too. *Start now* moves the whole plan so it starts this minute; *−1 / +1 min* nudge it; clicking a row in the plan makes that step start now. *Back to plan* undoes the shift.
- Space does nothing in this tab, so it can't start the study timer by accident.

The timetable format (the same block works in your Typst notes with `unified-preamble.typ`):

```typst
#let lesson = (
  date: "2026.11.09", institution: "ETH", class: "Physics", topic: "Elektromotor",
  start: "10:20", hour-length: 40, break-length: 5, buffer: 20,
  hour1: (
    (4, [Einstieg], ((1, [Begrüssung]), (3, [Aktivatoren A1, A2]))),
    ...                                   // activities of an hour: 32 min (= 40 - 20 %)
  ),
  hour2: ( ... ),                         // or only hour1; hour3 ... work too
)
#timetable(lesson)
```

## Sleep

A sleep diary with a schedule, statistics and advice drawn from sleep research.

- **Log last night** each morning: when you went to bed (lights out) and woke up for good; optionally how long you took to fall asleep, how long you were awake in the night, how rested you feel (1–5), whether a free day followed and whether an alarm woke you. *a nap instead* logs a nap. Times after midnight are handled for you.
- **Tonight**: your planned bed and wake-up time for tonight (work day or free day), the time left until bedtime, and the bedtime that would give you your sleep goal with your usual time to fall asleep. *Edit schedule* sets the goal, your free days and the times.
- **Your sleep** (14, 28 or 90 days): average sleep, nights with 7 h or more, the Sleep Regularity Index, average bed and wake-up time and how much the wake-up varies, social jet lag (how far the middle of your sleep moves between work and free days), and the sleep you missed in the last 7 nights. Below, a timeline: one row per night, asleep in blue, nights under 7 h in orange with ▲, awake in bed in light blue, your schedule dashed, **F** for a free day after.
- **What your data says**: rules applied to your numbers, each linked to its source: the AASM/SRS consensus on sleep duration (Watson et al. 2015), sleep regularity and mortality (Windred et al. 2024) and academic performance (Phillips et al. 2017), social jet lag (Roenneberg et al. 2012), weekend catch-up sleep (Depner et al. 2019), chronotype from the Munich ChronoType Questionnaire (Roenneberg et al. 2004), and the AASM guideline on insomnia treatment (Edinger et al. 2021). It is not a diagnosis; the page says when to see a doctor.

How the numbers are computed (`/api/sleep/stats` in `app.py`): sleep = wake-up − (bedtime + time to fall asleep) − time awake. The regularity index compares 5-minute steps 24 h apart over consecutive logged nights (100 = the same times every day, 0 = random); a diary misses short awakenings, so it reads somewhat higher than the accelerometer values in the studies. Social jet lag = |mid-sleep on free days − mid-sleep on work days|; chronotype = mid-sleep on free days without alarm, corrected for catch-up sleep (MSFsc).

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

## Make it an app (from this folder, Linux)

The downloads above are the easy way. From the git folder, run this once to get Chrono as its own desktop app:

```bash
./install-desktop.sh
```

Chrono then appears in your app menu (search for "Chrono") with its own window, icon and taskbar entry. Right-click it to pin it. If the background service from `./install.sh` is running, the window connects to it. Otherwise the window starts the server itself and stops it when you close the window. The first run downloads the Qt window toolkit (about 150 MB). Re-run the script if you move the folder.

While the timer runs, the app's taskbar icon shows the minutes as a badge, and a thin bar on the icon fills over each hour (KDE Plasma, and GNOME with Dash to Dock). The icon itself comes from the launcher file, so a ticking clock can't be drawn into it.

On Linux the window has no title bar from the desktop: Chrono's own header is the title bar. Drag an empty part of it to move the window, double-click it to maximize, use the three buttons on the right to minimize, maximize and close, and drag the window's edges to resize it. (KDE's shortcuts work too: Meta+drag moves, Meta+right-drag resizes.)

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

- **Categories and colours:** `CATEGORIES` in `app.py`. The CSS colour variables are `--c-<key>` in `static/style.css`. All colours come from Okabe & Ito's colour-blind-safe palette (categories, Teach strip, charts) and ColorBrewer ramps (heat map, satisfaction); where colour carries meaning, a symbol (✓, ▲) says it too.
- **Break types:** `BREAK_TYPES` in `app.py`.
- **Buy me a coffee:** set `KOFI_USER` and/or `GITHUB_SPONSORS_USER` in `app.py`. The header button opens the page directly when only one is set, or a short choice (Ko-fi for a quick card tip without an account, GitHub Sponsors for people with a GitHub account, fee-free) when both are. Both empty: no button. For the "Sponsor" button on the GitHub page, fill in `.github/FUNDING.yml`.
- **Hours per ECTS:** `ECTS_HOURS` in `app.py`.
