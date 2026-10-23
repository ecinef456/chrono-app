/* Chrono front end — Alpine.js component + ECharts. */

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
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
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
};

function chrono() {
  return {
    meta: { categories: [], break_types: [] },
    semesters: [], semesterId: null, courses: [], stats: null, sessions: [], recent: [],
    timer: { state: "idle" }, timerFetchedAt: Date.now(),
    selectedId: store.get("chrono-course", null),
    tab: store.get("chrono-tab", "dash"),
    theme: store.get("chrono-theme", "system"),
    logCourse: 0, tick: 0, toastMsg: "",
    entry: {}, entryErr: "", stopNotes: "",
    courseForm: {}, courseErr: "", semForm: {}, newSem: {}, semErr: "",
    charts: {},

    /* ---------------- lifecycle */
    async init() {
      this.applyTheme();
      this.meta = await api("/api/meta");
      this.semesters = await api("/api/semesters");
      const today = isoDate(new Date());
      const current = this.semesters.find(s => s.start_date && s.start_date <= today && (!s.end_date || today <= s.end_date));
      const saved = store.get("chrono-semester", null);
      this.semesterId = (this.semesters.find(s => s.id === saved) || current || this.semesters.filter(s => s.course_count).pop() || this.semesters[0] || {}).id ?? null;
      await this.refreshTimer();
      await this.loadSemester();
      this.$watch("tab", v => { store.set("chrono-tab", v); if (v === "dash") this.$nextTick(() => this.renderCharts()); });
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
      const [courses, sessions, recent] = await Promise.all([
        api(`/api/courses?semester_id=${this.semesterId}`),
        api(`/api/sessions?semester_id=${this.semesterId}`),
        api(`/api/sessions?limit=80`),
      ]);
      this.courses = courses; this.sessions = sessions; this.recent = recent;
      const sem = this.currentSemester;
      this.semForm = { start_date: sem?.start_date || "", end_date: sem?.end_date || "" };
      if (!this.openCourses.some(c => c.id === this.selectedId)) this.selectedId = this.openCourses[0]?.id ?? null;
      await this.loadStats();
    },
    async loadStats() {
      if (!this.semesterId) return;
      this.stats = await api(`/api/stats?semester_id=${this.semesterId}`);
      if (this.tab === "dash") this.$nextTick(() => this.renderCharts());
    },
    async changeSemester() { store.set("chrono-semester", this.semesterId); await this.loadSemester(); },
    async refreshTimer() {
      this.timer = await api("/api/timer");
      this.timerFetchedAt = Date.now();
    },

    /* ---------------- derived */
    get currentSemester() { return this.semesters.find(s => s.id === this.semesterId); },
    get openCourses() { return this.courses.filter(c => !c.finished); },
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
      try { this.timer = await api("/api/timer/start", { method: "POST", body: { course_id: this.selectedId } }); this.timerFetchedAt = Date.now(); this.remember(); this.loadStats(); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    async pause() {
      try { this.timer = await api("/api/timer/pause", { method: "POST" }); this.timerFetchedAt = Date.now(); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    async resume(bt) {
      try { this.timer = await api("/api/timer/resume", { method: "POST", body: { break_type: bt } }); this.timerFetchedAt = Date.now(); this.loadStats(); }
      catch (e) { this.toast(e.message); await this.refreshTimer(); }
    },
    openStop() { this.stopNotes = ""; document.getElementById("stopDlg").showModal(); this.$nextTick(() => this.$refs.stopNotes.focus()); },
    async stop(save) {
      try {
        const r = await api("/api/timer/stop", { method: "POST", body: { save, notes: this.stopNotes } });
        document.getElementById("stopDlg").close();
        this.toast(save && r.saved_session_id ? `Saved ${this.dur(r.duration_sec)}` : "Session discarded");
        await this.refreshTimer(); await this.loadSemester();
      } catch (e) { this.toast(e.message); }
    },
    hotkey(e) {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target; if (t.closest("input,textarea,select,button,dialog")) return;
      e.preventDefault();
      if (this.timer.state === "idle") this.start(); else if (this.timer.state === "running") this.pause();
    },
    updateTitle() {
      if (this.timer.state === "idle") document.title = "Chrono";
      else document.title = `${this.timer.state === "paused" ? "❚❚ " : ""}${this.hms(this.elapsedNow)} ${this.timer.course?.code.toUpperCase() || ""}`;
    },

    /* ---------------- entries */
    openEntry(s = null) {
      this.entryErr = "";
      if (s) {
        const st = parseLocal(s.start), en = parseLocal(s.end);
        this.entry = { id: s.id, course_id: s.course_id, date: isoDate(st), from: `${pad(st.getHours())}:${pad(st.getMinutes())}`, to: `${pad(en.getHours())}:${pad(en.getMinutes())}`, minutes: Math.round(s.duration_sec / 60), notes: s.notes || "" };
      } else {
        const now = new Date(), from = new Date(now - 3600e3);
        this.entry = { id: null, course_id: this.selectedId || this.courses[0]?.id, date: isoDate(now), from: `${pad(from.getHours())}:${pad(from.getMinutes())}`, to: `${pad(now.getHours())}:${pad(now.getMinutes())}`, minutes: 60, notes: "" };
      }
      document.getElementById("entryDlg").showModal();
    },
    entrySpan() {
      const st = parseLocal(`${this.entry.date}T${this.entry.from}`); let en = parseLocal(`${this.entry.date}T${this.entry.to}`);
      if (en <= st) en = new Date(en.getTime() + 864e5); // past midnight
      return [st, en];
    },
    syncDuration() { if (!this.entry.from || !this.entry.to) return; const [st, en] = this.entrySpan(); this.entry.minutes = Math.round((en - st) / 60000); },
    async saveEntry() {
      const [st, en] = this.entrySpan();
      const body = { course_id: this.entry.course_id, start: isoLocal(st), end: isoLocal(en), duration_sec: Math.round(this.entry.minutes * 60), notes: this.entry.notes };
      try {
        if (this.entry.id) await api(`/api/sessions/${this.entry.id}`, { method: "PUT", body });
        else await api("/api/sessions", { method: "POST", body });
        document.getElementById("entryDlg").close();
        this.toast(this.entry.id ? "Entry updated" : "Entry added");
        await this.loadSemester();
      } catch (e) { this.entryErr = e.message; }
    },
    async deleteSession(s) {
      if (!confirm(`Delete ${this.dur(s.duration_sec)} of ${s.course_code.toUpperCase()} on ${this.dmy(s.start)}?`)) return;
      await api(`/api/sessions/${s.id}`, { method: "DELETE" });
      this.toast("Entry deleted"); await this.loadSemester();
    },
    filteredSessions() { return this.logCourse ? this.sessions.filter(s => s.course_id === this.logCourse) : this.sessions; },
    groupedSessions() {
      const groups = [];
      for (const s of this.filteredSessions()) {
        const d = s.start.slice(0, 10);
        let g = groups[groups.length - 1];
        if (!g || g.date !== d) { g = { date: d, items: [], total: 0 }; groups.push(g); }
        g.items.push(s); g.total += s.duration_sec / 3600;
      }
      return groups;
    },

    /* ---------------- courses & semesters */
    openCourse(c = null) {
      this.courseErr = "";
      this.courseForm = c ? { ...c, category: c.category || "", deadline: c.deadline || "", grade: c.grade || "" }
                          : { id: null, code: "", name: "", ects: 3, deadline: this.currentSemester?.end_date || "", category: "master", finished: false, grade: "" };
      document.getElementById("courseDlg").showModal();
    },
    async saveCourse() {
      const f = this.courseForm;
      const body = { semester_id: this.semesterId, code: f.code, name: f.name, ects: Number(f.ects), deadline: f.deadline || null, category: f.category || null, finished: !!f.finished, grade: f.finished ? (f.grade || null) : null };
      try {
        if (f.id) await api(`/api/courses/${f.id}`, { method: "PUT", body });
        else await api("/api/courses", { method: "POST", body });
        document.getElementById("courseDlg").close();
        this.toast(f.id ? "Course updated" : "Course added");
        this.semesters = await api("/api/semesters"); await this.loadSemester();
      } catch (e) { this.courseErr = e.message; }
    },
    async deleteCourse() {
      if (!confirm(`Delete ${this.courseForm.name}?`)) return;
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
    sortedCourses() {
      const cs = [...(this.stats?.courses || [])];
      return cs.sort((a, b) => (a.finished - b.finished) || (a.sort - b.sort));
    },
    paceOf(c) {
      if (c.needed_week == null) return c.hours >= c.target_hours ? { cls: "good", label: "Complete", icon: ICONS.check } : { cls: "bad", label: "Deadline passed", icon: ICONS.flag };
      if (c.needed_week <= 0.05) return { cls: "good", label: "Complete", icon: ICONS.check };
      const r = c.avg_4w / c.needed_week;
      if (r >= 1) return { cls: "good", label: "On pace", icon: ICONS.check };
      if (r >= 0.75) return { cls: "warn", label: "Slightly behind", icon: ICONS.alert };
      return { cls: "bad", label: "Behind", icon: ICONS.down };
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
      const used = new Set(this.courses.map(c => c.category || "none"));
      return this.meta.categories.filter(c => used.has(c.key));
    },
    breakTypes() { return Object.keys(this.stats?.break_totals || {}).length ? Object.keys(this.stats.break_totals) : this.meta.break_types; },
    breakRatio() {
      const b = Object.values(this.stats?.break_totals || {}).reduce((a, v) => a + v, 0), h = this.stats?.summary.hours || 0;
      return h ? `${Math.round(b / h * 60)} min` : "–";
    },

    /* today strip */
    todaySessions() {
      const today = isoDate(new Date());
      return this.recent.filter(s => s.start.slice(0, 10) === today || s.end.slice(0, 10) === today);
    },
    todayHours() {
      this.tick;
      let sec = this.todaySessions().reduce((a, s) => a + s.duration_sec, 0);
      if (this.timer.state !== "idle" && this.timer.session_start?.slice(0, 10) === isoDate(new Date())) sec += this.elapsedNow;
      return sec / 3600;
    },
    dayStripRange() {
      let lo = 7, hi = 24;
      const start = new Date(); start.setHours(0, 0, 0, 0);
      for (const s of this.todaySessions()) { const h = Math.max(0, (parseLocal(s.start) - start) / 36e5); lo = Math.min(lo, Math.floor(h)); }
      if (this.timer.session_start) { const h = (parseLocal(this.timer.session_start) - start) / 36e5; if (h >= 0) lo = Math.min(lo, Math.floor(h)); }
      lo = Math.max(0, lo - (lo % 3));
      const ticks = []; for (let h = lo; h <= hi; h += 3) ticks.push(`${pad(h % 24)}:00`);
      return { lo, hi, ticks, label: "" };
    },
    pct(d) { const { lo, hi } = this.dayStripRange(); const start = new Date(); start.setHours(0, 0, 0, 0); const h = (d - start) / 36e5; return Math.max(0, Math.min(100, (h - lo) / (hi - lo) * 100)); },
    nowPct() { this.tick; return this.pct(new Date()); },
    daySegments() {
      this.tick;
      const segs = this.todaySessions().map(s => {
        const a = this.pct(parseLocal(s.start)), b = this.pct(parseLocal(s.end));
        return { key: "s" + s.id, live: false, style: `left:${a}%;width:${Math.max(b - a, 0.4)}%;${this.bg(s.category)}`, title: `${s.course_code.toUpperCase()} ${this.hm(s.start)}–${this.hm(s.end)}, ${this.dur(s.duration_sec)}` };
      });
      if (this.timer.state !== "idle" && this.timer.session_start) {
        const a = this.pct(parseLocal(this.timer.session_start));
        const endT = this.timer.state === "running" ? new Date() : parseLocal(this.timer.pause_start);
        const b = this.pct(endT);
        segs.push({ key: "live", live: this.timer.state === "running", style: `left:${a}%;width:${Math.max(b - a, 0.4)}%;${this.bg(this.timer.course?.category)}`, title: "Current session" });
      }
      return segs;
    },

    /* ---------------- charts */
    renderCharts() {
      if (!this.stats || this.tab !== "dash" || !window.echarts) return;
      const ink2 = cssVar("--ink-2"), ink3 = cssVar("--ink-3"), rule = cssVar("--rule"), panel = cssVar("--panel"), ink = cssVar("--ink");
      const dark = cssVar("color-scheme") === "dark";
      const font = { fontFamily: "Hanken Grotesk, system-ui, sans-serif" };
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
        const cell = Math.max(10, Math.min(26, Math.floor((el.clientWidth - 50) / weeksN)));
        cal.setOption({
          animation: false, textStyle: font,
          tooltip: { ...tooltipBase, formatter: p => `${this.longDate(p.value[0])}<br><b>${this.hoursFmt(p.value[1])}</b>` },
          visualMap: { show: false, min: 0, max, inRange: { color: dark ? ["#184f95", "#3987e5", "#9ec5f4"] : ["#cde2fb", "#3987e5", "#0d366b"] } },
          calendar: {
            top: 30, left: 34, right: 8, orient: "horizontal", range: [r.start, r.end], cellSize: [cell, cell],
            splitLine: { show: false }, itemStyle: { color: cssVar("--track"), borderColor: panel, borderWidth: 3, borderRadius: 3 },
            yearLabel: { show: false }, dayLabel: { firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"], color: ink3, fontSize: 11, ...font },
            monthLabel: { color: ink2, ...font, fontSize: 12 },
          },
          series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderRadius: 3, borderColor: panel, borderWidth: 3 } }],
        }, true);
        el.style.height = `${30 + cell * 7 + 24}px`; cal.resize();
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

    /* ---------------- theme */
    applyTheme() {
      const root = document.documentElement;
      if (this.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", this.theme);
    },
    toggleTheme() {
      this.theme = { system: "light", light: "dark", dark: "system" }[this.theme];
      store.set("chrono-theme", this.theme); this.applyTheme(); this.$nextTick(() => this.renderCharts());
    },

    /* ---------------- formatting */
    sw(cat) { return `background:var(--c-${cat || "none"})`; },
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
    longDate(ts) { return parseLocal(ts.slice(0, 10)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); },
    toast(msg) { this.toastMsg = msg; clearTimeout(this._t); this._t = setTimeout(() => (this.toastMsg = ""), 2600); },
  };
}
