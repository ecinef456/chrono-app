/* Chrono "Teach" mode: reads the lesson plan from Typst notes and turns it into a live schedule.
 *
 * Reads, from one or more dropped .typ files:
 *   #let lesson = ( hour1: ((12, [Intro], ((1, [..]), ...)), ...), hour2: (...) )
 *   #SUB-TABLE(lesson, hour-1-time-start: "10:15", ...)        (optional named args)
 *   #let hour-1-time-start = "08:00"  /  hour-2-time-start / hour-length / break-length   (preamble)
 *   #show: notes.with(course: "...", week: "...")              (for the title)
 * Nothing here is stored in the study logs.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------ tiny Typst value parser

  function skipWs(s, i) {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith("//", i)) { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (s.startsWith("/*", i)) { const j = s.indexOf("*/", i + 2); i = j < 0 ? s.length : j + 2; continue; }
      return i;
    }
  }

  function readContent(s, i) { // s[i] === "["
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") { j++; continue; }
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return [{ content: s.slice(i + 1, j) }, j + 1];
    }
    throw new Error("A [ ... ] block is not closed.");
  }

  function readString(s, i) { // s[i] === '"'
    let out = "", j = i + 1;
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === "\\" && j + 1 < s.length) { j++; out += s[j] === "n" ? "\n" : s[j]; } else out += s[j];
    }
    return [out, j + 1];
  }

  function readOther(s, i) { // anything else (a figure call, a variable): keep the raw text
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
      else if (c === '"') { j = readString(s, j)[1] - 1; }
    }
    const raw = s.slice(i, j).trim();
    if (raw === "auto") return [{ auto: true }, j];
    if (raw === "none") return [null, j];
    if (raw === "true" || raw === "false") return [raw === "true", j];
    if (/^-?\d+(\.\d+)?$/.test(raw)) return [Number(raw), j];
    return [{ raw }, j];
  }

  function readCollection(s, i) { // s[i] === "(" ; returns { pos: [...], named: {...} }
    const pos = [], named = {};
    i = skipWs(s, i + 1);
    if (s.startsWith(":)", i)) return [{ pos, named }, i + 2];
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === ")") return [{ pos, named }, i + 1];
      if (i >= s.length) throw new Error("A ( ... ) list is not closed.");
      const key = /^([A-Za-z_][\w-]*)\s*:(?!:)/.exec(s.slice(i, i + 80));
      let name = null;
      if (key) { name = key[1]; i = skipWs(s, i + key[0].length); }
      const [val, j] = readValue(s, i);
      if (name) named[name] = val; else pos.push(val);
      i = skipWs(s, j);
      if (s[i] === ",") i++;
    }
  }

  function readValue(s, i) {
    i = skipWs(s, i);
    const c = s[i];
    if (c === "(") {
      const [col, j] = readCollection(s, i);
      // An array of values, or a dictionary, or (for call arguments) both
      if (!Object.keys(col.named).length) return [col.pos, j];
      if (!col.pos.length) return [col.named, j];
      return [col, j];
    }
    if (c === "[") return readContent(s, i);
    if (c === '"') return readString(s, i);
    return readOther(s, i);
  }

  // ------------------------------------------------------------ extract the lesson from files

  // Names used in the preamble / SUB-TABLE arguments, and (shorter) inside the timetable itself.
  const SETTINGS = {
    "hour-1-time-start": "start1", "hour-2-time-start": "start2", "hour-length": "hourLength", "break-length": "breakLength",
    "start": "start1", "hour-2-start": "start2",
  };

  function toSettings(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const key = SETTINGS[k];
      if (!key) continue;
      if (key === "start2") out.start2 = v && v.auto ? null : (typeof v === "string" ? v : undefined);
      else if (key === "start1") { if (typeof v === "string") out.start1 = v; }
      else if (typeof v === "number") out[key] = v;
    }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  function findLetValue(src, name) {
    const re = new RegExp("#let\\s+" + name.replace(/[-]/g, "\\-") + "\\s*=\\s*");
    const m = re.exec(src);
    if (!m) return undefined;
    return readValue(src, m.index + m[0].length)[0];
  }

  function hoursFrom(dict) {
    // hour1, hour2, ... in their numeric order (other keys are ignored)
    const keys = Object.keys(dict).filter(k => /^hour\d+$/.test(k)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
    if (!keys.length) throw new Error("The lesson has no hour1 / hour2 entries.");
    return keys.map((k, n) => {
      const acts = dict[k];
      if (!Array.isArray(acts)) throw new Error(`${k} is not a list of activities.`);
      return {
        name: `Hour ${n + 1}`,
        activities: acts.map((a, ai) => {
          if (!Array.isArray(a) || typeof a[0] !== "number") throw new Error(`Activity ${ai + 1} of ${k} should look like (minutes, [title], (details...)).`);
          const details = Array.isArray(a[2]) ? a[2] : [];
          return {
            minutes: a[0],
            title: contentText(a[1]),
            details: details.filter(d => Array.isArray(d) && typeof d[0] === "number").map(d => ({ minutes: d[0], title: contentText(d[1]) })),
          };
        }),
      };
    });
  }

  function contentText(v) {
    if (v && typeof v === "object" && "content" in v) return v.content.trim();
    if (typeof v === "string") return v;
    if (v && v.raw) return v.raw;
    return v == null ? "" : String(v);
  }

  /** files: [{ name, text }] (a dropped file or pasted text). Returns { hours, settings, title, date, fileName }. */
  function parseFiles(files) {
    let hours = null, settings = {}, callSettings = {}, ownSettings = {}, title = {}, date = null, from = null;
    const useDict = (dict, name) => {
      hours = hoursFrom(dict); from = name;
      ownSettings = toSettings(dict);
      if (typeof dict.title === "string") title.week = dict.title;
      if (typeof dict.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dict.date)) date = dict.date;
    };
    for (const f of files) {
      const src = f.text;
      for (const m of src.matchAll(/(course|week)\s*:\s*"([^"]*)"/g)) title[m[1]] = title[m[1]] || m[2];
      // preamble-style defaults
      for (const name of Object.keys(SETTINGS)) {
        const v = findLetValue(src, name);
        if (v !== undefined) Object.assign(settings, toSettings({ [name]: v }));
      }
      // which variable holds the plan: the first argument of SUB-TABLE / TIME-TABLE, else "lesson"
      let varName = "lesson";
      const call = /#(SUB-TABLE|TIME-TABLE)\s*\(/.exec(src);
      if (call) {
        const [args] = readCollection(src, call.index + call[0].length - 1);
        const first = args.pos[0];
        if (first && first.raw && /^[A-Za-z_][\w-]*$/.test(first.raw)) varName = first.raw;
        Object.assign(callSettings, toSettings(args.named));
        if (first && typeof first === "object" && !first.raw && !Array.isArray(first)) useDict(first, f.name);
      }
      const isDict = v => v && typeof v === "object" && !Array.isArray(v) && !v.raw && !("content" in v);
      if (!hours) {
        const dict = findLetValue(src, varName);
        if (isDict(dict)) useDict(dict, f.name);
      }
      if (!hours) {
        // pasted timetable without "#let lesson =": the first ( ... ) that has hour1
        const at = src.search(/\(\s*(?:\/\/[^\n]*\n\s*)*[A-Za-z][\w-]*\s*:/);
        if (at >= 0) {
          const v = readValue(src, at)[0];
          if (isDict(v) && Object.keys(v).some(k => /^hour\d+$/.test(k))) useDict(v, f.name);
        }
      }
    }
    if (!hours && files.length === 1) {
      // pasted without the outer parentheses: "start: ..., hour1: (...), hour2: (...)"
      try {
        const v = readValue("(" + files[0].text + "\n)", 0)[0];
        if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some(k => /^hour\d+$/.test(k))) {
          hours = hoursFrom(v); from = files[0].name; ownSettings = toSettings(v);
          if (typeof v.title === "string") title.week = v.title;
          if (typeof v.date === "string") date = v.date;
        }
      } catch (e) { /* fall through to the message below */ }
    }
    if (!hours) throw new Error("No timetable found. Paste the  #let lesson = ( ... )  block (with hour1, hour2) or drop the notes file.");
    // the timetable's own settings win over SUB-TABLE arguments, which win over the preamble
    return { hours, settings: { ...settings, ...callSettings, ...ownSettings }, title, date, fileName: from };
  }

  // ------------------------------------------------------------ schedule

  const hmToSec = t => { const [h, m, s = 0] = String(t).split(":").map(Number); return h * 3600 + m * 60 + s; };

  /**
   * Build absolute times (seconds since today's midnight) for every hour, activity and detail.
   * cfg: { start1: "08:00", start2: null|"09:00", hourLength: 45, breakLength: 5, shiftSec: 0 }
   */
  function buildSchedule(hours, cfg) {
    const L = cfg.hourLength * 60, B = cfg.breakLength * 60, shift = cfg.shiftSec || 0;
    const out = [];
    let start = hmToSec(cfg.start1) + shift;
    hours.forEach((h, hi) => {
      if (hi === 1 && cfg.start2) start = hmToSec(cfg.start2) + shift;
      const hour = { name: h.name, start, end: start + L, planned: 0, activities: [] };
      let t = start;
      h.activities.forEach((a, ai) => {
        const act = { key: `${hi}.${ai}`, title: a.title, minutes: a.minutes, start: t, end: t + a.minutes * 60, details: [], detailSum: 0 };
        let u = t;
        a.details.forEach((d, di) => {
          act.details.push({ key: `${hi}.${ai}.${di}`, title: d.title, minutes: d.minutes, start: u, end: u + d.minutes * 60 });
          u += d.minutes * 60;
          act.detailSum += d.minutes;
        });
        hour.activities.push(act);
        t = act.end;
        hour.planned += a.minutes;
      });
      hour.activitiesEnd = t;
      out.push(hour);
      start = hour.end + B;
    });
    // breaks between hours
    for (let i = 0; i + 1 < out.length; i++) out[i].breakAfter = { start: out[i].end, end: out[i + 1].start };
    return out;
  }

  /** What is happening at time `now` (seconds since midnight). */
  function locate(schedule, now) {
    if (!schedule.length) return { phase: "empty" };
    const first = schedule[0], last = schedule[schedule.length - 1];
    const lessonEnd = Math.max(last.end, last.activitiesEnd);
    if (now < first.start) return { phase: "before", until: first.start, next: firstActivity(first), hour: first };
    if (now >= lessonEnd) return { phase: "after", ended: lessonEnd };
    for (let hi = 0; hi < schedule.length; hi++) {
      const h = schedule[hi];
      const hEnd = Math.max(h.end, h.activitiesEnd);
      if (now >= h.start && now < hEnd) {
        const ai = h.activities.findIndex(a => now >= a.start && now < a.end);
        if (ai < 0) return { phase: "buffer", hour: h, until: h.end, next: nextAfter(schedule, hi, h.activities.length - 1) };
        const act = h.activities[ai];
        const di = act.details.findIndex(d => now >= d.start && now < d.end && d.start < act.end);
        const detail = di >= 0 ? act.details[di] : null;
        const nextDetail = di >= 0 && act.details[di + 1] && act.details[di + 1].start < act.end ? act.details[di + 1] : null;
        return {
          phase: "activity", hour: h, act, detail,
          wrapUp: !detail && act.details.length > 0 && now >= act.start + act.detailSum * 60,
          next: nextDetail ? { kind: "detail", item: nextDetail } : nextAfter(schedule, hi, ai),
        };
      }
      if (h.breakAfter && now >= hEnd && now < schedule[hi + 1].start) {
        return { phase: "break", hour: h, until: schedule[hi + 1].start, next: firstActivity(schedule[hi + 1]), nextHour: schedule[hi + 1] };
      }
    }
    return { phase: "after", ended: lessonEnd };
  }

  function firstActivity(h) { return h.activities[0] ? { kind: "activity", item: h.activities[0] } : null; }
  function nextAfter(schedule, hi, ai) {
    const h = schedule[hi];
    if (h.activities[ai + 1]) return { kind: "activity", item: h.activities[ai + 1] };
    if (schedule[hi + 1]) return { kind: "break", item: { title: "Break", start: h.end, end: schedule[hi + 1].start, minutes: Math.round((schedule[hi + 1].start - h.end) / 60) } };
    return null;
  }

  // ------------------------------------------------------------ Typst text -> readable HTML

  const SYM = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", kappa: "κ", lambda: "λ",
    mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    "arrow.r.double": "⇒", "arrow.l.double": "⇐", "arrow.r": "→", "arrow.l": "←", "arrow.l.r": "↔", "arrow.t": "↑", "arrow.b": "↓",
    "dot.double": "¨", infinity: "∞", infty: "∞", approx: "≈", "eq.not": "≠", "!=": "≠", "<=": "≤", ">=": "≥", "<<": "≪", ">>": "≫",
    "plus.minus": "±", times: "×", dot: "·", "dot.op": "·", partial: "∂", nabla: "∇", "integral.cont": "∮", integral: "∫", sum: "Σ",
    sqrt: "√", prop: "∝", parallel: "∥", "degree": "°", "quad": " ", "qquad": "  ", "dif": "d", "cal(E)": "ℰ", hbar: "ℏ",
    "sym.checkmark": "✓", checkmark: "✓",
  };
  const symKeys = Object.keys(SYM).sort((a, b) => b.length - a.length);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function mathHtml(m) {
    let s = m.trim();
    s = s.replace(/\\\//g, "/");
    // quoted text inside math
    const quoted = [];
    s = s.replace(/"([^"]*)"/g, (_, t) => { quoted.push(t); return `\u0000${quoted.length - 1}\u0000`; });
    s = s.replace(/cal\(E\)/g, "ℰ").replace(/arrow\((\w)\)/g, "$1⃗").replace(/dot\((\w)\)/g, "$1̇").replace(/hat\((\w)\)/g, "$1̂");
    for (const k of symKeys) {
      const re = new RegExp("(^|[^A-Za-z.])" + k.replace(/[.()!<>=]/g, "\\$&") + "(?![A-Za-z])", "g");
      s = s.replace(re, (_, p) => p + SYM[k]);
    }
    s = esc(s);
    s = s.replace(/_\(([^()]*)\)|_(\u0000\d+\u0000|[A-Za-z0-9ℰα-ωΑ-Ω]+)/g, (_, a, b) => `<sub>${a ?? b}</sub>`);
    s = s.replace(/\^\(([^()]*)\)|\^(-?[A-Za-z0-9]+)/g, (_, a, b) => `<sup>${a ?? b}</sup>`);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<span class="mt">${esc(quoted[n])}</span>`);
    // Typst puts spaces between factors; show them thin, and keep normal spaces around relations
    s = s.trim().replace(/\s+/g, "\u2009").replace(/\u2009?([=≈→⇒≠≤≥±+,]|&lt;|&gt;)\u2009?/g, (m, op) => op === "," ? ", " : ` ${op} `);
    return `<span class="math">${s}</span>`;
  }

  function typstHtml(src) {
    if (!src) return "";
    const parts = String(src).split(/(\$[^$]*\$)/g);
    return parts.map(p => {
      if (p.startsWith("$") && p.endsWith("$") && p.length > 1) return mathHtml(p.slice(1, -1));
      let t = p.replace(/\\\//g, "/").replace(/#sym\.checkmark/g, "✓").replace(/#h\([^)]*\)/g, " ")
               .replace(/#(?:text|emph|strong|underline)\([^)]*\)\[([^\]]*)\]/g, "$1").replace(/#[a-z][\w-]*(?:\([^)]*\))?/gi, "");
      t = esc(t);
      t = t.replace(/\*([^*]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, "$1<i>$2</i>");
      return t;
    }).join("").replace(/[ \t\r\n]+/g, " ").trim();  // keeps the thin spaces inside math
  }

  window.ChronoTeach = { parseFiles, buildSchedule, locate, typstHtml, hmToSec };
})();
