/* Chrono "Teach", live view for the phone (static/live.html).
 *
 * The view itself is ChronoLive (static/teach-live.js), the same code the laptop runs. This file
 * only adds what the phone page needs around it: reading the timetable from the link, keeping
 * it in this browser, the clock tick, keeping the screen on, and offline use.
 */
"use strict";

function chronoLivePage() {
  const pad = n => String(n).padStart(2, "0");
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  return {
    ...ChronoLive,

    teach: store.get("chrono-live", null),
    tick: 0, err: "", toastMsg: "", undo: null,
    canWake: "wakeLock" in navigator, keepOn: store.get("chrono-live-keep-on", true), _lock: null,

    async init() {
      setInterval(() => this.tick++, 500);
      await this.readLink();
      document.body.classList.add("ready");   // style.css keeps the page hidden until then
      window.addEventListener("hashchange", () => this.readLink());   // a second code scanned into the same tab
      document.addEventListener("visibilitychange", () => { if (!document.hidden) { this.tick++; this.wake(); } });
      this.wake();
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("live-sw.js").catch(() => {});
    },

    // ---- the timetable arrives in the link, then lives in this browser
    async readLink() {
      if (!location.hash) return;
      try {
        const got = await ChronoShare.unpack(location.hash, this.today());
        if (!got) return;
        const lang = got.lang; delete got.lang;
        this.teach = got; this.teachSave(); this.err = "";
        // drop the timetable from the address: a reload must not undo what was changed here since
        history.replaceState(null, "", location.pathname + location.search);
        if (lang && window.I18N && lang !== I18N.lang) { await I18N.ready; await I18N.set(lang); }
      } catch (e) { this.err = e.message; }
    },

    // ---- what ChronoLive asks of its page
    tWallNow() { return new Date(); },
    today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; },
    teachSave() { store.set("chrono-live", this.teach); },
    typst(t) { return ChronoTeach.typstHtml(t); },
    clockOf(sec) { sec = ((Math.round(sec) % 86400) + 86400) % 86400; return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec % 3600 / 60))}`; },
    mmss(sec) {
      sec = Math.max(0, Math.round(sec));
      const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },
    longDate(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(window.I18N ? I18N.locale() : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    },

    tSet(k, v) { this.teach.settings[k] = v; this.teachSave(); },

    // A tap on a plan row moves the whole plan. On a phone a tap happens by accident, so it can be undone.
    jump(item) {
      const before = { shiftSec: this.teach.shiftSec, shiftDay: this.teach.shiftDay };
      this.tJump(item);
      this.toast("Plan moved: this part starts now", before);
    },
    undoJump() {
      if (!this.undo) return;
      Object.assign(this.teach, this.undo); this.teachSave();
      this.toast("Back where it was");
    },
    toast(msg, undo = null) {
      this.toastMsg = msg; this.undo = undo;
      clearTimeout(this._t);
      this._t = setTimeout(() => { this.toastMsg = ""; this.undo = null; }, undo ? 6000 : 2600);
    },

    // ---- keep the screen on while the page is in front (the system releases the lock when it is not)
    async wake() {
      if (!this.canWake) return;
      try {
        if (this.keepOn && !document.hidden) { if (!this._lock || this._lock.released) this._lock = await navigator.wakeLock.request("screen"); }
        else if (this._lock) { await this._lock.release(); this._lock = null; }
      } catch { /* battery saver, or not allowed: the screen then follows the phone's own setting */ }
    },
    setKeepOn(on) { this.keepOn = on; store.set("chrono-live-keep-on", on); this.wake(); },
  };
}
