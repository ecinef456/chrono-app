/* Chrono front end — Alpine.js component + ECharts. */

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", "X-Lang": (window.I18N && I18N.lang) || "en" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : j.detail.map(d => d.msg).join("; "); } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const pad = n => String(n).padStart(2, "0");
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = d => `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const parseLocal = s => { const [d, t = "00:00:00"] = s.split("T"); const [y, m, dd] = d.split("-").map(Number); const [h, mi, se = 0] = t.split(":").map(Number); return new Date(y, m - 1, dd, h, mi, se); };
// Clock time in hours relative to today's midnight (e.g. 13:10 -> 13.17; tomorrow 01:00 -> 25).
// Uses the wall clock, not elapsed time, so the 23 h and 25 h days when summer time starts or ends
// don't shift the today bar by an hour.
// "Now" as shown on the computer's clock, taken from the Chrono server rather than from the
// window. The window's own timezone can be wrong (privacy settings, embedded engines, the
// summer/winter time switch), while the server always uses the system clock.
let serverClock = null; // { wall: Date built from the server's local time, at: Date.now() when received }
const syncClock = t => { if (t && t.server_now) serverClock = { wall: parseLocal(t.server_now), at: Date.now() }; };
const wallNow = () => (serverClock ? new Date(serverClock.wall.getTime() + (Date.now() - serverClock.at)) : new Date());

const clockHours = d => {
  const today = wallNow(); today.setHours(0, 0, 0, 0);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((day - today) / 864e5);
  return dayDiff * 24 + d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
};
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();


function loadScript(src) {
  return new Promise((ok, fail) => { const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = fail; document.head.appendChild(el); });
}

function chrono() {
  return {
    meta: { categories: [], break_types: [] },
    semesters: [], semesterId: null, courses: [], stats: null, sessions: [], recent: [],
    timer: { state: "idle" }, timerFetchedAt: Date.now(),
    selectedId: store.get("chrono-course", null),
    tab: store.get("chrono-tab", "dash"),
    theme: store.get("chrono-theme", "system"),
    logCourse: 0, logFrom: "", logTo: "", logDays: 45, startMs: 0, lang: (window.I18N && I18N.lang) || "en", langOpen: false, langs: window.LANGS || { en: "English" }, tick: 0, teach: store.get("chrono-teach", null), teachPaste: "", teachErr: "", teachDrag: false, teachView: store.get("chrono-teach-view", "cal"), teachYear: null, teachDay: null, lessons: [], ed: null, edId: null, edErr: "", features: null, featPick: {}, featCount: { mode: "ects", ects_hours: 30, lesson_min: 30 }, frameless: false, sleepList: [], sleepSt: null, sleepDays: store.get("chrono-sleep-days", 28), sleepForm: null, sleepErr: "", sleepSched: null, sleepSchedOpen: false, askMsg: "", askOk: "Delete", phone: { svg: "", link: "", err: "" }, act: null, actNew: { sport: "", code: "" }, actErr: "", toastMsg: "",
    entry: {}, entryErr: "", stopNotes: "", stopRating: null,
    sm: { fields: [] },
    courseForm: {}, courseErr: "", semForm: {}, newSem: {}, semErr: "",
    charts: {},

    /* ---------------- lifecycle */
    async init() {
      // Alpine calls init() by itself; never also put x-init="init()" on the body, or everything loads twice.
      if (this._started) return; this._started = true;
      this.applyTheme();
      // The dashboard first, with the requests in parallel; the other tabs load afterwards, in the background.
      const [meta, semesters] = await Promise.all([api("/api/meta"), api("/api/semesters"), this.refreshTimer()]);
      this.meta = meta; this.semesters = semesters;
      const today = this.meta.today;
      const current = this.semesters.find(s => s.start_date && s.start_date <= today && (!s.end_date || today <= s.end_date));
      const saved = store.get("chrono-semester", null);
      this.semesterId = (this.semesters.find(s => s.id === saved) || current || this.semesters.filter(s => s.course_count).pop() || this.semesters[0] || {}).id ?? null;
      try { await Promise.all([this.loadSemester(), window.I18N?.ready]); this.lang = I18N.lang; }
      finally {
        // The first screen is filled: show it. Charts come a moment later (the chart library is big).
        this.$nextTick(() => { document.body.classList.add("ready"); this.startMs = Math.round(performance.now()); });
        loadScript("/static/vendor/echarts.min.js").then(() => { this.renderCharts(); this.renderActCharts(); }).catch(() => {});
      }
      // Dropping a .typ file anywhere opens it in Teach.
      window.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
      window.addEventListener("drop", e => { if (e.dataTransfer?.files?.length && this.tab !== "teach") { e.preventDefault(); this.tab = "teach"; this.teachFiles(e.dataTransfer.files); } });
      this.$watch("tab", v => { store.set("chrono-tab", v); if (v === "dash") this.$nextTick(() => this.renderCharts()); if (v === "sport" || v === "code") this.loadActivities(); if (v === "teach") this.teachInit(); if (v === "sleep") this.sleepInit(); });
      if (this.tab === "act") this.tab = "sport";          // the old combined tab
      if (this.tab === "sport" || this.tab === "code") this.loadActivities();
      if (this.teachView === "run" && !this.teach || this.teachView === "edit") this.teachView = "cal";
      if (this.tab === "teach") this.teachInit();
      if (this.tab === "sleep") this.sleepInit();
      this.winInit();
      this.loadFeatures().then(() => this.preload());
      setInterval(() => { this.tick++; this.updateTitle(); }, 1000);
      setInterval(() => this.refreshTimer(), 30000);
      setInterval(() => { if (this.timer.state === "running") this.loadStats(); }, 60000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) { this.refreshTimer(); this.loadSemester(); } });
      window.addEventListener("resize", () => Object.values(this.charts).forEach(c => c.resize()));
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.renderCharts());
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    },

    async loadSemester() {
      if (!this.semesterId) return;
      const sid = this.semesterId;
      const [courses, sessions, recent, stats] = await Promise.all([
        api(`/api/courses?semester_id=${sid}`),
        api(`/api/sessions?semester_id=${sid}`),
        api(`/api/sessions?limit=80`),
        api(`/api/stats?semester_id=${sid}`),
      ]);
      if (sid !== this.semesterId) return;      // the semester was switched meanwhile
      this.courses = courses; this.sessions = sessions; this.recent = recent;
      const sem = this.currentSemester;
      this.semForm = { start_date: sem?.start_date || "", end_date: sem?.end_date || "" };
      if (!this.openCourses.some(c => c.id === this.selectedId)) this.selectedId = this.openCourses[0]?.id ?? null;
      this.stats = stats;
      if (this.tab === "dash") this.$nextTick(() => this.renderCharts());
    },
    // After the first screen is up: fetch the data of the other tabs one after the other, when the
    // browser is idle, so switching tabs shows them at once. Each tab still refreshes when you open it.
    async preload() {
      const idle = () => new Promise(r => (window.requestIdleCallback || (f => setTimeout(f, 50)))(() => r(), { timeout: 1500 }));
      const jobs = [];
      if (this.feat("sport") || this.feat("code") || !this.features?.chosen) jobs.push(() => this.act || this.loadActivities());
      if (this.feat("sleep")) jobs.push(() => this.sleepList.length || this.sleepInit());
      if (this.feat("teach")) jobs.push(() => this.lessons.length || this.teachInit());
      for (const job of jobs) {
        await idle();
        try { await job(); } catch { /* the tab loads again when opened */ }
      }
    },
    async loadStats() {
      if (!this.semesterId) return;
      this.stats = await api(`/api/stats?semester_id=${this.semesterId}`);
      if (this.tab === "dash") this.$nextTick(() => this.renderCharts());
    },
    async changeSemester() { store.set("chrono-semester", this.semesterId); await this.loadSemester(); },
    async refreshTimer() {
      this.timer = await api("/api/timer");
      this.timerFetchedAt = Date.now(); syncClock(this.timer);
    },

    /* ---------------- derived */
    get currentSemester() { return this.semesters.find(s => s.id === this.semesterId); },
    get studyCourses() { return this.courses.filter(c => (c.kind || "course") === "course"); },
    get activityChips() { return this.courses.filter(c => (c.kind === "sport" || c.kind === "code") && !c.finished && (!this.features?.chosen || this.feat(c.kind))); },
    courseGroups() {
      // Course list for the entry form and the Log filter, grouped
      const g = [{ label: "Courses", items: this.studyCourses }];
      for (const [k, label] of [["sport", "Sport"], ["code", "Code"]]) {
        const items = this.courses.filter(c => c.kind === k && !c.finished);
        if (items.length) g.push({ label, items });
      }
      g.push({ label: "Not study time", items: this.courses.filter(c => c.kind === "other") });
      return g;
    },
    isStudy(kind) { return (kind || "course") === "course"; },
    rated(kind) { return this.isStudy(kind) || kind === "sport"; },   // which sessions get a satisfaction rating
    get entryKind() { return this.courses.find(c => c.id === this.entry.course_id)?.kind; },
    get entryIsStudy() { return this.isStudy(this.courses.find(c => c.id === this.entry.course_id)?.kind); },
    kindLabel(kind) { return { sport: "Sport", code: "Code", other: "Other" }[kind] || ""; },
    get openCourses() { return this.studyCourses.filter(c => !c.finished); },
    get entryIsOther() { return this.courses.find(c => c.id === this.entry.course_id)?.kind === "other"; },
    courseLabel(c) {
      if (c.kind === "other") return "Other (not study time)";
      if (c.kind === "sport" || c.kind === "code") return `${this.kindLabel(c.kind)} · ${c.name}`;
      return c.code.toUpperCase() + " – " + c.name;
    },
    get selectedCourse() { return this.courses.find(c => c.id === this.selectedId); },
    get elapsedNow() {
      this.tick;
      if (this.timer.state === "idle") return 0;
      const extra = this.timer.state === "running" ? (Date.now() - this.timerFetchedAt) / 1000 : 0;
      return Math.floor(this.timer.elapsed_sec + extra);
    },
    get pauseNow() {
      this.tick;
      return this.timer.state === "paused" ? Math.floor(this.timer.pause_sec + (Date.now() - this.timerFetchedAt) / 1000) : 0;
    },

    /* ---------------- timer actions */
    remember() { store.set("chrono-course", this.selectedId); },
    async start() {
      if (!this.selectedId) return;
      try { this.timer = await api("/api/timer/start", { method: "POST", body: { course_id: this.selectedId } }); this.timerFetchedAt = Date.now(); syncClock(this.timer); this.remember(); this.loadStats(); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    async pause() {
      try { this.timer = await api("/api/timer/pause", { method: "POST" }); this.timerFetchedAt = Date.now(); syncClock(this.timer); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    async resume(bt) {
      try { this.timer = await api("/api/timer/resume", { method: "POST", body: { break_type: bt } }); this.timerFetchedAt = Date.now(); syncClock(this.timer); this.loadStats(); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    openStop() {
      this.stopNotes = ""; this.stopRating = null; this.smClear();
      if (this.timer.course?.kind === "sport") this.smLoad(this.timer.course.id, isoDate(wallNow()));
      document.getElementById("stopDlg").showModal(); this.$nextTick(() => this.$refs.stopNotes.focus());
    },
    async stop(save) {
      try {
        const r = await api("/api/timer/stop", { method: "POST", body: { save, notes: this.stopNotes, satisfaction: this.rated(this.timer.course?.kind) ? this.stopRating : null } });
        if (save && r.saved_session_id) await this.smSave(r.saved_session_id);
        document.getElementById("stopDlg").close();
        this.toast(save && r.saved_session_id ? `Saved ${this.dur(r.duration_sec)}` : "Session discarded");
        await this.refreshTimer(); await this.loadSemester(); if (this.act) this.loadActivities();
      } catch (e) { this.toast(e.message); }
    },
    hotkey(e) {
      // F5 / Ctrl+R reload the page, which the desktop window doesn't do on its own.
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) { e.preventDefault(); location.reload(); return; }
      if (e.code !== "Space" || e.repeat || this.tab === "teach") return;
      const t = e.target; if (t.closest("input,textarea,select,button,dialog")) return;
      e.preventDefault();
      if (this.timer.state === "idle") this.start(); else if (this.timer.state === "running") this.pause();
    },
    updateTitle() {
      if (this.tab === "teach" && this.teachView === "run" && this.teach && this.timer.state === "idle") {
        const left = this.tLeft(1);
        document.title = (left === null ? "" : this.mmss(left) + " ") + this.tHeader().replace(/<[^>]+>/g, "");
        return;
      }
      this.winBadge();
      if (this.timer.state === "idle") document.title = "Chrono";
      else document.title = `${this.timer.state === "paused" ? "❚❚ " : ""}${this.hms(this.elapsedNow)} ${this.timer.course?.code.toUpperCase() || ""}`;
    },

    /* ---------------- entries */
    openEntry(s = null) {
      this.entryErr = "";
      if (s) {
        const st = parseLocal(s.start), en = parseLocal(s.end);
        const length = Math.round((en - st) / 60000);
        this.entry = { id: s.id, course_id: s.course_id, date: isoDate(st), from: `${pad(st.getHours())}:${pad(st.getMinutes())}`, to: `${pad(en.getHours())}:${pad(en.getMinutes())}`, length, breaks: Math.max(0, length - Math.round(s.duration_sec / 60)), notes: s.notes || "", satisfaction: s.satisfaction ?? null, wholeDay: s.course_kind === "other" && s.duration_sec === 0 };
        this.smClear(); if (s.course_kind === "sport") this.smLoad(s.course_id, isoDate(st), s.id);
      } else {
        const now = wallNow(), from = new Date(now - 3600e3);
        this.entry = { id: null, course_id: this.selectedId || this.courses[0]?.id, date: isoDate(now), from: `${pad(from.getHours())}:${pad(from.getMinutes())}`, to: `${pad(now.getHours())}:${pad(now.getMinutes())}`, length: 60, breaks: 0, notes: "", satisfaction: null, wholeDay: true };
        this.smClear(); this.entryChanged();
      }
      document.getElementById("entryDlg").showModal();
    },
    entrySpan() {
      const st = parseLocal(`${this.entry.date}T${this.entry.from}`); let en = parseLocal(`${this.entry.date}T${this.entry.to}`);
      if (en <= st) en = new Date(en.getTime() + 864e5); // past midnight
      return [st, en];
    },
    // From, To and Duration are linked: changing From or To updates Duration;
    // changing Duration keeps the end time and moves the start time.
    syncLength() { if (!this.entry.from || !this.entry.to) return; const [st, en] = this.entrySpan(); this.entry.length = Math.round((en - st) / 60000); },
    syncFrom() {
      const len = Math.round(Number(this.entry.length));
      if (!this.entry.to || !(len > 0) || len >= 1440) return;
      const [, en] = this.entrySpan();
      const st = new Date(en.getTime() - len * 60000);
      this.entry.date = isoDate(st);
      this.entry.from = `${pad(st.getHours())}:${pad(st.getMinutes())}`;
    },
    entryStudied() { return Math.round(Number(this.entry.length) || 0) - Math.round(Number(this.entry.breaks) || 0); },
    async saveEntry() {
      let body;
      if (this.entryIsOther && this.entry.wholeDay) {
        // A note for the whole day: no times, no study time.
        body = { course_id: this.entry.course_id, start: `${this.entry.date}T00:00:00`, end: `${this.entry.date}T23:59:00`, duration_sec: 0, notes: this.entry.notes, satisfaction: null };
      } else {
        const [st, en] = this.entrySpan();
        if (this.entryStudied() <= 0) { this.entryErr = "Breaks must be shorter than the session."; return; }
        body = { course_id: this.entry.course_id, start: isoLocal(st), end: isoLocal(en), duration_sec: this.entryStudied() * 60, notes: this.entry.notes, satisfaction: this.rated(this.entryKind) ? this.entry.satisfaction : null };
      }
      try {
        let sid = this.entry.id;
        if (sid) await api(`/api/sessions/${sid}`, { method: "PUT", body });
        else sid = (await api("/api/sessions", { method: "POST", body })).id;
        if (this.entryKind === "sport") await this.smSave(sid);
        document.getElementById("entryDlg").close();
        this.toast(this.entry.id ? "Entry updated" : "Entry added");
        await this.loadSemester(); if (this.act) this.loadActivities();
      } catch (e) { this.entryErr = e.message; }
    },
    // In-app confirmation (the browser's confirm() opens an old-style system window in the app)
    ask(message, okLabel = "Delete") {
      this.askMsg = message; this.askOk = okLabel;
      document.getElementById("askDlg").showModal();
      return new Promise(resolve => { this._askResolve = resolve; });
    },
    askDone(answer) { document.getElementById("askDlg").close(); if (this._askResolve) this._askResolve(answer); this._askResolve = null; },
    async deleteSession(s) {
      const what = s.course_kind === "other" ? "this Other entry" : this.dur(s.duration_sec) + " of " + (this.isStudy(s.course_kind) ? s.course_code.toUpperCase() : s.course_name);
      if (!(await this.ask(`Delete ${what} on ${this.dmy(s.start)}?`))) return;
      await api(`/api/sessions/${s.id}`, { method: "DELETE" });
      this.toast("Entry deleted"); await this.loadSemester();
    },
    filteredSessions() {
      return this.sessions.filter(s => (!this.logCourse || s.course_id === this.logCourse)
        && (!this.logFrom || s.start.slice(0, 10) >= this.logFrom)
        && (!this.logTo || s.start.slice(0, 10) <= this.logTo));
    },
    setRange(which) {
      const mon = wallNow(); mon.setHours(12, 0, 0, 0);
      mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - (which === "last" ? 7 : 0));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      this.logFrom = isoDate(mon); this.logTo = isoDate(sun);
    },
    exportTxt() {
      // Exports exactly what the Log shows: the selected course (or all) between the two dates, both included.
      const oldest = this.sessions.length ? this.sessions[this.sessions.length - 1].start.slice(0, 10) : null;
      const from = this.logFrom || this.currentSemester?.start_date || oldest || isoDate(wallNow());
      const to = this.logTo || isoDate(wallNow());
      if (to < from) { this.toast("The end date is before the start date"); return; }
      const q = new URLSearchParams({ start: from, end: to, course_id: this.logCourse || 0, semester_id: this.semesterId });
      window.location.href = `/api/export?${q}`;
    },
    groupedSessions() {
      const groups = [];
      for (const s of this.filteredSessions()) {
        const d = s.start.slice(0, 10);
        let g = groups[groups.length - 1];
        if (!g || g.date !== d) { g = { date: d, items: [], total: 0 }; groups.push(g); }
        g.items.push(s); if (this.isStudy(s.course_kind)) g.total += s.duration_sec / 3600;
      }
      return groups;
    },

    /* ---------------- courses & semesters */
    openCourse(c = null) {
      this.courseErr = "";
      this.courseForm = c ? { ...c, category: c.category || "", deadline: c.deadline || "", grade: c.grade || "", spans: !!c.spans, start_date: c.start_date || "" }
                          : { id: null, semester_id: this.semesterId, code: "", name: "", ects: 3, lessons_week: 3, goal_week: 2, deadline: this.currentSemester?.end_date || "", category: this.mode === "ects" ? "master" : "", finished: false, grade: "", spans: false, start_date: "" };
      document.getElementById("courseDlg").showModal();
    },
    async saveCourse() {
      const f = this.courseForm;
      const body = { semester_id: f.semester_id || this.semesterId, spans: !!f.spans, start_date: f.spans ? (f.start_date || null) : null, code: f.code, name: f.name, ects: Number(f.ects) || 0, lessons_week: f.lessons_week === "" || f.lessons_week == null ? null : Number(f.lessons_week), goal_week: f.goal_week === "" || f.goal_week == null ? null : Number(f.goal_week), deadline: f.deadline || null, category: f.category || null, finished: !!f.finished, grade: f.finished ? (f.grade || null) : null };
      try {
        if (f.id) await api(`/api/courses/${f.id}`, { method: "PUT", body });
        else await api("/api/courses", { method: "POST", body });
        document.getElementById("courseDlg").close();
        this.toast(f.id ? "Course updated" : "Course added");
        this.semesters = await api("/api/semesters"); await this.loadSemester();
      } catch (e) { this.courseErr = e.message; }
    },
    async deleteCourse() {
      if (!(await this.ask(`Delete ${this.courseForm.name}?`))) return;
      try { await api(`/api/courses/${this.courseForm.id}`, { method: "DELETE" }); document.getElementById("courseDlg").close(); this.toast("Course deleted"); await this.loadSemester(); }
      catch (e) { this.courseErr = e.message; }
    },
    async saveSemester() {
      const s = this.currentSemester;
      await api(`/api/semesters/${s.id}`, { method: "PUT", body: { code: s.code, start_date: this.semForm.start_date || null, end_date: this.semForm.end_date || null } });
      this.semesters = await api("/api/semesters"); this.toast("Dates saved"); await this.loadStats();
    },
    openSemester() { this.semErr = ""; this.newSem = { code: "", start_date: "", end_date: "" }; document.getElementById("semDlg").showModal(); },
    async createSemester() {
      try {
        const r = await api("/api/semesters", { method: "POST", body: { code: this.newSem.code, start_date: this.newSem.start_date || null, end_date: this.newSem.end_date || null } });
        document.getElementById("semDlg").close();
        this.semesters = await api("/api/semesters"); this.semesterId = r.id; await this.changeSemester(); this.toast("Semester created");
      } catch (e) { this.semErr = e.message; }
    },

    /* ---------------- dashboard helpers */
    spanTitle(c) {
      const span = `${c.start_date ? this.dmy(c.start_date) : "?"} to ${c.deadline ? this.dmy(c.deadline) : "?"}`;
      const home = this.semesters.find(s => s.id === c.semester_id)?.code || "its own semester";
      const here = c.hours_here != null ? `; ${this.hoursFmt(c.hours_here)} in this semester` : "";
      return this.weekly ? `Runs ${span}. Counts in ${home}${here}.` : `Runs ${span}. ECTS count in ${home}${here}.`;
    },
    sortedCourses() {
      const cs = [...(this.stats?.courses || [])];
      return cs.sort((a, b) => (a.finished - b.finished) || ((a.home === false) - (b.home === false)) || (a.sort - b.sort));
    },
    neededOf(c) {
      if (this.weekly) {
        // Weekly goal: met this week, or how much is still missing.
        if (c.finished) return { cls: "good", text: "✓ " + (c.grade || "done") };
        if (!c.goal_week) return { cls: "", text: "–" };
        if (c.goal_met) return { cls: "good", text: "✓ " + this.fx(c.goal_week, 1) + " h" };
        return { cls: "bad", text: "▲ " + this.fx(c.goal_week - c.this_week, 1) + " h to go" };
      }
      // Green when the semester average already covers the weekly pace still needed.
      if (c.finished) return { cls: "good", text: "✓ " + (c.grade || "done") };
      if (c.hours >= c.target_hours) return { cls: "good", text: "✓ done" };
      if (c.needed_week == null) return { cls: "bad", text: "▲ past deadline" };
      // a shape as well as a colour, so it reads without colour vision
      const ok = c.avg_week >= c.needed_week;
      return { cls: ok ? "good" : "bad", text: (ok ? "✓ " : "▲ ") + this.fx(c.needed_week, 1) + " h" };
    },
    ectsSegments() {
      if (!this.stats) return [];
      const tgt = this.stats.summary.ects_target || 1;
      return this.stats.courses.map(c => {
        const e = c.finished ? c.ects : Math.min(c.ects_done, c.ects);
        return { key: c.id, style: `width:${e / tgt * 100}%;${this.bg(c.category)}box-shadow:inset -1px 0 0 var(--panel)`, title: `${c.code.toUpperCase()}: ${this.fx(e, 2)} ECTS` };
      });
    },
    usedCategories() {
      const used = new Set(this.studyCourses.map(c => c.category || "none"));
      const cats = this.meta.categories.filter(c => used.has(c.key));
      // courses without a category (usual at school) still show up in the charts
      return used.has("none") ? [...cats, { key: "none", label: "No category" }] : cats;
    },
    breakTypes() { return Object.keys(this.stats?.break_totals || {}).length ? Object.keys(this.stats.break_totals) : this.meta.break_types; },
    breakRatio() {
      const b = Object.values(this.stats?.break_totals || {}).reduce((a, v) => a + v, 0), h = this.stats?.summary.hours || 0;
      return h ? `${Math.round(b / h * 60)} min` : "–";
    },

    /* today strip */
    todaySessions() {
      const today = isoDate(wallNow());
      // everything with a time span; whole-day Other notes have none
      return this.recent.filter(s => !(s.course_kind === "other" && s.duration_sec === 0) && (s.start.slice(0, 10) === today || s.end.slice(0, 10) === today));
    },
    todayHours() {
      this.tick;
      let sec = this.todaySessions().filter(s => this.isStudy(s.course_kind)).reduce((a, s) => a + s.duration_sec, 0);
      if (this.timer.state !== "idle" && this.isStudy(this.timer.course?.kind) && this.timer.session_start?.slice(0, 10) === isoDate(wallNow())) sec += this.elapsedNow;
      return sec / 3600;
    },
    dayStripRange() {
      const DAY_START = 0, DAY_END = 24, STEP = 2;   // bar from 00:00 to 24:00, a label every 2 h
      let lo = DAY_START, hi = DAY_END;
      const hours = clockHours;
      const times = this.todaySessions().flatMap(s => [parseLocal(s.start), parseLocal(s.end)]);
      if (this.timer.session_start) times.push(parseLocal(this.timer.session_start), wallNow());
      for (const t of times) {
        const h = hours(t);
        if (h < lo) lo = Math.max(0, Math.floor(h));
        if (h > hi) hi = Math.min(24, Math.ceil(h));
      }
      lo -= lo % STEP;
      hi = Math.min(24, lo + Math.ceil((hi - lo) / STEP) * STEP);
      const ticks = []; for (let h = lo; h <= hi; h += STEP) ticks.push(`${pad(h % 24)}:00`);
      return { lo, hi, ticks, label: "" };
    },
    hourTicks() {
      this.tick;
      const { lo, hi } = this.dayStripRange();
      const out = [];
      for (let h = lo + 1; h < hi; h++) out.push({ h, left: (h - lo) / (hi - lo) * 100 });
      return out;
    },
    pct(d) { const { lo, hi } = this.dayStripRange(); const h = clockHours(d); return Math.max(0, Math.min(100, (h - lo) / (hi - lo) * 100)); },
    nowPct() { this.tick; return this.pct(wallNow()); },
    daySegments() {
      this.tick;
      const segs = this.todaySessions().map(s => {
        const a = this.pct(parseLocal(s.start)), b = this.pct(parseLocal(s.end));
        const study = this.isStudy(s.course_kind);
        const name = study ? s.course_code.toUpperCase() : this.kindLabel(s.course_kind) + (s.course_kind === "other" ? "" : " · " + s.course_name);
        return { key: "s" + s.id, live: false, act: !study, style: `left:${a}%;width:${Math.max(b - a, 0.4)}%;` + (study ? this.bg(s.category) : this.dots(s.course_kind)), title: `${name} ${this.hm(s.start)}–${this.hm(s.end)}, ${this.dur(s.duration_sec)}` };
      });
      if (this.timer.state !== "idle" && this.timer.session_start) {
        const a = this.pct(parseLocal(this.timer.session_start));
        const endT = this.timer.state === "running" ? wallNow() : parseLocal(this.timer.pause_start);
        const b = this.pct(endT);
        const study = this.isStudy(this.timer.course?.kind);
        segs.push({ key: "live", live: this.timer.state === "running", act: !study, style: `left:${a}%;width:${Math.max(b - a, 0.4)}%;` + (study ? this.bg(this.timer.course?.category) : this.dots(this.timer.course?.kind)), title: "Current session" });
      }
      return segs;
    },

    /* ---------------- charts */
    renderCharts() {
      if (!this.stats || this.tab !== "dash" || !window.echarts) return;
      const ink2 = cssVar("--ink-2"), ink3 = cssVar("--ink-3"), rule = cssVar("--rule"), panel = cssVar("--panel"), ink = cssVar("--ink");
      const dark = cssVar("color-scheme") === "dark";
      const font = { fontFamily: "Atkinson Hyperlegible Next, Hanken Grotesk, system-ui, sans-serif" };
      const tooltipBase = { backgroundColor: panel, borderColor: rule, textStyle: { color: ink, ...font, fontSize: 13 }, extraCssText: "border-radius:10px;box-shadow:0 8px 24px -12px rgba(0,0,0,.35);" };
      const get = id => { const el = document.getElementById(id); if (!el) return null; let c = echarts.getInstanceByDom(el); if (!c) c = echarts.init(el, null, { renderer: "svg" }); this.charts[id] = c; return c; };
      const weeks = this.stats.weeks;
      const labels = weeks.map(w => `W${w.index}`);
      const axisCommon = { axisLine: { lineStyle: { color: rule } }, axisTick: { show: false }, axisLabel: { color: ink3, ...font } };

      // Weekly hours by category.
      const cats = this.usedCategories();
      const wc = get("weeklyChart");
      if (wc) wc.setOption({
        animation: false, textStyle: font,
        grid: { left: 36, right: 12, top: 24, bottom: 28 },
        tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: dark ? "rgba(255,255,255,.04)" : "rgba(19,34,58,.05)" } },
          formatter: ps => { const w = weeks[ps[0].dataIndex]; const rows = ps.filter(p => p.value > 0).reverse().map(p => `<div style="display:flex;gap:14px;justify-content:space-between"><span>${p.marker}${p.seriesName}</span><b>${p.value.toFixed(1)} h</b></div>`).join(""); return `<div style="margin-bottom:4px;color:${ink2}">Week ${w.index}, from ${this.dmy(w.start)}</div>${rows}<div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px solid ${rule};padding-top:4px"><span>Total</span><b>${w.total.toFixed(1)} h</b></div>`; } },
        xAxis: { type: "category", data: labels, ...axisCommon },
        yAxis: { type: "value", splitLine: { lineStyle: { color: rule, type: [3, 4] } }, axisLabel: { color: ink3, ...font, formatter: "{value} h" } },
        series: cats.map((cat, i) => ({
          name: cat.label, type: "bar", stack: "h", barMaxWidth: 34,
          data: weeks.map(w => +(w.by_category[cat.key] || 0).toFixed(2)),
          itemStyle: { color: cssVar(`--c-${cat.key}`), borderColor: panel, borderWidth: 1, borderRadius: i === cats.length - 1 ? [4, 4, 0, 0] : 0 },
        })),
      }, true);

      // Calendar heatmap of daily hours.
      const cal = get("calChart");
      if (cal) {
        const r = this.stats.range;
        const data = Object.entries(this.stats.daily).filter(([d]) => d >= r.start && d <= r.end).map(([d, h]) => [d, +h.toFixed(2)]);
        const max = Math.max(4, ...data.map(d => d[1]));
        const days = (new Date(r.end) - new Date(r.start)) / 864e5;
        const weeksN = Math.ceil(days / 7) + 1;
        const el = document.getElementById("calChart");
        // Square cells as large as fit the chart box, so it matches the height of "Hours per week".
        const cell = Math.max(10, Math.min(32, Math.floor((el.clientWidth - 50) / weeksN), Math.floor((el.clientHeight - 40) / 7)));
        cal.setOption({
          animation: false, textStyle: font,
          tooltip: { ...tooltipBase, formatter: p => `${this.longDate(p.value[0])}<br><b>${this.hoursFmt(p.value[1])}</b>` },
          visualMap: { show: false, min: 0, max, inRange: { color: dark ? ["#08306b", "#2171b5", "#9ecae1"] : ["#deebf7", "#4292c6", "#08306b"] } },
          calendar: {
            top: "middle", left: 34, right: 8, orient: "horizontal", range: [r.start, r.end], cellSize: [cell, cell],
            splitLine: { show: false }, itemStyle: { color: cssVar("--track"), borderColor: panel, borderWidth: cell < 16 ? 1.5 : 3, borderRadius: cell < 16 ? 2 : 3 },
            yearLabel: { show: false }, dayLabel: { firstDay: 1, nameMap: this.dayLetters(), color: ink3, fontSize: 11, ...font },
            monthLabel: { color: ink2, ...font, fontSize: 12, nameMap: this.monthShort() },
          },
          series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderRadius: cell < 16 ? 2 : 3, borderColor: panel, borderWidth: cell < 16 ? 1.5 : 3 } }],
        }, true);
      }

      // Satisfaction: by hour of day, by day (calendar), by week. Fixed 0-10 scale everywhere.
      const sat = this.stats.satisfaction;
      if (sat && sat.rated_sessions) {
        const satColor = cssVar("--sat");
        const ramp = [cssVar("--sat-lo"), cssVar("--sat"), cssVar("--sat-hi")];
        const avgLine = sat.average == null ? undefined : { symbol: "none", silent: true, lineStyle: { color: ink2, type: "dashed", width: 1.2 },
          label: { formatter: `average ${sat.average.toFixed(1)}`, color: ink2, position: "insideEndTop", ...font }, data: [{ yAxis: sat.average }] };
        const yAxis10 = { type: "value", min: 0, max: 10, interval: 2, splitLine: { lineStyle: { color: rule, type: [3, 4] } }, axisLabel: { color: ink3, ...font } };

        const MIN_HOURS = 0.25; // hours with less rated time than this are too thin to show
        // The axis runs 05:00 -> 04:00, so late-night sessions sit after 23:00 instead of opening a gap.
        const order = [...sat.by_hour.slice(5), ...sat.by_hour.slice(0, 5)];
        const used = order.map((b, i) => (b.hours >= MIN_HOURS ? i : -1)).filter(i => i >= 0);
        const hours = order.slice(Math.min(...used), Math.max(...used) + 1);
        const hc = get("satHourChart");
        if (hc && used.length) hc.setOption({
          animation: false, textStyle: font,
          grid: { left: 30, right: 10, top: 18, bottom: 26 },
          tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: dark ? "rgba(255,255,255,.04)" : "rgba(19,34,58,.05)" } },
            formatter: ps => { const b = hours[ps[0].dataIndex]; return b.hours < MIN_HOURS ? `${pad(b.hour)}:00–${pad((b.hour + 1) % 24)}:00<br><span style="color:${ink2}">not enough rated time</span>` : `${pad(b.hour)}:00–${pad((b.hour + 1) % 24)}:00<br><b>${b.average.toFixed(1)}</b> / 10<br><span style="color:${ink2}">from ${this.hoursFmt(b.hours)} of rated study</span>`; } },
          xAxis: { type: "category", data: hours.map(b => pad(b.hour)), ...axisCommon },
          yAxis: yAxis10,
          series: [{ type: "bar", barMaxWidth: 22, data: hours.map(b => b.hours >= MIN_HOURS ? b.average : null),
            itemStyle: { color: satColor, borderRadius: [4, 4, 0, 0] }, markLine: avgLine }],
        }, true);

        const sc = get("satCalChart");
        if (sc) {
          const r = this.stats.range;
          const data = Object.entries(sat.daily).filter(([d, v]) => v != null && d >= r.start && d <= r.end).map(([d, v]) => [d, v]);
          const el = document.getElementById("satCalChart");
          const weeksN = Math.ceil((new Date(r.end) - new Date(r.start)) / 864e5 / 7) + 1;
          const cell = Math.max(10, Math.min(22, Math.floor((el.clientWidth - 50) / weeksN)));
          sc.setOption({
            animation: false, textStyle: font,
            tooltip: { ...tooltipBase, formatter: p => `${this.longDate(p.value[0])}<br><b>${p.value[1].toFixed(1)}</b> / 10` },
            visualMap: { show: false, min: 0, max: 10, inRange: { color: ramp } },
            calendar: {
              top: 22, left: 34, right: 8, range: [r.start, r.end], cellSize: [cell, cell],
              splitLine: { show: false }, itemStyle: { color: cssVar("--track"), borderColor: panel, borderWidth: cell < 16 ? 1.5 : 3, borderRadius: cell < 16 ? 2 : 3 },
              yearLabel: { show: false }, dayLabel: { firstDay: 1, nameMap: this.dayLetters(), color: ink3, fontSize: 11, ...font },
              monthLabel: { color: ink2, ...font, fontSize: 12, nameMap: this.monthShort() },
            },
            series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderRadius: cell < 16 ? 2 : 3, borderColor: panel, borderWidth: cell < 16 ? 1.5 : 3 } }],
          }, true);
          el.style.height = `${22 + cell * 7 + 34}px`; sc.resize();
          sc.setOption({ graphic: [{ type: "group", right: 8, bottom: 2, children: [
            { type: "text", left: 0, top: 0, style: { text: "0", fill: ink3, font: "11px Atkinson Hyperlegible Next, Hanken Grotesk" } },
            { type: "rect", left: 12, top: 2, shape: { width: 90, height: 8, r: 2 }, style: { fill: new echarts.graphic.LinearGradient(0, 0, 1, 0, ramp.map((c, i) => ({ offset: i / 2, color: c }))) } },
            { type: "text", left: 108, top: 0, style: { text: "10", fill: ink3, font: "11px Atkinson Hyperlegible Next, Hanken Grotesk" } },
          ] }] });
        }

        const wk = get("satWeekChart");
        if (wk) wk.setOption({
          animation: false, textStyle: font,
          grid: { left: 30, right: 12, top: 18, bottom: 26 },
          tooltip: { ...tooltipBase, trigger: "axis", formatter: ps => { const i = ps[0].dataIndex, v = sat.weekly[i];
            return `Week ${weeks[i].index}, from ${this.dmy(weeks[i].start)}<br>` + (v == null ? `<span style="color:${ink2}">no rated sessions</span>` : `<b>${v.toFixed(1)}</b> / 10<br><span style="color:${ink2}">from ${this.hoursFmt(sat.weekly_hours[i])} of rated study</span>`); } },
          xAxis: { type: "category", data: labels, ...axisCommon },
          yAxis: yAxis10,
          series: [{ type: "line", data: sat.weekly, connectNulls: false, symbol: "circle", symbolSize: 8,
            lineStyle: { color: satColor, width: 2 }, itemStyle: { color: satColor, borderColor: panel, borderWidth: 2 },
            markLine: avgLine && { ...avgLine, label: { ...avgLine.label, position: "insideStartTop" } } }],
        }, true);
      }

      // Breaks per week.
      const types = this.breakTypes();
      const bcolors = [cssVar("--ink-3"), cssVar("--warn"), cssVar("--c-master"), cssVar("--c-job"), cssVar("--c-energy_compatible")];
      const bc = get("breakChart");
      if (bc) bc.setOption({
        animation: false, textStyle: font,
        legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: ink2, ...font } },
        grid: { left: 36, right: 12, top: 34, bottom: 26 },
        tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: v => `${(+v).toFixed(2)} h` },
        xAxis: { type: "category", data: labels, ...axisCommon },
        yAxis: { type: "value", splitLine: { lineStyle: { color: rule, type: [3, 4] } }, axisLabel: { color: ink3, ...font, formatter: "{value} h" } },
        series: types.map((t, i) => ({ name: t, type: "bar", stack: "b", barMaxWidth: 26, data: weeks.map(w => +(w.breaks?.[t] || 0).toFixed(2)), itemStyle: { color: bcolors[i % bcolors.length], borderColor: panel, borderWidth: 1 } })),
      }, true);
    },


    /* ---------------- sport measures: weights in kg (Muscle pump) or a 1-10 level (Rowing), asked in the dialogs */
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weekdayOf(iso) { return (parseLocal(iso + "T12:00:00").getDay() + 6) % 7; },   // 0 = Monday
    smClear() { this.sm = { fields: [] }; },
    // Prefilled from the last entry on the same weekday; when editing, the entry's own values.
    async smLoad(courseId, dateIso, sessionId = null) {
      const key = `${courseId}|${dateIso}|${sessionId}`; this._smKey = key;
      try {
        const r = await api(`/api/sport/entry?course_id=${courseId}&day=${dateIso}` + (sessionId ? `&session_id=${sessionId}` : ""));
        if (this._smKey !== key) return;     // the dialog changed meanwhile
        this.sm = { ...r, course_id: courseId, day: dateIso, session: sessionId };
      } catch (e) { this.toast(e.message); }
    },
    smFrom() {
      if (this.sm.session || !this.sm.from) return this.sm.session ? "" : "Nothing logged yet. Next time this is filled in for you.";
      return `Filled in from ${this.sm.same_weekday ? "the same weekday" : "your last entry"}, ${this.sleepDayLabel(this.sm.from)}. Change what changed.`;
    },
    async smSave(sid) {
      if (!this.sm.fields?.length) return;
      const values = {};
      for (const f of this.sm.fields) values[f.id] = (f.value === "" || f.value == null || isNaN(f.value)) ? null : Number(f.value);
      try { await api(`/api/sport/values/${sid}`, { method: "PUT", body: { values } }); }
      catch (e) { this.toast("Weights not saved: " + e.message); }
    },
    entryChanged() {
      // Course or date changed in the entry dialog: load that sport's measures for that weekday.
      if (this.entryKind !== "sport") { this.smClear(); return; }
      if (this.entry.id && this.sm.session === this.entry.id && this.sm.course_id === this.entry.course_id) return;
      this.smLoad(this.entry.course_id, this.entry.date, this.entry.id || null);
    },
    async saveFields(t, kgText, level) {
      const kg = kgText.split(",").map(x => x.trim()).filter(Boolean);
      try { await api(`/api/sport/fields/${t.id}`, { method: "PUT", body: { kg, level } }); await this.loadActivities(); }
      catch (e) { this.actErr = e.message; }
    },
    fieldNames(t, unit) { return (t.fields || []).filter(f => f.unit === unit).map(f => f.name).join(", "); },
    kg(v) { return v == null ? "–" : (Math.round(v * 10) / 10).toLocaleString(this.loc()) ; },
    signed(v, d = 1) { if (v == null) return "–"; const r = Math.round(v * 10 ** d) / 10 ** d; return (r > 0 ? "+" : r < 0 ? "−" : "±") + Math.abs(r).toLocaleString(this.loc()); },

    /* ---------------- sport & code (never study time) */
    async loadActivities() {
      this.act = await api("/api/activities");
      if (this.tab === "sport" || this.tab === "code") this.$nextTick(() => this.renderActCharts());
    },
    actColor(slot) {
      const dark = cssVar("color-scheme") === "dark";
      const light = ["#0072b2", "#e69f00", "#009e73", "#d55e00", "#cc79a7", "#56b4e9", "#8a7d00", "#5b6b82"];   // Okabe & Ito
      const dk = ["#4aa3df", "#f0b030", "#2fc79a", "#ee7a33", "#e09ac4", "#7fc8f0", "#e6d84a", "#a7b1c0"];
      return (dark ? dk : light)[slot % 8];
    },
    async addActType(kind) {
      const name = this.actNew[kind].trim(); if (!name) return;
      try {
        await api("/api/activity-types", { method: "POST", body: { kind, name, repo_path: kind === "code" ? `~/git/${name}` : null } });
        this.actNew[kind] = ""; this.actErr = "";
        await this.loadSemester(); await this.loadActivities(); this.toast(`${name} added`);
      } catch (e) { this.actErr = e.message; }
    },
    async saveActType(t, patch) {
      try {
        await api(`/api/activity-types/${t.id}`, { method: "PUT", body: { kind: t.kind, name: t.name, repo_path: t.repo_path, archived: t.archived, ...patch } });
        await this.loadSemester(); await this.loadActivities();
      } catch (e) { this.actErr = e.message; }
    },
    async deleteActType(t) {
      if (!(await this.ask(`Delete ${t.name}?`))) return;
      try { await api(`/api/activity-types/${t.id}`, { method: "DELETE" }); await this.loadSemester(); await this.loadActivities(); }
      catch (e) { this.actErr = e.message; }
    },
    actMonthLabel(iso) { return parseLocal(iso).toLocaleDateString(this.loc(), { month: "short" }) + (iso.slice(5, 7) === "01" ? " " + iso.slice(2, 4) : ""); },
    renderActCharts() {
      if (!this.act || !["sport", "code"].includes(this.tab) || !window.echarts) return;
      const ink = cssVar("--ink"), ink2 = cssVar("--ink-2"), ink3 = cssVar("--ink-3"), rule = cssVar("--rule"), panel = cssVar("--panel");
      const font = { fontFamily: "Atkinson Hyperlegible Next, Hanken Grotesk, system-ui, sans-serif" };
      const tip = { backgroundColor: panel, borderColor: rule, textStyle: { color: ink, ...font, fontSize: 13 }, extraCssText: "border-radius:10px;box-shadow:0 8px 24px -12px rgba(0,0,0,.35);" };
      const axis = { axisLine: { lineStyle: { color: rule } }, axisTick: { show: false }, axisLabel: { color: ink3, ...font } };
      const yAxis = unit => ({ type: "value", minInterval: unit === "h" ? 0.5 : 1, splitLine: { lineStyle: { color: rule, type: [3, 4] } }, axisLabel: { color: ink3, ...font, formatter: v => unit === "h" ? `${v} h` : v } });
      const chart = (id, labels, series, unit, title) => {
        const el = document.getElementById(id); if (!el) return;
        const c = echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: "svg" });
        this.charts[id] = c;
        c.setOption({
          animation: false, textStyle: font, grid: { left: 40, right: 10, top: 14, bottom: 26 },
          tooltip: { ...tip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,.08)" } },
            formatter: ps => { const rows = ps.filter(p => p.value > 0).reverse().map(p => `<div style="display:flex;gap:14px;justify-content:space-between"><span>${p.marker}${p.seriesName}</span><b>${unit === "h" ? (+p.value).toFixed(1) + " h" : p.value}</b></div>`).join("");
              const tot = ps.reduce((a, p) => a + (+p.value || 0), 0);
              return `<div style="color:${ink2};margin-bottom:4px">${title(ps[0].dataIndex)}</div>${rows || `<span style="color:${ink2}">nothing</span>`}` + (ps.length > 1 && tot ? `<div style="display:flex;justify-content:space-between;border-top:1px solid ${rule};margin-top:4px;padding-top:4px"><span>Total</span><b>${unit === "h" ? tot.toFixed(1) + " h" : tot}</b></div>` : ""); } },
          xAxis: { type: "category", data: labels, ...axis }, yAxis: yAxis(unit),
          series: series.map((s, i) => ({ name: s.name, type: "bar", stack: "a", barMaxWidth: 26, data: s.data, itemStyle: { color: s.color, borderColor: panel, borderWidth: 1, borderRadius: i === series.length - 1 ? [4, 4, 0, 0] : 0 } })),
        }, true);
      };
      for (const kind of ["sport", "code"]) {
        const g = this.act[kind]; if (!g) continue;
        const shown = g.types.map((t, n) => ({ t, n })).filter(({ t, n }) => !t.archived || g.weekly[n].some(v => v) || g.monthly[n].some(v => v));
        const wLabels = g.weeks.map(w => this.dmy(w).slice(0, 5));
        const mLabels = g.months.map(m => this.actMonthLabel(m));
        chart(`${kind}Week`, wLabels, shown.map(({ t, n }) => ({ name: t.name, color: this.actColor(t.slot), data: g.weekly[n].map(v => +v.toFixed(2)) })), "h", i => `Week from ${this.dmy(g.weeks[i])}`);
        chart(`${kind}Month`, mLabels, shown.map(({ t, n }) => ({ name: t.name, color: this.actColor(t.slot), data: g.monthly[n].map(v => +v.toFixed(2)) })), "h", i => parseLocal(g.months[i]).toLocaleDateString(this.loc(), { month: "long", year: "numeric" }));
        if (kind === "code") {
          const withGit = g.types.filter(t => t.git && !t.git.error);
          chart("codeCommits", wLabels, withGit.map(t => ({ name: t.name, color: this.actColor(t.slot), data: t.git.commits_week })), "n", i => `Commits, week from ${this.dmy(g.weeks[i])}`);
        }
      }
    },

    /* ---------------- desktop window (Linux app without a title bar): buttons, move, resize */
    async winInit() {
      const ready = async () => { try { this.frameless = !!(await window.pywebview.api.frameless()); } catch { this.frameless = false; } };
      if (window.pywebview?.api) await ready(); else window.addEventListener("pywebviewready", ready, { once: true });
    },
    winApi(name, ...args) { try { window.pywebview?.api?.[name](...args); } catch { /* not in the app */ } },
    /** Pressing on an empty part of the header moves the window (not on buttons, the tabs or the semester menu). */
    winDrag(ev) {
      if (!this.frameless || ev.button !== 0 || ev.target.closest("button, a, select, input, nav, label")) return;
      ev.preventDefault(); this.winApi("start_move");
    },
    winDblclick(ev) { if (this.frameless && !ev.target.closest("button, a, select, input, nav, label")) this.winApi("toggle_maximize"); },
    winResize(edge) { this.winApi("start_resize", edge); },
    /** Desktop app: the taskbar icon shows the minutes of the running timer, and a bar that fills over each hour. */
    winBadge() {
      if (!this.frameless) return;
      const on = this.timer.state !== "idle";
      const sec = on ? this.elapsedNow : 0;
      const key = on ? `${Math.floor(sec / 60)}|${this.timer.state}` : "off";
      if (key === this._badge) return;
      this._badge = key;
      this.winApi("set_badge", on ? Math.floor(sec / 60) : null, on ? (sec % 3600) / 3600 : null);
    },

    /* ---------------- tips: one option opens directly, several open a short choice */
    openSupport() {
      const opts = this.meta.support || [];
      if (opts.length === 1) window.open(opts[0].url, "_blank", "noopener");
      else document.getElementById("supportDlg").showModal();
    },

    /* ---------------- features (first launch) */
    async loadFeatures() {
      try { this.features = await api("/api/features"); } catch { return; }
      if (!this.features.chosen) {
        this.featPick = { ...this.features.suggested };
        this.featCount = { ...this.features.counting };
        this.$nextTick(() => document.getElementById("featDlg")?.showModal());
      }
      this.fixTab();
    },
    feat(k) { return !!this.features?.chosen?.[k]; },
    openFeatures() { this.featPick = { ...(this.features?.chosen || this.features?.suggested || {}) }; this.featCount = { ...(this.features?.counting || this.featCount) }; document.getElementById("featDlg").showModal(); },
    async saveFeatures() {
      const c = this.featCount;
      this.features = await api("/api/features", { method: "PUT", body: { chosen: this.featPick, counting: { mode: c.mode, ects_hours: Number(c.ects_hours) || 30, lesson_min: Number(c.lesson_min) || 0 } } });
      document.getElementById("featDlg").close();
      this.fixTab();
      await this.loadSemester();
    },
    // How courses are counted: "ects" (credits by a deadline), "lessons" (lessons per week), "hours" (weekly goal)
    get mode() { return this.features?.counting?.mode || this.stats?.counting?.mode || "ects"; },
    get weekly() { return this.mode !== "ects"; },
    courseUnit(c) {
      if (this.mode === "lessons") return c.lessons_week ? this.fx(c.lessons_week, 0) + " lessons/wk" : "–";
      if (this.mode === "hours") return c.goal_week ? this.fx(c.goal_week, 1) + " h/wk goal" : "no goal";
      return this.fx(c.ects, 0) + " ECTS";
    },
    countingHint() {
      if (this.mode === "lessons") return `Goal per week: lessons × ${this.features?.counting?.lesson_min ?? 30} min of study. ✓ when this week reaches it, ▲ what is still missing`;
      if (this.mode === "hours") return "Goal per week in hours: ✓ when this week reaches it, ▲ what is still missing";
      return `Needed is the weekly pace to reach the ECTS by the deadline (${this.features?.counting?.ects_hours ?? 30} h per ECTS): ✓ when your semester average covers it, ▲ when it doesn’t`;
    },
    fixTab() {
      const need = { sport: "sport", code: "code", teach: "teach", sleep: "sleep" }[this.tab];
      if (need && this.features?.chosen && !this.feat(need)) this.tab = "dash";
    },

    /* ---------------- sleep */
    async sleepInit() {
      try {
        const [list, st] = await Promise.all([
          api("/api/sleep"),
          api(`/api/sleep/stats?days=${this.sleepDays}`),
        ]);
        this.sleepList = list; this.sleepSt = st;
        if (!this.sleepForm) this.sleepGo(this.sleepLastNight());
        if (!this.sleepSched) this.sleepSched = JSON.parse(JSON.stringify(st.schedule));
      } catch (e) { this.toast(e.message); }
    },
    async sleepSetDays(d) { this.sleepDays = d; store.set("chrono-sleep-days", d); await this.sleepInit(); },
    sleepIsFreeMorning(nightIso) {
      const d = new Date(nightIso + "T12:00"); d.setDate(d.getDate() + 1);
      const wd = (d.getDay() + 6) % 7;   // 0 = Monday
      return (this.sleepSt?.schedule.free_days || [5, 6]).includes(wd);
    },
    /** Last night: before 15:00 that is yesterday's evening. */
    sleepLastNight() { const now = wallNow(); const d = new Date(now); if (now.getHours() < 15) d.setDate(d.getDate() - 1); return isoDate(d); },
    sleepShift(iso, days) { const d = new Date(iso + "T12:00"); d.setDate(d.getDate() + days); return isoDate(d); },
    /** Open one night: the logged entry if there is one, else a new one from the schedule. */
    sleepGo(iso) {
      const e = this.sleepList.find(x => x.kind === "night" && x.night === iso);
      if (e) this.sleepEdit(e, false); else this.sleepNew("night", iso);
    },
    sleepStep(days) {
      const iso = this.sleepShift(this.sleepForm?.night || this.sleepLastNight(), days);
      if (iso > this.sleepLastNight()) return;
      this.sleepGo(iso);
    },
    sleepNew(kind = "night", iso = null) {
      const now = wallNow();
      iso = iso || (kind === "nap" ? isoDate(now) : this.sleepLastNight());
      const sch = this.sleepSt?.schedule || { work: { bed: "23:00", wake: "07:00" }, free: { bed: "23:30", wake: "08:00" } };
      const free = this.sleepIsFreeMorning(iso), part = free ? sch.free : sch.work;
      this.sleepForm = kind === "nap"
        ? { id: null, kind, night: iso, bedT: "14:00", wakeT: "14:20", latency: null, awake: null, quality: null, free: null, alarm: false, notes: "" }
        : { id: null, kind, night: iso, bedT: part.bed, wakeT: part.wake, latency: null, awake: null, quality: null, free, alarm: !free, notes: "" };
      this.sleepErr = "";
    },
    sleepEdit(e, scroll = true) {
      const t = s => s.slice(11, 16);
      this.sleepForm = { id: e.id, kind: e.kind, night: e.night, bedT: t(e.bed), wakeT: t(e.wake), latency: e.latency_min, awake: e.awake_min,
                         quality: e.quality, free: !!e.free, alarm: !!e.alarm, notes: e.notes || "" };
      this.sleepErr = ""; if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    },
    /** bed and wake as full timestamps. A night runs from 18:00 of its date: a bedtime before
     *  16:00 is the next morning; the wake-up is always the next day. */
    sleepTimes(f) {
      if (f.kind === "nap") return { bed: `${f.night}T${f.bedT}`, wake: `${f.night}T${f.wakeT}` };
      return { bed: `${this.sleepShift(f.night, f.bedT < "16:00" ? 1 : 0)}T${f.bedT}`, wake: `${this.sleepShift(f.night, 1)}T${f.wakeT}` };
    },
    sleepFormHours() {
      const f = this.sleepForm; if (!f || !f.bedT || !f.wakeT) return "";
      const { bed, wake } = this.sleepTimes(f);
      const inBed = (new Date(wake) - new Date(bed)) / 60000;
      const m = inBed - (+f.latency || 0) - (+f.awake || 0);
      if (inBed <= 0) return "";
      return `${Math.floor(m / 60)} h ${pad(Math.round(m % 60))} min asleep`;
    },

    // ---- the night strip: 18:00 of the night's date to 16:00 next day (22 h), minutes from 18:00
    NS_LEN: 22 * 60,
    nsMin(f, which) {
      const [h, m] = f[which === "bed" ? "bedT" : "wakeT"].split(":").map(Number);
      const next = which === "wake" || f.bedT < "16:00";
      return h * 60 + m - 18 * 60 + (next ? 1440 : 0);
    },
    nsClock(min) { const t = (18 * 60 + min) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; },
    nsSet(which, min) {
      const f = this.sleepForm, other = this.nsMin(f, which === "bed" ? "wake" : "bed");
      min = Math.round(min / 5) * 5;
      if (which === "bed") min = Math.max(0, Math.min(min, other - 15));
      else min = Math.min(this.NS_LEN, Math.max(min, other + 15, 6 * 60));     // wake-up after midnight
      f[which === "bed" ? "bedT" : "wakeT"] = this.nsClock(min);
    },
    nsView() {
      this.tick;
      const f = this.sleepForm; if (!f || f.kind !== "night") return null;
      const pc = m => Math.max(0, Math.min(100, (m / this.NS_LEN) * 100));
      const b = this.nsMin(f, "bed"), w = this.nsMin(f, "wake");
      const day = iso => new Date(iso + "T12:00").toLocaleDateString(this.loc(), { weekday: "short", day: "numeric", month: "short" });
      const ticks = [];
      for (let k = 0; k <= 22; k++) {
        const h = (18 + k) % 24;
        ticks.push({ key: k, left: (k / 22) * 100, label: h === 0 ? "00:00" : (h === 23 || h === 1 ? "" : String(h)), mid: h === 0, odd: k % 2 === 1 });   // room for "00:00"
      }
      return {
        bed: pc(b), wake: pc(w), mid: (6 / 22) * 100, ticks,
        left: day(f.night), right: day(this.sleepShift(f.night, 1)),
        logged: !!f.id, last: f.night >= this.sleepLastNight(),
      };
    },
    nsDown(ev) {
      const track = this.$refs.ntrack; if (!track || !this.sleepForm) return;
      const at = e => { const r = track.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * this.NS_LEN; };
      const m0 = at(ev), f = this.sleepForm;
      const which = ev.target.dataset?.h || (Math.abs(m0 - this.nsMin(f, "bed")) <= Math.abs(m0 - this.nsMin(f, "wake")) ? "bed" : "wake");
      this.nsSet(which, m0);
      track.setPointerCapture?.(ev.pointerId);
      const move = e => this.nsSet(which, at(e));
      const up = () => { track.removeEventListener("pointermove", move); track.removeEventListener("pointerup", up); track.removeEventListener("pointercancel", up); };
      track.addEventListener("pointermove", move); track.addEventListener("pointerup", up); track.addEventListener("pointercancel", up);
    },
    nsKey(which, ev) {
      const d = (ev.shiftKey ? 30 : 5) * (ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 1);
      this.nsSet(which, this.nsMin(this.sleepForm, which) + d); ev.preventDefault();
    },
    async sleepSave() {
      const f = this.sleepForm;
      const body = { night: f.night, kind: f.kind, ...this.sleepTimes(f),
                     latency_min: f.latency === "" || f.latency == null ? null : +f.latency,
                     awake_min: f.awake === "" || f.awake == null ? null : +f.awake,
                     quality: f.quality, free: f.kind === "nap" ? null : f.free, alarm: !!f.alarm, notes: f.notes || "" };
      try {
        await api(f.id ? `/api/sleep/${f.id}` : "/api/sleep", { method: f.id ? "PUT" : "POST", body });
        this.toast(f.id ? "Saved" : (f.kind === "nap" ? "Nap logged" : "Night logged"));
        await this.sleepInit();
        if (f.kind === "night") this.sleepGo(f.night); else this.sleepGo(this.sleepLastNight());   // stay on this night: ← for the one before
      } catch (e) { this.sleepErr = e.message; }
    },
    async sleepDelete(e) {
      if (!(await this.ask(`Delete the ${e.kind} of ${this.longDate(e.night)}?`))) return;
      await api(`/api/sleep/${e.id}`, { method: "DELETE" }); await this.sleepInit();
    },
    async sleepSaveSched() {
      try {
        const s = this.sleepSched;
        await api("/api/sleep/schedule", { method: "PUT", body: { need_h: +s.need_h, free_days: s.free_days, work: s.work, free: s.free } });
        this.sleepSchedOpen = false; this.sleepSched = null; this.toast("Schedule saved"); await this.sleepInit();
      } catch (e) { this.toast(e.message); }
    },
    sleepToggleFree(d) { const a = this.sleepSched.free_days; const i = a.indexOf(d); i < 0 ? a.push(d) : a.splice(i, 1); a.sort(); },
    sleepTonight() {
      // tonight's plan, and how long until bedtime
      this.tick;
      const st = this.sleepSt; if (!st) return null;
      const now = wallNow();
      const night = new Date(now); if (now.getHours() < 12) night.setDate(night.getDate() - 1);
      const iso = isoDate(night), free = this.sleepIsFreeMorning(iso);
      const part = free ? st.schedule.free : st.schedule.work;
      const [h, m] = part.bed.split(":").map(Number);
      const bed = new Date(iso + "T00:00"); bed.setHours(h, m, 0, 0); if (h < 12) bed.setDate(bed.getDate() + 1);
      const left = Math.round((bed - now) / 60000);
      return { free, bed: part.bed, wake: part.wake, left, label: left > 0 ? `in ${Math.floor(left / 60)} h ${pad(left % 60)} min` : (left > -180 ? "now" : "") };
    },
    sleepFmt(min) { if (min == null) return "–"; const m = Math.round(min); return `${Math.floor(m / 60)} h ${pad(m % 60)}`; },
    sleepRows() {
      // one row per night, newest first; x from 18:00 (360 min after noon) to 14:00 (1560)
      const st = this.sleepSt; if (!st) return [];
      const x0 = 360, x1 = 1560, pc = v => Math.max(0, Math.min(100, ((v - x0) / (x1 - x0)) * 100));
      const tgt = (free, k) => { const [h, m] = (free ? st.schedule.free : st.schedule.work)[k].split(":").map(Number); let t = h * 60 + m - 720; if (t < 0) t += 1440; return t; };
      return [...st.nights].reverse().map(n => ({
        key: n.id, night: n.night, free: n.free, asleep: n.asleep, short: n.asleep < 420, quality: n.quality,
        bed: `left:${pc(n.bed)}%;width:${pc(n.wake) - pc(n.bed)}%`,
        sleep: `left:${pc(n.onset)}%;width:${pc(n.wake) - pc(n.onset)}%`,
        plan: `left:${pc(tgt(n.free, "bed"))}%;width:${pc(tgt(n.free, "wake")) - pc(tgt(n.free, "bed"))}%`,
      }));
    },
    sleepTicks() { return [["18:00", 0], ["21:00", 15], ["00:00", 30], ["03:00", 45], ["06:00", 60], ["09:00", 75], ["12:00", 90]]; },   // 18:00-14:00 = 20 h
    sleepDayLabel(iso) { const d = new Date(iso + "T12:00"); return d.toLocaleDateString(this.loc(), { weekday: "short", day: "numeric", month: "short" }); },
    /* ---------------- teach: lesson calendar + live lesson plan (nothing here touches the study logs) */
    // views: "cal" (school year), "day" (timetables of one day), "run" (live), "edit" (editor)
    acadYear(iso) { const [y, m] = iso.split("-").map(Number); return m >= 8 ? y : y - 1; },
    async teachInit() {
      if (this.teachYear === null) this.teachYear = this.acadYear(this.today());
      if (!this.teachDay) this.teachDay = this.today();
      await this.loadLessons();
    },
    async loadLessons() {
      const y = this.teachYear;
      try { this.lessons = await api(`/api/lessons?start=${y}-08-01&end=${y + 1}-07-31`); }
      catch (e) { this.toast(e.message); }
    },
    teachGo(view) { this.teachView = view; store.set("chrono-teach-view", view); window.scrollTo(0, 0); },
    teachYears() { const y = this.acadYear(this.today()); return [y, y + 1]; },
    async pickYear(y) { this.teachYear = y; await this.loadLessons(); },
    calMonths() {
      this.tick;
      const y = this.teachYear, today = this.today(), out = [];
      const count = {};
      for (const l of this.lessons) count[l.date] = (count[l.date] || 0) + 1;
      for (let i = 0; i < 12; i++) {
        const m0 = (7 + i) % 12, yy = y + (7 + i >= 12 ? 1 : 0);
        const first = new Date(yy, m0, 1), days = new Date(yy, m0 + 1, 0).getDate();
        const cells = [];
        for (let k = 0; k < (first.getDay() + 6) % 7; k++) cells.push({ key: "b" + k });
        for (let d = 1; d <= days; d++) {
          const iso = `${yy}-${pad(m0 + 1)}-${pad(d)}`;
          const wd = new Date(yy, m0, d).getDay();
          cells.push({ key: iso, iso, d, n: count[iso] || 0, today: iso === today, weekend: wd === 0 || wd === 6, sel: iso === this.teachDay });
        }
        out.push({ key: `${yy}-${m0}`, label: first.toLocaleDateString(this.loc(), { month: "long" }), year: yy, cells });
      }
      return out;
    },
    openDay(iso) { this.teachDay = iso; this.teachErr = ""; this.teachGo("day"); },
    lessonsOn(iso) { return this.lessons.filter(l => l.date === iso).sort((a, b) => a.start_min - b.start_min); },
    hmOf(min) { return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`; },
    nowLesson() {
      // today's lesson that runs now or comes next
      this.tick;
      const now = this.tNowSec() / 60;
      return this.lessonsOn(this.today()).find(l => l.end_min > now) || null;
    },

    // ---- adding timetables (files, drop, paste)
    async teachFiles(fileList) {
      const files = await Promise.all([...fileList].map(async f => ({ name: f.name, text: await f.text() })));
      await this.teachAdd(files);
    },
    teachDrop(e) { this.teachDrag = false; if (e.dataTransfer?.files?.length) this.teachFiles(e.dataTransfer.files); },
    /** Each file with a timetable becomes one entry; files without one (a preamble) only lend their defaults. */
    async teachAdd(files) {
      const has = f => /\bhour1\s*:/.test(f.text);
      const tables = files.filter(has), extra = files.filter(f => !has(f));
      if (!tables.length) { this.teachErr = "No timetable found. Paste the  #let lesson = ( … )  block (with hour1, hour2) or drop the notes file."; return; }
      const errs = [];
      let saved = 0, lastDate = null;
      for (const f of tables) {
        try {
          const r = ChronoTeach.parseFiles([f, ...extra]);
          await this.saveLesson(r, f.text, null);
          saved++; lastDate = r.date || this.teachDay || this.today();
        } catch (e) { errs.push(`${f.name}: ${e.message}`); }
      }
      this.teachErr = errs.join("\n");
      if (saved) {
        this.teachPaste = "";
        this.toast(saved === 1 ? "Timetable saved" : `${saved} timetables saved`);
        if (lastDate) { this.teachYear = this.acadYear(lastDate); await this.loadLessons(); this.openDay(lastDate); this.teachErr = errs.join("\n"); }
      }
    },
    teachPasteSave() { return this.teachAdd([{ name: "pasted timetable", text: this.teachPaste }]); },
    /** Saves a parsed timetable. Its own date wins; without one it goes to the open day. */
    async saveLesson(r, source, id) {
      const date = r.date || this.teachDay || this.today();
      const settings = { start1: "08:00", start2: null, hourLength: 45, breakLength: 5, buffer: 0, ...r.settings };
      const span = ChronoTeach.spanOf(r.hours, settings);
      const body = {
        date, start_min: span.start, end_min: span.end, title: r.name || "Lesson", source: source || "",
        plan: { hours: r.hours, settings, fields: r.fields || {}, date, name: r.name },
      };
      return id ? api(`/api/lessons/${id}`, { method: "PUT", body }) : api("/api/lessons", { method: "POST", body });
    },
    async deleteLesson(l) {
      if (!(await this.ask(`Delete “${l.title}”?`))) return;
      await api(`/api/lessons/${l.id}`, { method: "DELETE" });
      if (this.teach && this.teach.id === l.id) { this.teach = null; this.teachSave(); }
      await this.loadLessons();
    },
    async downloadText(name, text) {
      // In the Chrono window: a save dialog from the app itself (the web view's downloads can crash on Linux).
      const api = window.pywebview?.api;
      if (api?.save_text) {
        try { const path = await api.save_text(name, text); if (path) this.toast(`Saved to ${path}`); }
        catch (e) { this.toast("Could not save: " + (e?.message || e)); }
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    },
    async copyText(text) {
      const api = window.pywebview?.api;
      if (api?.copy_text) { try { if (await api.copy_text(text)) return true; } catch { /* fall back below */ } }
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    },
    lessonTypst(l) { return l.source && /hour1\s*:/.test(l.source) ? l.source : ChronoTeach.toTypst(ChronoTeach.toModel(l.plan)); },
    fileNameOf(title) { return (title || "timetable").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s*·\s*/g, " ") + ".typ"; },

    // ---- running a lesson
    runLesson(l) {
      const p = l.plan;
      const old = this.teach && this.teach.id === l.id ? this.teach : null;
      this.teach = { id: l.id, hours: p.hours, settings: { ...p.settings }, title: l.title, date: l.date, shiftSec: old ? old.shiftSec : 0, shiftDay: old ? old.shiftDay : null };
      this.teachSave(); this.teachGo("run");
    },
    runParsed(r, title) {
      const settings = { start1: "08:00", start2: null, hourLength: 45, breakLength: 5, buffer: 0, ...r.settings };
      this.teach = { id: null, hours: r.hours, settings, title: title || r.name, date: r.date, shiftSec: 0, shiftDay: null };
      this.teachSave(); this.teachGo("run");
    },
    teachSave() { store.set("chrono-teach", this.teach); },
    tSet(k, v) {
      this.teach.settings[k] = v; this.teachSave();
      if (this.teach.id) {
        clearTimeout(this._tSetT);
        this._tSetT = setTimeout(async () => {
          const l = this.lessons.find(x => x.id === this.teach.id);
          if (!l) return;
          const r = { hours: this.teach.hours, settings: this.teach.settings, fields: l.plan.fields, date: l.date, name: l.title };
          try { await this.saveLesson(r, l.source, l.id); await this.loadLessons(); }
          catch (e) { this.toast(e.message); }
        }, 600);
      }
    },
    // ---- the live view on the phone: a QR code that holds the timetable itself (see static/teach-live.js)
    async phoneShow() {
      this.phone = { svg: "", link: "", err: "" };
      document.getElementById("phoneDlg").showModal();
      try {
        const base = this.meta.phone_url || new URL("/static/live.html", location.href).href;
        const link = base + "#" + await ChronoShare.pack(this.teach, this.tShiftSec(), this.lang);
        this.phone.link = link;
        if (link.length > ChronoShare.QR_MAX) { this.phone.err = "This timetable is too long for a QR code. Copy the link and send it to your phone."; return; }
        if (!window.qrcode) await loadScript("/static/vendor/qrcode.min.js");
        const q = qrcode(0, "L");
        q.addData(link, "Byte"); q.make();
        this.phone.svg = q.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      } catch (e) { this.phone.err = e.message || String(e); }
    },
    async phoneCopy() { this.toast(await this.copyText(this.phone.link) ? "Link copied" : "Could not copy the link"); },

    // ---- live view: static/teach-live.js (shared with the phone page, static/live.html)
    ...ChronoLive,
    tWallNow() { return wallNow(); },
    today() { return isoDate(wallNow()); },

    // ---- editor
    edNew(date) {
      this.ed = { date: date || this.teachDay || this.today(), institution: "", class: "", topic: "", start: "08:00", start2: "", hourLength: 45, breakLength: 5, buffer: 20,
                  hours: [{ activities: [{ minutes: 10, title: "", details: [] }] }] };
      this.edId = null; this.edErr = ""; this.teachGo("edit");
    },
    edOpen(l) { this.ed = ChronoTeach.toModel(l.plan); this.ed.date = l.date; this.edId = l.id; this.edErr = ""; this.teachGo("edit"); },
    async edExample(name, live) {
      try {
        const text = await (await fetch(`/static/examples/${name}`)).text();
        const r = ChronoTeach.parseFiles([{ name, text }]);
        if (live) { this.runParsed(r, "Example: " + r.name); return; }
        this.ed = ChronoTeach.toModel(r); this.ed.date = this.teachDay || this.today(); this.edId = null; this.edErr = ""; this.teachGo("edit");
      } catch (e) { this.toast(e.message); }
    },
    edTarget() { return this.ed.hourLength - Math.round(this.ed.hourLength * (+this.ed.buffer || 0) / 100); },
    edBufferMin() { return Math.round(this.ed.hourLength * (+this.ed.buffer || 0) / 100); },
    edActMin(a) { return a.details.length ? a.details.reduce((s, d) => s + (+d.minutes || 0), 0) : (+a.minutes || 0); },
    edHourSum(h) { return h.activities.reduce((s, a) => s + this.edActMin(a), 0); },
    edTitle() { return ChronoTeach.titleOf({ date: this.ed.date, institution: this.ed.institution, class: this.ed.class, topic: this.ed.topic }, "Untitled"); },
    edMove(list, i, d) { const j = i + d; if (j < 0 || j >= list.length) return; const [x] = list.splice(i, 1); list.splice(j, 0, x); },
    edStep(obj, key, d) { obj[key] = Math.max(0, (+obj[key] || 0) + d); },
    edAddHour() { this.ed.hours.push({ activities: [{ minutes: 10, title: "", details: [] }] }); },
    edAddAct(h) { h.activities.push({ minutes: 5, title: "", details: [] }); },
    edAddDetail(a) { if (!a.details.length) a.details.push({ minutes: +a.minutes || 5, title: a.title || "" }); else a.details.push({ minutes: 2, title: "" }); },
    edFill(h) {
      // put the minutes still missing into the last activity (or its last detail)
      const miss = this.edTarget() - this.edHourSum(h);
      const a = h.activities[h.activities.length - 1];
      if (!a || !miss) return;
      if (a.details.length) { const d = a.details[a.details.length - 1]; d.minutes = Math.max(0, (+d.minutes || 0) + miss); }
      else a.minutes = Math.max(0, (+a.minutes || 0) + miss);
    },
    edTypst() { return this.ed ? ChronoTeach.toTypst(this.ed) : ""; },
    edParsed() {
      const r = ChronoTeach.parseFiles([{ name: "editor", text: this.edTypst() }]);
      if (!r.hours.every(h => h.activities.length)) throw new Error("Every hour needs at least one activity.");
      return r;
    },
    async edSave() {
      try {
        if (!this.ed.date) throw new Error("Pick a date first.");
        const r = this.edParsed();
        r.date = this.ed.date;
        const l = await this.saveLesson(r, this.edTypst(), this.edId);
        this.edId = l.id; this.edErr = "";
        this.teachYear = this.acadYear(l.date); await this.loadLessons();
        this.toast("Saved"); this.openDay(l.date);
      } catch (e) { this.edErr = e.message; }
    },
    edRun() { try { this.runParsed(this.edParsed(), this.edTitle()); } catch (e) { this.edErr = e.message; } },
    async edCopy() { this.toast(await this.copyText(this.edTypst()) ? "Typst copied" : "Copy failed: select the text below"); },

    typst(t) { return ChronoTeach.typstHtml(t); },
    clockOf(sec) { sec = ((Math.round(sec) % 86400) + 86400) % 86400; return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec % 3600 / 60))}`; },
    mmss(sec) {
      sec = Math.max(0, Math.round(sec));
      const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },

    /* ---------------- theme */
    applyTheme() {
      const root = document.documentElement;
      if (this.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", this.theme);
    },
    tt(s) { this.lang; return window.I18N ? I18N.t(s) : s; },
    loc() { this.lang; return window.I18N ? I18N.locale() : "en-GB"; },   // reading lang makes dates re-render on a switch
    // Week starts Sunday in echarts' nameMap order
    dayLetters() { return [0, 1, 2, 3, 4, 5, 6].map(i => new Date(2026, 1, i + 1).toLocaleDateString(this.loc(), { weekday: "narrow" })); },
    monthShort() { return [...Array(12).keys()].map(m => new Date(2026, m, 15).toLocaleDateString(this.loc(), { month: "short" })); },
    async setLang(l) {
      await I18N.set(l); this.lang = l;
      // Server texts (sleep advice) and the charts are made in the language: fetch and draw again.
      if (this.sleepSt) this.sleepInit();
      this.$nextTick(() => { this.renderCharts(); this.renderActCharts(); });
    },
    toggleTheme() {
      this.theme = { system: "light", light: "dark", dark: "system" }[this.theme];
      store.set("chrono-theme", this.theme); this.applyTheme(); this.$nextTick(() => { this.renderCharts(); this.renderActCharts(); });
    },

    /* ---------------- formatting */
    sw(cat) { return `background:var(--c-${cat || "none"})`; },
    dots(kind) { return `--dot:var(--c-${kind === "other" ? "none" : kind});`; },
    bg(cat) { return `background:var(--c-${cat || "none"});`; },
    catLabel(k) { return this.meta.categories.find(c => c.key === k)?.label || "No category"; },
    fx(n, d = 1) { return n == null ? "–" : Number(n).toFixed(d); },
    hoursOrDash(h) { return h > 0.004 ? `${h.toFixed(1)} h` : "–"; },
    hms(sec) { sec = Math.max(0, Math.floor(sec)); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec % 3600 / 60))}:${pad(sec % 60)}`; },
    clockMain() { const s = this.hms(this.elapsedNow); return s.slice(0, 5); },
    clockSec() { return this.hms(this.elapsedNow).slice(5); },
    dur(sec) { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`; },
    hoursFmt(h) { return this.dur(h * 3600); },
    hm(ts) { return ts ? ts.slice(11, 16) : ""; },
    dmy(ts) { if (!ts) return ""; const [y, m, d] = ts.slice(0, 10).split("-"); return `${d}.${m}.${y}`; },
    longDate(ts) { return parseLocal(ts.slice(0, 10)).toLocaleDateString(this.loc(), { weekday: "long", day: "numeric", month: "long", year: "numeric" }); },
    toast(msg) { this.toastMsg = msg; clearTimeout(this._t); this._t = setTimeout(() => (this.toastMsg = ""), 2600); },
  };
}
