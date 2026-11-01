#!/usr/bin/env node
// Builds the public repo folder from a whitelist, then scans every copied file for anything personal.
// Usage: node scripts/make-public.js [outDir]   (default E:/claude-work/video-studio-public)
// Exits 1 if the scan finds a leak.
const fs = require("fs"), path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.resolve(process.argv[2] || "E:/claude-work/video-studio-public");

// Only these paths are ever copied. Add to this list on purpose, never by glob over the whole repo.
const WHITELIST = [
  ["apps/web", "apps/web"],
  ["public/LICENSE", "LICENSE"],
  ["public/README.md", "README.md"],
  ["public/vercel.json", "vercel.json"],
  ["public/gitignore", ".gitignore"],
  ["public/vercelignore", ".vercelignore"],
  ["scripts/make-public.js", "scripts/make-public.js"],
];
const ALLOWED_EXT = new Set([".html", ".css", ".js", ".json", ".md", ".txt", ".svg", ".png", ".ico", ".webmanifest", "", ".mjs", ".wasm"]);

// Strings that must never appear in the public repo (this script is exempt from its own pattern list).
const FORBIDDEN = [
  [/gsk_[A-Za-z0-9]{10,}/, "Groq key"],
  [/sk-[A-Za-z0-9_-]{20,}/, "API key"],
  [/(api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{12,}["']/i, "hard-coded credential"],
  [/\b[A-Z]:[\\/](?:Users|New folder|ASSETS|claude-work|DOWNLOADS|Claude folder)/i, "local Windows path"],
  [/claude-work/i, "private working folder"],
  [/Fikayo|Omoboriowo|Edify|Pauline Kinyua|Brenda|Mwasi|Irihose|Peter Kibet|Claude Community Kenya/i, "client name"],
  [/Lufga/i, "non-redistributable font"],
  [/overlay\.html|reel_edit\.py|reel-editor/i, "private reel-editor engine"],
  [/monnybethwel@|@gmail\.com/i, "personal email"],
];

function walk(p, acc = []) {
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f), acc);
  else acc.push(p);
  return acc;
}

if (!out.toLowerCase().includes("public")) { console.error("Refusing: output dir name must contain 'public'."); process.exit(1); }
if (fs.existsSync(out)) {
  // Only wipe a folder this script made before, and keep its .git.
  if (!fs.existsSync(path.join(out, ".made-by-make-public"))) { console.error("Refusing: " + out + " exists and was not made by this script."); process.exit(1); }
  for (const f of fs.readdirSync(out)) if (f !== ".git" && f !== ".vercel") fs.rmSync(path.join(out, f), { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, ".made-by-make-public"), "");

const copied = [];
for (const [src, dst] of WHITELIST) {
  const from = path.join(root, src);
  if (!fs.existsSync(from)) { console.error("Missing whitelist entry: " + src); process.exit(1); }
  for (const f of walk(from)) {
    const rel = path.join(dst, path.relative(from, f));
    const to = path.join(out, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
    copied.push([rel.split(path.sep).join("/"), to]);
  }
}

const leaks = [];
for (const [rel, abs] of copied) {
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) { leaks.push(rel + ": file type " + ext + " not allowed"); continue; }
  if (ext === ".png" || ext === ".ico" || ext === ".wasm" || rel.startsWith("apps/web/app/vendor/") || rel === "scripts/make-public.js") continue;
  const text = fs.readFileSync(abs, "utf8");
  for (const [re, why] of FORBIDDEN) {
    const m = text.match(re);
    if (m) leaks.push(rel + ": " + why + " (\"" + m[0].slice(0, 40) + "\")");
  }
}

if (leaks.length) {
  console.error("LEAK SCAN FAILED:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log("OK: " + copied.length + " files copied to " + out + ", leak scan clean.");
