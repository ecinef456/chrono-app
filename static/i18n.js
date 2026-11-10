// Chrono in English, French, German and Italian.
//
// The page is written in English. static/i18n.json maps each English text to its French, German
// and Italian versions: {"English": ["français", "Deutsch", "italiano"]}. A key may hold
// placeholders, {a} {b} ..., for the parts that change (numbers, dates, names):
//   "Week {a} of the semester, started {b}": ["Semaine {a} du semestre, commencée le {b}", ...]
// The translator rewrites every text node and the placeholder / title / aria-label attributes,
// including everything Alpine and the charts draw later (a MutationObserver), so the markup and
// most of the code stay in plain English. A value filled into a placeholder is translated too
// when it is itself an exact key.
"use strict";

// next to this file, wherever the page is served from (the app, or the phone page on GitHub Pages)
const I18N_JSON = new URL("i18n.json?v=2", document.currentScript.src).href;
const LANGS = { en: "English", fr: "Français", de: "Deutsch", it: "Italiano" };
const LANG_INDEX = { fr: 0, de: 1, it: 2 };

const I18N = {
  lang: "en",
  exact: new Map(),        // English -> translation
  patterns: [],            // [{ re, out, lit }]
  cache: new Map(),
  original: new WeakMap(), // node -> English text it showed
  attrOriginal: new WeakMap(),
  observer: null,
  ready: null,

  pick() {
    let l = null;
    try { l = localStorage.getItem("chrono-lang"); } catch { /* storage off */ }
    if (!l || !LANGS[l]) {
      const nav = (navigator.languages || [navigator.language || "en"]).map(x => x.slice(0, 2).toLowerCase());
      l = nav.find(x => LANGS[x]) || "en";
    }
    return l;
  },

  async load(lang) {
    this.lang = lang;
    document.documentElement.lang = lang;
    this.exact.clear(); this.patterns = []; this.cache.clear();
    if (lang !== "en") {
      const dict = await (await fetch(I18N_JSON)).json();
      const i = LANG_INDEX[lang];
      for (const [en, tr] of Object.entries(dict)) {
        if (en.startsWith("//") || !tr || !tr[i]) continue;
        if (/\{[a-z]\}/.test(en)) {
          // "{a} entries, {b} studied" -> /^(.+?) entries, (.+?) studied$/
          const names = [];
          const re = new RegExp("^" + en.split(/(\{[a-z]\})/).map(part => {
            const m = part.match(/^\{([a-z])\}$/);
            if (m) { names.push(m[1]); return "([\\s\\S]*?)"; }
            return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          }).join("") + "$");
          this.patterns.push({ re, names, out: tr[i], lit: en.replace(/\{[a-z]\}/g, "").length });
        } else {
          this.exact.set(en, tr[i]);
        }
      }
      this.patterns.sort((a, b) => b.lit - a.lit);   // the most specific pattern wins
    }
    this.translateTree(document.body);
    this.observe();
  },

  // Translate one string (trimmed); null when there's nothing to translate.
  tr(s) {
    if (this.lang === "en" || !s) return null;
    const hit = this.cache.get(s);
    if (hit !== undefined) return hit;
    let out = this.exact.get(s) ?? null;
    if (out === null && /[A-Za-z]/.test(s)) {
      for (const p of this.patterns) {
        const m = s.match(p.re);
        if (!m) continue;
        const vals = {};
        p.names.forEach((n, k) => { const v = m[k + 1]; vals[n] = this.exact.get(v.trim()) ?? v; });
        out = p.out.replace(/\{([a-z])\}/g, (_, n) => vals[n] ?? "");
        break;
      }
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(s, out);
    return out;
  },

  // For code that builds text itself (e.g. the window title): returns the string translated or as is.
  t(s) { return this.tr(s) ?? s; },

  textNode(n) {
    const cur = n.nodeValue;
    const prev = this.original.get(n);
    // Our own last write: keep. Otherwise the node shows new English text.
    if (prev && prev.out === cur) return;
    const trimmed = cur.trim();
    if (!trimmed) return;
    const out = this.tr(trimmed);
    if (out === null) { this.original.delete(n); return; }
    const value = cur.replace(trimmed, out);
    this.original.set(n, { en: cur, out: value });
    n.nodeValue = value;
  },

  attrs(el) {
    let saved = this.attrOriginal.get(el);
    for (const a of ["placeholder", "title", "aria-label"]) {
      const cur = el.getAttribute(a);
      if (!cur) continue;
      if (saved?.[a]?.out === cur) continue;
      const out = this.tr(cur.trim());
      if (out === null) continue;
      if (!saved) { saved = {}; this.attrOriginal.set(el, saved); }
      saved[a] = { en: cur, out };
      el.setAttribute(a, out);
    }
  },

  // Text inside these is never translated (user text, code). Attributes of a textarea are.
  skip(el) { return el.closest?.("script,style,textarea,code,pre,[translate=no]"); },
  skipAttrs(el) { return el.closest?.("script,style,code,pre,[translate=no]"); },

  translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!this.skip(root.parentElement)) this.textNode(root); return; }
    if (root.nodeType !== 1 || this.skipAttrs(root)) return;
    this.attrs(root);
    if (root.matches("textarea")) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        if (n.matches("script,style,code,pre,[translate=no]")) return NodeFilter.FILTER_REJECT;
        if (n.matches("textarea")) { this.attrs(n); return NodeFilter.FILTER_REJECT; }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) this.textNode(n); else this.attrs(n);
    }
  },

  // Back to the English the page showed (when switching language).
  restoreTree(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) { const o = this.original.get(n); if (o && o.out === n.nodeValue) n.nodeValue = o.en; this.original.delete(n); }
      else { const s = this.attrOriginal.get(n); if (s) for (const [a, o] of Object.entries(s)) if (n.getAttribute(a) === o.out) n.setAttribute(a, o.en); this.attrOriginal.delete(n); }
    }
  },

  observe() {
    if (this.observer) this.observer.disconnect();
    if (this.lang === "en") return;
    this.observer = new MutationObserver(list => {
      for (const m of list) {
        if (m.type === "characterData") { if (!this.skip(m.target.parentElement)) this.textNode(m.target); }
        else if (m.type === "attributes") { if (!this.skipAttrs(m.target)) this.attrs(m.target); }
        else m.addedNodes.forEach(n => this.translateTree(n));
      }
    });
    this.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "title", "aria-label"] });
  },

  async set(lang) {
    try { localStorage.setItem("chrono-lang", lang); } catch { /* storage off */ }
    if (this.observer) this.observer.disconnect();
    this.restoreTree(document.body);
    await this.load(lang);
  },

  locale() { return { en: "en-GB", fr: "fr-CH", de: "de-CH", it: "it-CH" }[this.lang] || "en-GB"; },
};

// Deferred script: the page is parsed, so start right away; the app waits for it before showing.
I18N.ready = I18N.load(I18N.pick()).catch(() => {});
window.I18N = I18N; window.LANGS = LANGS;
