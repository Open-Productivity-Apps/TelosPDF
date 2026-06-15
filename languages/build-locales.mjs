// Build locale override files from the WIRED strings in the app source
// (ported from MyBI's languages pipeline). Scans every i18n t("…")/<T>…</T>
// literal under packages/shell/src (+ the wired Row/SECTIONS/TOOLS props),
// keeps real UI text, then writes:
//   _template.src.json — the authoring skeleton (all keys, empty values)
//   <code>.src.json    — scaffolded per registry language if missing
//   <code>.json        — FLAT runtime file (only non-empty translations)
//   en-US.json         — auto UK→US spelling transform, differing strings only
//   manifest.json      — sha256-12 per runtime file (clients re-download on change)
// Re-run after each wiring pass. Usage: node build-locales.mjs [/path/to/shell/src]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2] || join(new URL(".", import.meta.url).pathname, "../packages/shell/src");
const here = (f) => new URL("./" + f, import.meta.url);

const UK_TO_US = {
  colour:"color",colours:"colors",coloured:"colored",colouring:"coloring",colourful:"colorful",
  centre:"center",centres:"centers",centred:"centered",
  customise:"customize",customised:"customized",organise:"organize",organised:"organized",
  organisation:"organization",optimise:"optimize",optimised:"optimized",
  analyse:"analyze",analysed:"analyzed",behaviour:"behavior",behaviours:"behaviors",
  favourite:"favorite",favourites:"favorites",licence:"license",licences:"licenses",
  grey:"gray",greyscale:"grayscale",cancelled:"canceled",cancelling:"canceling",
  labelled:"labeled",labelling:"labeling",minimise:"minimize",maximise:"maximize",
  recognise:"recognize",synchronise:"synchronize",initialise:"initialize",
  normalise:"normalize",visualise:"visualize",dialogue:"dialog",metre:"meter",litre:"liter",
};
const toUs = (s) => s.replace(/[A-Za-z]+/g, (w) => {
  const us = UK_TO_US[w.toLowerCase()]; if (!us) return w;
  if (w === w.toUpperCase()) return us.toUpperCase();
  if (w[0] === w[0].toUpperCase()) return us[0].toUpperCase() + us.slice(1);
  return us;
});

// Registry languages from the app's i18n registry.
const registrySrc = readFileSync(join(SRC, "i18n/languages.ts"), "utf8");
const CODES = [...registrySrc.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e), s = statSync(p);
    if (s.isDirectory()) { if (e !== "node_modules") walk(p); }
    else if (/\.(tsx?|jsx?)$/.test(e)) files.push(p);
  }
})(SRC);

const S = new Set();
const add = (s) => { if (s) S.add(s.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\")); };
const reDq = /\bt\(\s*"((?:[^"\\]|\\.)*?)"/g, reSq = /\bt\(\s*'((?:[^'\\]|\\.)*?)'/g, reT = /<T>([^<]+)<\/T>/g;
// Wrapper props translated internally (Row in SettingsView).
const WRAP = [["Row", ["title", "description"]]];
const grab = (src, tag, attrs) => {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "g"); let m;
  while ((m = re.exec(src))) {
    for (const at of attrs) {
      const am = new RegExp(`\\b${at}="((?:[^"\\\\]|\\\\.)*?)"`).exec(m[0]);
      if (am) add(am[1]);
    }
  }
};
for (const f of files) {
  const src = readFileSync(f, "utf8"); let m;
  while ((m = reDq.exec(src))) add(m[1]);
  while ((m = reSq.exec(src))) add(m[1]);
  while ((m = reT.exec(src))) add(m[1].trim());
  for (const [tag, attrs] of WRAP) grab(src, tag, attrs);
}
// Label registries rendered through t() at runtime (TOOLS / SECTIONS arrays).
const reLitDq = /"([^"\n\\]*(?:\\.[^"\n\\]*)*)"/g;
for (const rel of ["components/LeftSidebar.tsx", "components/SettingsView.tsx"]) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8"); let m;
  while ((m = reLitDq.exec(src))) add(m[1]);
}

const isUi = (s) => /[A-Za-z]/.test(s) && !s.includes("\n") && !s.includes("/") && !/^[.@\d]/.test(s)
  && !/\dpx\b/.test(s) && s.length > 3 && (/[A-Z]/.test(s) || /\s/.test(s));
const wired = [...S].filter(isUi).sort();
console.log(`wired UI strings: ${wired.length}`);

// en-US — automatic spelling transform.
const enUS = {};
for (const s of wired) { const u = toUs(s); if (u !== s) enUS[s] = u; }
writeFileSync(here("en-US.json"), JSON.stringify(enUS, null, 2) + "\n");

// Authoring template: labels vs sentences by shape.
const cat = (s) => (s.length > 60 || /[.?!]$/.test(s) ? "sentences" : "labels");
const template = { _lang: "", areas: {}, buttons: {}, labels: {}, sentences: {} };
for (const s of wired) template[cat(s)][s] = "";
writeFileSync(here("_template.src.json"), JSON.stringify(template, null, 2) + "\n");

const CATS = ["areas", "buttons", "labels", "sentences"];
const flatten = (o) => { const f = {}; for (const c of CATS) Object.assign(f, (o && o[c]) || {}); return f; };
// Only locales with at least one translation are PUBLISHED (runtime file +
// manifest entry) — the app greys out everything absent from the manifest.
const manifest = { version: 1, locales: {} };
for (const code of CODES) {
  if (code === "en-GB") continue; // the source language IS the app text
  const srcFile = `${code}.src.json`;
  let src = null;
  try { src = JSON.parse(readFileSync(here(srcFile), "utf8")); } catch { /* scaffold below */ }
  if (!src) {
    src = { ...template, _lang: code };
    writeFileSync(here(srcFile), JSON.stringify(src, null, 2) + "\n");
  }
  const flat = code === "en-US" ? { ...enUS } : {};
  for (const [k, v] of Object.entries(flatten(src))) if (v) flat[k] = v;
  const runtime = here(`${code}.json`).pathname;
  if (Object.keys(flat).length === 0) {
    if (existsSync(runtime)) unlinkSync(runtime); // unpublish empty scaffolds
    continue;
  }
  const out = JSON.stringify(flat, null, 2) + "\n";
  writeFileSync(runtime, out);
  manifest.locales[code] = createHash("sha256").update(out).digest("hex").slice(0, 12);
}
writeFileSync(here("manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`locales published: ${Object.keys(manifest.locales).join(", ")}`);
