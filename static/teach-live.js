/* Chrono "Teach", live view: where a running timetable stands right now.
 *
 * Shared by the laptop app (static/app.js) and the phone page (static/live.html), so both show
 * exactly the same thing. ChronoLive is spread into the Alpine component of either page:
 *   { ...ChronoLive, ... }
 * The page that uses it provides:
 *   teach         the running timetable: { hours, settings, title, date, shiftSec, shiftDay }
 *   tick          a counter that changes every second (reading it makes the view re-render)
 *   tWallNow()    the current time as a Date
 *   today()       today as yyyy-mm-dd
 *   teachSave()   keeps `teach` (local storage)
 *   typst(t), clockOf(sec), mmss(sec)   text helpers
 *
 * ChronoShare packs a running timetable into a link for the phone and reads it back.
 */
(function () {
  "use strict";

  const pad = n => String(n).padStart(2, "0");

  const ChronoLive = {
  tShiftSec() { return this.teach && this.teach.shiftDay === this.today() ? this.teach.shiftSec : 0; },
  tShift(delta) {
    this.teach.shiftSec = delta === null ? 0 : this.tShiftSec() + delta;
    this.teach.shiftDay = this.today(); this.teachSave();
  },
  tNowSec() { this.tick; const d = this.tWallNow(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); },
  tStartNow() { this.tShift(this.tNowSec() - ChronoTeach.hmToSec(this.teach.settings.start1) - this.tShiftSec()); },
  tJump(item) { this.tShift(this.tNowSec() - item.start); },
  tShiftLabel() {
    const m = Math.round(this.tShiftSec() / 60), a = Math.abs(m);
    if (m === 0) return "shifted < 1 min";
    return `${a >= 60 ? Math.floor(a / 60) + " h " + (a % 60) + " min" : a + " min"} ${m > 0 ? "later" : "earlier"} than planned`;
  },
  tBuffered() { return !!(this.teach && this.teach.settings.buffer > 0); },
  tSchedule() {
    if (!this.teach) return [];
    const s = this.teach.settings;
    const hours = s.buffer > 0 ? ChronoTeach.stretchHours(this.teach.hours, s.hourLength) : this.teach.hours;
    return ChronoTeach.buildSchedule(hours, { ...s, shiftSec: this.tShiftSec() });
  },
  tState() { return this.teach ? ChronoTeach.locate(this.tSchedule(), this.tNowSec()) : { phase: "empty" }; },
  tClock() { this.tick; const d = this.tWallNow(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
  tStatus() {
    const s = this.tState();
    if (s.phase === "before") return `starts at ${this.clockOf(s.until)}`;
    if (s.phase === "after") return `ended at ${this.clockOf(s.ended)}`;
    if (s.phase === "break") return `break until ${this.clockOf(s.until)}`;
    if (s.hour) return `${s.hour.name} ends in ${this.mmss(s.hour.end - this.tNowSec())}`;
    return "";
  },
  tHeader() {
    const s = this.tState();
    return { before: "Starts soon", after: "Lesson over", break: "Break", buffer: "Spare time", activity: this.typst(s.act?.title || ""), empty: "" }[s.phase];
  },
  tSubHeader() {
    const s = this.tState();
    if (s.phase === "activity") return s.detail ? this.typst(s.detail.title) : (s.wrapUp ? "Wrap up" : "");
    if (s.phase === "before" && s.next) return "First: " + this.typst(s.next.item.title);
    if (s.phase === "break" && s.nextHour) return `${s.nextHour.name} starts at ${this.clockOf(s.nextHour.start)}`;
    return "";
  },
  tLeft(level) {
    const s = this.tState(), now = this.tNowSec();
    if (level === 1) {
      if (s.phase === "activity") return s.act.end - now;
      if (["before", "break", "buffer"].includes(s.phase)) return s.until - now;
      return null;
    }
    if (s.phase === "activity" && s.detail) return Math.min(s.detail.end, s.act.end) - now;
    return null;
  },
  tLeftLabel(level) {
    const s = this.tState();
    if (level === 1) return s.phase === "activity" ? `of ${s.act.minutes} min` : s.phase === "before" ? "until start" : "left";
    return s.detail ? `of ${s.detail.minutes} min` : "";
  },
  tProgress(level) {
    const s = this.tState(), now = this.tNowSec();
    const p = (a, b) => Math.max(0, Math.min(1, (now - a) / Math.max(1, b - a)));
    if (level === 1 && s.phase === "activity") return p(s.act.start, s.act.end);
    if (level === 1 && s.phase === "break") return p(s.hour.breakAfter.start, s.hour.breakAfter.end);
    if (level === 2 && s.phase === "activity" && s.detail) return p(s.detail.start, Math.min(s.detail.end, s.act.end));
    return null;
  },
  tNext() {
    const n = this.tState().next;
    if (!n || this.tState().phase === "before") return "";
    return `${this.typst(n.item.title)} <span class="muted">(${n.item.minutes} min)</span>`;
  },
  tRowClass(item) {
    const now = this.tNowSec();
    if (item.start == null) return "";
    return now >= item.end ? "past" : now >= item.start ? "current" : "";
  },
  tStrip() {
    const sch = this.tSchedule();
    if (!sch.length) return { segs: [], ticks: [], now: null };
    const a = sch[0].start, b = Math.max(...sch.map(h => Math.max(h.end, h.activitiesEnd)));
    const pc = t => ((t - a) / (b - a)) * 100;
    const segs = [], ticks = [];
    sch.forEach((h, hi) => {
      h.activities.forEach((x, i) => segs.push({ key: x.key, cls: (i % 2 ? "odd " : "") + this.tRowClass(x), style: `left:${pc(x.start)}%;width:${pc(x.end) - pc(x.start)}%`, title: `${x.title.replace(/[$*]/g, "")} (${x.minutes} min)` }));
      if (h.breakAfter) segs.push({ key: "b" + hi, cls: "brk " + this.tRowClass(h.breakAfter), style: `left:${pc(h.breakAfter.start)}%;width:${pc(h.breakAfter.end) - pc(h.breakAfter.start)}%`, title: "Break" });
      ticks.push({ key: "s" + hi, left: pc(h.start), label: this.clockOf(h.start) });
    });
    ticks.push({ key: "end", left: 100, label: this.clockOf(b) });
    const now = this.tNowSec();
    return { segs, ticks, now: now >= a && now <= b ? pc(now) : null };
  },

  // ---- buffer mode: the whole lesson as one wide strip, a window of +-10 % of an hour around now
  // Okabe & Ito (colour-blind safe), with a readable label colour each; green stays for breaks
  tPalette: [["#0072b2", "#fff"], ["#e69f00", "#13223a"], ["#cc79a7", "#13223a"], ["#56b4e9", "#13223a"], ["#d55e00", "#fff"], ["#f0e442", "#13223a"], ["#5b6b82", "#fff"]],
  tWin() {
    const sch = this.tSchedule();
    if (!sch.length) return null;
    const a = sch[0].start, b = Math.max(...sch.map(h => Math.max(h.end, h.activitiesEnd)));
    const pc = t => ((t - a) / (b - a)) * 100;
    const isBreak = t => /^\s*(break|pause|znüni|zvieri)\b/i.test(t.replace(/[*_]/g, ""));
    const segs = [], ticks = [], details = [];
    let ci = 0;
    sch.forEach((h, hi) => {
      h.activities.forEach(x => {
        const brk = isBreak(x.title);
        const [color, fg] = brk ? ["var(--live)", "#fff"] : this.tPalette[ci++ % this.tPalette.length];
        segs.push({ key: x.key, item: x, label: this.typst(x.title), cls: this.tRowClass(x) + (brk ? " brk" : ""), style: `left:${pc(x.start)}%;width:${pc(x.end) - pc(x.start)}%;--seg:${color};--seg-fg:${fg}` });
        x.details.forEach((d, di) => { if (di > 0 && d.start < x.end) details.push({ key: d.key, style: `left:${pc(d.start)}%` }); });
      });
      if (h.breakAfter) segs.push({ key: "b" + hi, item: h.breakAfter, label: "Break", cls: "brk " + this.tRowClass(h.breakAfter), style: `left:${pc(h.breakAfter.start)}%;width:${pc(h.breakAfter.end) - pc(h.breakAfter.start)}%;--seg:var(--live);--seg-fg:#fff` });
      ticks.push({ key: "s" + hi, left: pc(h.start), label: this.clockOf(h.start) });
      if (h.breakAfter) ticks.push({ key: "e" + hi, left: pc(h.end), label: this.clockOf(h.end) });
    });
    ticks.push({ key: "end", left: 100, label: this.clockOf(b) });
    const now = this.tNowSec();
    const half = 0.1 * this.teach.settings.hourLength * 60;
    let lo = now - half, hi = now + half;
    if (lo < a) { lo = a; hi = a + 2 * half; }
    if (hi > b) { hi = b; lo = b - 2 * half; }
    lo = Math.max(a, lo);
    const inside = now >= a && now <= b;
    // what lies inside the window: the parts you may be at right now
    const items = [];
    if (now <= b) sch.forEach(h => {
      h.activities.forEach(x => {
        if (x.end <= lo || x.start >= hi) return;
        const ds = x.details.filter(d => d.end > lo && d.start < hi && d.start < x.end);
        items.push({ key: x.key, title: this.typst(x.title), span: `${this.clockOf(x.start)}–${this.clockOf(x.end)}`, cur: now >= x.start && now < x.end,
                     details: ds.map(d => ({ key: d.key, title: this.typst(d.title), cur: now >= d.start && now < d.end })) });
      });
      if (h.breakAfter && h.breakAfter.end > lo && h.breakAfter.start < hi) items.push({ key: "b" + h.name, title: "Break", span: `${this.clockOf(h.breakAfter.start)}–${this.clockOf(h.breakAfter.end)}`, cur: now >= h.breakAfter.start && now < h.breakAfter.end, details: [], brk: true });
    });
    return {
      segs, ticks, details, items,
      now: inside ? pc(now) : null,
      win: now <= b ? { left: pc(lo), width: pc(hi) - pc(lo) } : null,
      endsIn: inside ? b - now : null,
    };
  },
  };

  // ------------------------------------------------------------ a running timetable as a link
  // The whole timetable travels in the part of the link after "#", which browsers never send to
  // a server:   https://…/live.html#c=<deflate, base64url>   (or #j=<plain JSON, base64url>
  // from a browser that cannot compress). The packed form, version 1:
  //   { v: 1, t: title, d: date, l: language, x: shift in seconds today,
  //     s: [start1, start2, hourLength, breakLength, buffer],
  //     h: [ hour: [ [minutes, title, [[minutes, step], …]], … ], … ] }

  const QR_MAX = 2300;   // characters a QR code holds comfortably (version 40-L: 2953 bytes)

  const b64 = {
    enc(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    dec(str) { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; },
  };
  async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

  function toPacked(teach, shiftSec, lang) {
    const s = teach.settings;
    const o = { v: 1, t: teach.title || "", s: [s.start1, s.start2 || 0, s.hourLength, s.breakLength, s.buffer || 0],
                h: teach.hours.map(h => h.activities.map(a => a.details.length ? [a.minutes, a.title, a.details.map(d => [d.minutes, d.title])] : [a.minutes, a.title])) };
    if (teach.date) o.d = teach.date;
    if (lang) o.l = lang;
    if (shiftSec) o.x = Math.round(shiftSec);
    return o;
  }

  function fromPacked(o, today) {
    const bad = () => { throw new Error("This link does not hold a timetable."); };
    const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : bad());
    const int = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : bad());
    const hm = v => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v) ? v : bad());
    if (!o || o.v !== 1 || !Array.isArray(o.s) || !Array.isArray(o.h) || !o.h.length || o.h.length > 12) bad();
    const row = r => (Array.isArray(r) ? { minutes: int(r[0], 0, 600), title: str(r[1], 300) } : bad());
    const hours = o.h.map((h, n) => ({
      name: `Hour ${n + 1}`,
      activities: (Array.isArray(h) && h.length <= 60 ? h : bad()).map(a => ({ ...row(a), details: (a[2] === undefined ? [] : Array.isArray(a[2]) && a[2].length <= 60 ? a[2] : bad()).map(row) })),
    }));
    const shiftSec = o.x === undefined ? 0 : int(o.x, -86400, 86400);
    return {
      id: null, hours, title: o.t === undefined ? "" : str(o.t, 300),
      date: typeof o.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.d) ? o.d : null,
      lang: ["en", "fr", "de", "it"].includes(o.l) ? o.l : null,
      settings: { start1: hm(o.s[0]), start2: o.s[1] ? hm(o.s[1]) : null, hourLength: int(o.s[2], 5, 180), breakLength: int(o.s[3], 0, 120), buffer: int(o.s[4], 0, 60) },
      shiftSec, shiftDay: shiftSec ? today : null,
    };
  }

  const ChronoShare = {
    QR_MAX,
    /** "c=…" or "j=…": what goes after the # of the phone link. */
    async pack(teach, shiftSec, lang) {
      const bytes = new TextEncoder().encode(JSON.stringify(toPacked(teach, shiftSec, lang)));
      if (window.CompressionStream) {
        try { return "c=" + b64.enc(await pipe(bytes, new CompressionStream("deflate-raw"))); } catch { /* fall back to plain */ }
      }
      return "j=" + b64.enc(bytes);
    },
    /** The timetable held in a link's "#…" part; null when there is none. Throws on a damaged one. */
    async unpack(hash, today) {
      const m = /^#?([cj])=([\w-]+)$/.exec(hash || "");
      if (!m) return null;
      try {
        let bytes = b64.dec(m[2]);
        if (m[1] === "c") {
          if (!window.DecompressionStream) throw new Error("old");
          bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
        }
        return fromPacked(JSON.parse(new TextDecoder().decode(bytes)), today);
      } catch (e) {
        throw new Error(e.message === "old" ? "This browser is too old to read the link. Update it, or open the link in Chrome or Firefox." : "This link does not hold a timetable. Scan the code again.");
      }
    },
    toPacked, fromPacked,
  };

  window.ChronoLive = ChronoLive;
  window.ChronoShare = ChronoShare;
})();
