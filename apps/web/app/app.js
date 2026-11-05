import { drawProject, loadFonts } from "./engine.js";
import * as ops from "./ops.js";
import * as store from "./store.js";
import * as ai from "./ai.js";
import { exportProject } from "./export.js";
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from "./vendor/mediabunny.min.mjs";

const M = globalThis.SAModel;
const $ = (id) => document.getElementById(id);
const S = { P: null, files: new Map(), urls: new Map(), words: new Map(), pid: "", name: "", sel: null, t: 0, playing: false, pps: 24, tab: "media", pending: null, pendingStyle: null };
const hist = ops.makeHistory();
const cv = $("cv"), g = cv.getContext("2d");
const els = new Map();                                         // clip id -> <video> that plays that clip's source
let tBase = 0, wall0 = 0, liveBase = null, saveTimer = 0, busy = false;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); };
const fmt0 = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ":" + String(s).padStart(2, "0"); };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const total = () => (S.P ? M.duration(S.P) : 0);
const snap = () => JSON.stringify(S.P);
const showOnly = (el, on) => { el.hidden = !on; };

if (!("VideoEncoder" in window) || !("AudioEncoder" in window)) $("support").hidden = false;
loadFonts();

// ---------- state changes ----------
// edit(fn): run fn on the project; if it returns false the change is dropped; otherwise it is one undo step.
function edit(fn) {
  const before = snap(); let r;
  try { r = fn(S.P); } catch (e) { S.P = JSON.parse(before); throw e; }
  if (r === false || r === null) { S.P = JSON.parse(before); return false; }
  if (snap() !== before) hist.push(before);
  changed(); return r === undefined ? true : r;
}
function changed() {
  if (S.sel) {
    const ok = S.sel.kind === "page" ? (S.P.pages || []).some((p) => p.id === S.sel.id) : !!M.find(S.P, S.sel.id);
    if (!ok) S.sel = null;
  }
  const ids = new Set(M.allClips(S.P).map((x) => x.clip.id));
  for (const [id, e] of els) if (!ids.has(id)) { e.pause(); e.removeAttribute("src"); e.load(); els.delete(id); }
  S.t = clamp(S.t, 0, Math.max(0, total()));
  scheduleSave(); renderAll();
}
function undo() { const b = hist.undo(snap()); if (b) { S.P = JSON.parse(b); changed(); } }
function redo() { const b = hist.redo(snap()); if (b) { S.P = JSON.parse(b); changed(); } }
function scheduleSave() {
  clearTimeout(saveTimer); $("save").textContent = "Saving...";
  saveTimer = setTimeout(async () => {
    try { await store.saveProject(S.pid, S.name, S.P, Object.fromEntries(S.words)); $("save").textContent = "Saved"; }
    catch (e) { $("save").textContent = "Could not save in this browser"; console.warn(e); }
  }, 500);
}

// ---------- media and preview ----------
function getEl(clip) {
  let e = els.get(clip.id);
  if (!e) { e = document.createElement("video"); e.playsInline = true; e.preload = "auto"; e.src = S.urls.get(clip.mediaId); els.set(clip.id, e); }
  return e;
}
const frameOf = (clip) => { const e = getEl(clip); return e.readyState >= 1 && e.videoWidth ? { img: e, w: e.videoWidth, h: e.videoHeight } : null; };
function syncMedia() {
  const vis = new Set();
  for (const { clip } of M.visibleAt(S.P, S.t)) {
    if (clip.kind !== "video") continue;
    vis.add(clip.id); const e = getEl(clip), want = clip.in + (S.t - clip.start);
    e.volume = clamp(clip.volume == null ? 1 : clip.volume, 0, 1); e.muted = false;
    if (S.playing) {
      if (e.paused) { if (Math.abs(e.currentTime - want) > 0.08) e.currentTime = want; e.play().catch(() => {}); }
      else if (Math.abs(e.currentTime - want) > 0.3) e.currentTime = want;
    } else { if (!e.paused) e.pause(); if (Math.abs(e.currentTime - want) > 0.04) e.currentTime = want; }
  }
  for (const { clip } of M.allClips(S.P)) {                      // warm up what comes next so a cut does not stall
    if (clip.kind !== "video" || vis.has(clip.id)) continue;
    const e = els.get(clip.id) || (clip.start > S.t && clip.start - S.t < 1.5 ? getEl(clip) : null); if (!e) continue;
    if (!e.paused) e.pause();
    if (S.playing && clip.start > S.t && clip.start - S.t < 1.5 && Math.abs(e.currentTime - clip.in) > 0.05) e.currentTime = clip.in;
  }
}
// Fit the canvas to the preview box, keeping the project's aspect ratio.
function layoutFrame() {
  if (!S.P) return;
  const { w, h } = S.P.canvas, box = $("framewrap").getBoundingClientRect();
  const maxW = Math.max(60, box.width - 4), maxH = Math.max(60, box.height - 4);
  let fw = maxW, fh = (fw * h) / w; if (fh > maxH) { fh = maxH; fw = (fh * w) / h; }
  const f = $("frame"); f.style.width = Math.floor(fw) + "px"; f.style.height = Math.floor(fh) + "px";
  const W = 540, H = Math.round((540 * h) / w / 2) * 2;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
}
new ResizeObserver(() => layoutFrame()).observe(document.body);
function render() { if (S.P) { layoutFrame(); drawProject(g, S.P, S.t, cv.width, cv.height, { frame: frameOf }); } }
function setTime(x) { S.t = clamp(x, 0, total()); tBase = S.t; wall0 = performance.now(); }
function play() {
  if (!total()) return;
  if (S.t >= total() - 0.05) S.t = 0;
  S.playing = true; tBase = S.t; wall0 = performance.now(); $("play").textContent = "Pause";
}
function pause() { S.playing = false; $("play").textContent = "Play"; for (const e of els.values()) e.pause(); }
function loop(now) {
  requestAnimationFrame(loop);
  if (!S.P || $("editor").hidden) return;
  if (S.playing) { S.t = tBase + (now - wall0) / 1000; if (S.t >= total()) { S.t = total(); pause(); } }
  syncMedia(); render(); updateHead();
}
requestAnimationFrame(loop);

async function probe(file) {
  const url = URL.createObjectURL(file), v = document.createElement("video"); v.preload = "metadata"; v.muted = true;
  const info = await new Promise((res, rej) => { v.onloadedmetadata = () => res({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); v.onerror = () => rej(new Error("This video can't be played by your browser. Try an MP4 (H.264).")); v.src = url; });
  let hasAudio = true;
  try { const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS }); hasAudio = !!(await input.getPrimaryAudioTrack()); } catch { /* keep the guess */ }
  return { url, hasAudio, ...info };
}
// first: start a new project (the aspect ratio and style chosen on the start screen); otherwise add a clip at the end.
async function importFile(file, first) {
  if (!file || !file.type.startsWith("video/")) { alert("Please choose a video file."); return false; }
  let info; try { info = await probe(file); } catch (e) { alert(e.message); return false; }
  const id = "m" + Date.now().toString(36);
  S.files.set(id, file); S.urls.set(id, info.url);
  if (first) {
    S.P = ops.newReel(S.aspect || "9:16"); if (S.pendingStyle) S.P.capStyle = S.pendingStyle;
    S.pid = "p" + Date.now().toString(36); S.name = file.name.replace(/\.[^.]+$/, ""); S.words.clear(); hist.clear(); S.sel = null; S.t = 0;
  } else hist.push(snap());
  ops.addVideo(S.P, { id, name: file.name, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio });
  try { await store.saveMedia(S.pid, id, file, file.name); } catch (e) { $("save").textContent = "Video too large to keep in this browser; it will not survive a refresh."; }
  showEditor(true); changed();
  return true;
}
function showEditor(on) {
  $("start").hidden = on; $("editor").hidden = !on;
  if (on) { fillCapStyles(); setTab(S.tab); layoutFrame(); }
}
$("file").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (await importFile(f, true)) afterFirstImport(); });
$("addfile").addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; for (const f of files) await importFile(f, !S.P); if (S.P && $("applyAfter").checked && files.length) $("autopilot").click(); });
// Drop a video anywhere on the start page, or on the import area in the editor.
["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return; e.preventDefault(); $("mediadrop").classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); $("mediadrop").classList.remove("over"); }));
document.addEventListener("drop", async (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return;
  if (!S.P) { if (await importFile(f, true)) afterFirstImport(); } else { await importFile(f, false); }
});
function afterFirstImport() {
  const p = S.pending; S.pending = null;
  if (p) runTool(p);
}

// ---------- tabs, tree, layout ----------
function setTab(name) {
  S.tab = name;
  document.querySelectorAll(".tab").forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  const tree = $("tree"), panel = document.querySelector(`[data-panel="${name}"]`);
  tree.innerHTML = [...panel.querySelectorAll(".sec")].map((s) => `<a href="#${s.id}" data-sec="${s.id}">${esc(s.querySelector("h3").textContent)}</a>`).join("");
  tree.querySelector("a")?.classList.add("on");
  panel.scrollTop = 0;
}
$("tree").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-sec]"); if (!a) return; e.preventDefault();
  document.getElementById(a.dataset.sec).scrollIntoView({ block: "start", behavior: "smooth" });
  $("tree").querySelectorAll("a").forEach((x) => x.classList.toggle("on", x === a));
});
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });
document.querySelectorAll("[data-open-export]").forEach((b) => b.addEventListener("click", () => openExport()));
$("exportOpen").addEventListener("click", () => openExport());
$("exClose").addEventListener("click", () => closeExport());
function openExport() { if (!S.P) return; pause(); $("exportDlg").hidden = false; }
function closeExport() { if (!busy) $("exportDlg").hidden = true; }
// Runs one Tools entry: opens the Autopilot or Captions tab and presses its button.
const TOOL_BTN = { autopilot: "autopilot", cleanup: "cleanup", captions: "autocap", shorts: "shorts", silences: "autocut" };
const TOOL_TAB = { autopilot: "autopilot", cleanup: "autopilot", captions: "captions", shorts: "autopilot", silences: "autopilot" };
function runTool(name) { if (!S.P) return; setTab(TOOL_TAB[name]); $(TOOL_BTN[name]).click(); }
document.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => { const n = b.dataset.run; if (S.P) runTool(n); else { S.pending = n; $("file").click(); } }));
document.querySelectorAll("details.menu").forEach((d) => d.addEventListener("click", (e) => { if (e.target.closest(".mi")) d.open = false; }));

// ---------- timeline (fixed track rows) ----------
const xOf = (t) => t * S.pps;
function itemLabel(c) {
  if (c.kind === "video") { const m = M.mediaOf(S.P, c); return m ? m.name : "clip"; }
  if (c.cap) return c.text; if (c.headline) return "Headline: " + c.text; return c.text || c.kind;
}
const ROWS = [
  { key: "text", label: "Text", cls: "k-text" },
  { key: "pages", label: "Pages", cls: "k-page" },
  { key: "broll", label: "B-roll / PiP", cls: "k-broll" },
  { key: "main", label: "Main", cls: "k-video" },
  { key: "tr", label: "Transitions", cls: "k-tr" },
  { key: "music", label: "Music", cls: "k-audio" },
];
function rowItems() {
  const P = S.P, out = { text: [], pages: [], broll: [], main: [], tr: [], music: [] };
  const vids = P.tracks.filter((t) => t.kind === "video");
  for (const t of P.tracks) for (const c of t.clips) {
    if (t.kind === "text") out.text.push({ kind: "clip", c });
    else if (t.kind === "audio") out.music.push({ kind: "clip", c });
    else if (t.kind === "video") {
      if (t === vids[0]) out.main.push({ kind: "clip", c }); else out.broll.push({ kind: "clip", c });
      if (c.trIn || c.trOut) out.tr.push({ kind: "tr", c: { id: c.id, start: c.start, dur: Math.min(0.6, c.dur), label: (c.trIn ? c.trIn.type : "fade") + (c.trOut ? " out" : "") } });
    }
  }
  for (const p of P.pages || []) out.pages.push({ kind: "page", c: Object.assign({ dur: p.end - p.start }, p) });
  return out;
}
function renderTimeline() {
  const P = S.P, W = Math.max(total() + 6, 20) * S.pps; $("tlin").style.width = W + "px";
  let step = 1; for (const s of [1, 2, 5, 10, 15, 30, 60]) { step = s; if (s * S.pps >= 56) break; }
  let r = ""; for (let t = 0; t <= W / S.pps; t += step) r += `<span style="left:${xOf(t)}px">${fmt0(t)}</span>`;
  $("ruler").innerHTML = r;
  const items = rowItems();
  $("tracks").innerHTML = ROWS.map((row) => {
    const list = items[row.key];
    const hint = !list.length ? `<span class="hint-empty">${row.key === "main" ? "Main media track: add a video" : row.key === "broll" ? "Picture in picture / B-roll track" : row.key === "music" ? "Music track (desktop app)" : row.key === "text" ? "Captions and text appear here" : row.key === "pages" ? "Pages appear here" : "Transitions appear here"}</span>` : "";
    const blocks = list.map(({ kind, c }) => {
      const sel = S.sel && S.sel.id === c.id ? " sel" : "", tr = kind === "clip" && (c.trIn || c.trOut) ? " tr" : "", z = kind === "clip" && c.zoom ? " zm" : "";
      if (kind === "tr") return `<div class="trmark" style="left:${xOf(c.start)}px;width:${Math.max(4, xOf(c.dur))}px" title="${esc(c.label)}">${esc(c.label)}</div>`;
      const label = kind === "page" ? (c.closing ? "Closing page" : (c.text || "Page").replace(/\*/g, "")) : itemLabel(c);
      return `<div class="clip${sel}${tr}${z}${kind === "page" ? " page" : ""}" data-kind="${kind}" data-id="${c.id}" style="left:${xOf(c.start)}px;width:${Math.max(4, xOf(c.dur))}px" title="${esc(label)}"><i class="h l" data-edge="l"></i><span>${esc(label)}</span><i class="h r" data-edge="r"></i></div>`;
    }).join("");
    return `<div class="trk ${row.cls}" data-row="${row.key}"><b class="tname">${row.label}</b>${hint}${blocks}</div>`;
  }).join("");
  updateHead();
}
function updateHead() {
  $("tlhead").style.left = xOf(S.t) + "px"; $("clock").textContent = fmt(S.t) + " / " + fmt(total());
  $("dur").textContent = fmt(total());
  const sc = $("scrub"); if (document.activeElement !== sc) sc.value = total() ? String(Math.round((S.t / total()) * 1000)) : "0";
  if (S.playing) { const box = $("tl"), x = xOf(S.t); if (x > box.scrollLeft + box.clientWidth - 40 || x < box.scrollLeft) box.scrollLeft = Math.max(0, x - 60); }
}
$("tlzoom").addEventListener("input", (e) => { S.pps = +e.target.value; renderTimeline(); });
$("fit").addEventListener("click", () => { const box = $("tl"); const d = Math.max(total(), 1); S.pps = clamp(Math.floor((box.clientWidth - 20) / d), 4, 120); $("tlzoom").value = S.pps; renderTimeline(); });
$("scrub").addEventListener("input", (e) => { pause(); setTime((+e.target.value / 1000) * total()); });

// pointer: scrub on the ruler / empty space, move a clip, or trim an edge
let drag = null;
function snapTime(t, skipId) {
  const pts = [0, S.t]; for (const { clip } of M.allClips(S.P)) { if (clip.id === skipId) continue; pts.push(clip.start, M.end(clip)); }
  for (const p of S.P.pages || []) if (p.id !== skipId) pts.push(p.start, p.end);
  let best = t, d = 7 / S.pps; for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; } return best;
}
const timeAt = (ev) => { const r = $("tlin").getBoundingClientRect(); return clamp((ev.clientX - r.left) / S.pps, 0, 1e5); };
$("tlin").addEventListener("pointerdown", (ev) => {
  const el = ev.target.closest(".clip");
  if (!el) { drag = { mode: "scrub" }; setTime(timeAt(ev)); $("tlin").setPointerCapture(ev.pointerId); return; }
  const kind = el.dataset.kind, id = el.dataset.id; S.sel = { kind, id };
  const item = kind === "page" ? S.P.pages.find((p) => p.id === id) : M.find(S.P, id).clip;
  const start = item.start, len = kind === "page" ? item.end - item.start : item.dur;
  drag = { mode: ev.target.dataset.edge ? "trim" : "move", edge: ev.target.dataset.edge, kind, id, x0: ev.clientX, start, len, base: snap(), moved: false };
  $("tlin").setPointerCapture(ev.pointerId); renderTimeline(); renderInspector();
});
$("tlin").addEventListener("pointermove", (ev) => {
  if (!drag) return;
  if (drag.mode === "scrub") { setTime(timeAt(ev)); return; }
  const dt = (ev.clientX - drag.x0) / S.pps; if (Math.abs(ev.clientX - drag.x0) < 3 && !drag.moved) return; drag.moved = true;
  const p2 = JSON.parse(drag.base); let ok = false;
  if (drag.kind === "page") {
    const pg = p2.pages.find((p) => p.id === drag.id);
    if (drag.mode === "move") { const ns = Math.max(0, snapTime(drag.start + dt, drag.id)); pg.start = Math.round(ns * 1000) / 1000; pg.end = Math.round((ns + drag.len) * 1000) / 1000; ok = true; }
    else if (drag.edge === "l") { pg.start = Math.round(clamp(snapTime(drag.start + dt, drag.id), 0, pg.end - 0.5) * 1000) / 1000; ok = true; }
    else { pg.end = Math.round(Math.max(pg.start + 0.5, snapTime(drag.start + drag.len + dt, drag.id)) * 1000) / 1000; ok = true; }
  } else if (drag.mode === "move") ok = M.moveClip(p2, drag.id, snapTime(drag.start + dt, drag.id));
  else if (drag.edge === "l") ok = M.trimClip(p2, drag.id, "l", snapTime(drag.start + dt, drag.id));
  else ok = M.trimClip(p2, drag.id, "r", snapTime(drag.start + drag.len + dt, drag.id));
  if (ok) { S.P = p2; renderTimeline(); }
});
const endDrag = () => {
  if (!drag) return; const d = drag; drag = null;
  if (d.mode !== "scrub" && snap() !== d.base) { hist.push(d.base); changed(); } else renderInspector();
};
$("tlin").addEventListener("pointerup", endDrag); $("tlin").addEventListener("pointercancel", endDrag);

// ---------- transport and tools ----------
$("play").addEventListener("click", () => (S.playing ? pause() : play()));
$("stop").addEventListener("click", () => { pause(); setTime(0); });
$("prev").addEventListener("click", () => { pause(); setTime(0); });
$("undo").addEventListener("click", undo); $("redo").addEventListener("click", redo);
function selectedClip() { return S.sel && S.sel.kind === "clip" ? M.find(S.P, S.sel.id) : null; }
function doSplit() {
  let c = selectedClip(); const t = S.t;
  if (!c || t <= c.clip.start || t >= M.end(c.clip)) { const hit = ops.clipAt(S.P, t); c = hit ? M.find(S.P, hit.id) : null; }
  if (!c) return setMsg("Move the playhead over a clip first.");
  const r = edit((P) => !!ops.splitAt(P, c.clip.id, t)); if (!r) setMsg("Too close to the edge of the clip to split here.");
}
function doDelete(ripple) {
  if (!S.sel) return setMsg("Click a clip first.");
  if (S.sel.kind === "page") { edit((P) => ops.removePage(P, S.sel.id)); return; }
  const id = S.sel.id, f = M.find(S.P, id);
  if (f && f.clip.cap) ripple = false;
  edit((P) => M.deleteClip(P, id, ripple && f && f.clip.kind === "video"));
}
$("split").addEventListener("click", doSplit); $("del").addEventListener("click", () => doDelete(true)); $("delgap").addEventListener("click", () => doDelete(false));
$("addtext").addEventListener("click", addTextHere); $("addtext2").addEventListener("click", addTextHere);
function addTextHere() {
  if (!S.P) return; const t = S.t;
  edit((P) => { const c = M.addText(P, t, 2.5, "Your text"); c.size = 64; c.font = "Montserrat"; c.fw = 700; S.sel = { kind: "clip", id: c.id }; });
}
function setMsg(m) { $("save").textContent = m; }
document.addEventListener("keydown", (e) => {
  if (!S.P || $("editor").hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === "Escape" && !$("exportDlg").hidden) { closeExport(); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  else if (k === "s" && !e.ctrlKey) doSplit();
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); doDelete(!e.shiftKey); }
  else if (e.key === "ArrowLeft") { pause(); setTime(S.t - (e.shiftKey ? 1 : 1 / 30)); }
  else if (e.key === "ArrowRight") { pause(); setTime(S.t + (e.shiftKey ? 1 : 1 / 30)); }
});

// ---------- inspector (slim bar above the timeline: properties of the selected clip or page) ----------
const num = (k, label, v, a, b, step) => `<label class="fld">${label}<input type="number" data-k="${k}" value="${v}" min="${a}" max="${b}" step="${step}"></label>`;
const rng = (k, label, v, a, b, step) => `<label class="fld">${label}<input type="range" data-k="${k}" value="${v}" min="${a}" max="${b}" step="${step}"></label>`;
const sel = (k, label, v, opts) => `<label class="fld">${label}<select data-k="${k}">${opts.map(([o, l]) => `<option value="${o}"${String(v) === String(o) ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
const txt = (k, label, v) => `<label class="fld">${label}<input data-k="${k}" value="${esc(v)}"></label>`;
function renderInspector() {
  const box = $("inspector");
  if (!S.sel) { box.innerHTML = `<span class="small">Click a clip to change its properties here.</span>`; box.classList.remove("on"); return; }
  box.classList.add("on");
  if (S.sel.kind === "page") {
    const p = S.P.pages.find((x) => x.id === S.sel.id); if (!p) { box.innerHTML = ""; return; }
    const m = p.motion || {};
    box.innerHTML = `<b class="ihead">Page</b><div class="ifields">${num("pstart", "Starts (s)", p.start.toFixed(2), 0, 9999, 0.1)}${num("pend", "Ends (s)", p.end.toFixed(2), 0.5, 9999, 0.1)}
      ${p.closing ? txt("closing", "Closing line", p.closing.text) : txt("ptitle", "Title (*stars* highlight)", p.text)}
      ${m.type === "quote" ? txt("pquote", "Quote", m.quote) : ""}${m.type === "counter" ? `${num("pvalue", "Number", m.value || 0, 0, 1e12, 1)}${txt("pcaption", "Under the number", m.caption || "")}` : ""}
      ${sel("pstyle", "Background", p.style, [["dark", "Dark"], ["light", "Light"]])}<label class="chk"><input type="checkbox" data-k="ppip"${p.pip !== false ? " checked" : ""}> Rounded window</label>
      <button class="btn sm" data-act="delpage">Delete page</button></div>`;
    return;
  }
  const f = M.find(S.P, S.sel.id); if (!f) { box.innerHTML = ""; return; }
  const c = f.clip;
  if (c.kind === "text") {
    box.innerHTML = `<b class="ihead">${c.cap ? "Caption" : c.headline ? "Headline" : "Text"}</b><div class="ifields">${txt("text", "Text", c.text)}${num("start", "Starts (s)", c.start.toFixed(2), 0, 9999, 0.1)}${num("dur", "Length (s)", c.dur.toFixed(2), 0.1, 9999, 0.1)}
      ${c.cap ? "" : `${num("size", "Size", c.size || 72, 20, 200, 2)}${rng("ty", "Height", c.y == null ? 0.8 : c.y, 0.05, 0.95, 0.01)}<label class="fld">Colour <input type="color" data-k="color" value="${c.color || "#ffffff"}"></label>`}
      <button class="btn sm" data-act="delclip">Delete</button></div>`;
    return;
  }
  const z = c.zoom || { from: 1, to: 1, fy: 0.4, ease: "inout" }, g2 = c.grade || { contrast: 1, saturation: 1, brightness: 0 };
  const idx = f.track.clips.indexOf(c);
  box.innerHTML = `<b class="ihead">Clip ${idx + 1} of ${f.track.clips.length}</b><div class="ifields">${num("start", "Starts (s)", c.start.toFixed(2), 0, 9999, 0.1)}${num("dur", "Length (s)", c.dur.toFixed(2), 0.1, 9999, 0.1)}
    ${rng("volume", "Volume", c.volume == null ? 1 : c.volume, 0, 1, 0.05)}${sel("fit", "Fit", c.fit || "cover", [["cover", "Fill"], ["contain", "Fit inside"]])}
    ${sel("trin", "Start", c.trIn ? c.trIn.type : "none", [["none", "Hard cut"], ["fade", "Fade in"], ["slideleft", "Slide from right"], ["slideright", "Slide from left"], ["crossfade", "Crossfade"]])}
    <label class="chk"><input type="checkbox" data-k="trout"${c.trOut ? " checked" : ""}> Fade out</label>
    ${rng("zfrom", "Zoom start", z.from, 1, 2, 0.01)}${rng("zto", "Zoom end", z.to, 1, 2, 0.01)}${rng("zfy", "Focus height", z.fy == null ? 0.4 : z.fy, 0, 1, 0.01)}
    ${sel("zease", "Zoom motion", z.ease || "inout", [["inout", "Smooth"], ["out", "Fast then slow"], ["in", "Slow then fast"], ["linear", "Steady"]])}
    ${rng("contrast", "Contrast", g2.contrast, 0.6, 1.6, 0.01)}${rng("saturation", "Colour", g2.saturation, 0, 2, 0.01)}
    <button class="btn sm" data-act="split">Split</button><button class="btn sm" data-act="earlier">Earlier</button><button class="btn sm" data-act="later">Later</button><button class="btn sm" data-act="delclip">Delete</button></div>`;
}
// Apply one field. Called on every input (live) and the history entry is added once on change.
function applyProp(k, raw, el) {
  const P = S.P, sid = S.sel && S.sel.id; if (!sid) return;
  if (S.sel.kind === "page") {
    const p = P.pages.find((x) => x.id === sid); if (!p) return; p.motion = p.motion || {};
    if (k === "pstart") p.start = Math.max(0, +raw || 0); else if (k === "pend") p.end = Math.max(p.start + 0.5, +raw || 0);
    else if (k === "ptitle") p.text = raw; else if (k === "closing") p.closing.text = raw; else if (k === "pquote") p.motion.quote = raw;
    else if (k === "pvalue") p.motion.value = +raw || 0; else if (k === "pcaption") p.motion.caption = raw; else if (k === "pstyle") p.style = raw; else if (k === "ppip") p.pip = el.checked;
    P.pages.sort((a, b) => a.start - b.start); return;
  }
  const f = M.find(P, sid); if (!f) return; const c = f.clip;
  const q = (n) => +document.querySelector(`#inspector [data-k="${n}"]`).value;
  const zoom = () => M.setZoom(P, sid, q("zfrom"), q("zto"), { ease: document.querySelector('#inspector [data-k="zease"]').value, fx: 0.5, fy: q("zfy") });
  switch (k) {
    case "text": if (c.cap) ops.setCaptionText(P, sid, raw || " "); else c.text = raw; break;
    case "start": M.moveClip(P, sid, +raw || 0); break;
    case "dur": M.trimClip(P, sid, "r", c.start + (+raw || 0.1)); break;
    case "size": c.size = +raw || 72; break; case "ty": c.y = +raw; break; case "color": c.color = raw; break;
    case "volume": c.volume = +raw; break; case "fit": c.fit = raw; break;
    case "zfrom": case "zto": case "zfy": case "zease": zoom(); break;
    case "contrast": case "saturation": M.setGrade(P, sid, { contrast: q("contrast"), saturation: q("saturation"), brightness: 0 }); break;
    case "trin": { const type = raw; if (type === "crossfade") ops.setTransition(P, sid, "crossfade", 0.5); else ops.setTransition(P, sid, type, 0.5); break; }
    case "trout": M.setTransition(P, sid, "out", el.checked ? "fade" : "none", 0.5); break;
  }
}
$("inspector").addEventListener("input", (e) => {
  const k = e.target.dataset.k; if (!k) return;
  if (!liveBase) liveBase = snap();
  const out = e.target.closest("label") && e.target.closest("label").querySelector("output"); if (out) out.textContent = e.target.value;
  applyProp(k, e.target.value, e.target); renderTimeline();
});
$("inspector").addEventListener("change", (e) => {
  if (!e.target.dataset.k) return;
  if (!liveBase) liveBase = snap();
  applyProp(e.target.dataset.k, e.target.value, e.target);
  if (snap() !== liveBase) hist.push(liveBase); liveBase = null; changed();
});
$("inspector").addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]"); if (!a) return; const act = a.dataset.act;
  if (act === "delpage" || act === "delclip") doDelete(true); else if (act === "split") doSplit();
  else if (act === "earlier" || act === "later") edit((P) => ops.reorderClip(P, S.sel.id, act === "earlier" ? -1 : 1));
});

// ---------- cleaning, captions, autopilot ----------
function primary() { return S.P.media[0]; }
const onlyOneRecording = () => S.P.media.length <= 1;
async function analyseLevels(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack(); if (!track) return [];
  const sink = new AudioBufferSink(track), win = 0.05, levels = [];
  for await (const { buffer, timestamp } of sink.buffers()) {
    const d = buffer.getChannelData(0), n = Math.max(1, Math.floor(buffer.sampleRate * win));
    for (let i = 0; i + n <= d.length; i += n) { let sum = 0; for (let j = i; j < i + n; j++) sum += d[j] * d[j]; levels.push({ t: timestamp + i / buffer.sampleRate, db: 10 * Math.log10(sum / n + 1e-12) }); }
  }
  return levels;
}
async function ensureWords(mediaId, say) {
  if (S.words.has(mediaId)) return S.words.get(mediaId);
  const { transcribe } = await import("./transcribe.js");
  const r = await transcribe(S.files.get(mediaId), say); S.words.set(mediaId, r.words); return r.words;
}
const cleanOpts = () => ({ silences: $("o-sil").checked, fillers: $("o-fill").checked, repeats: $("o-rep").checked, retakes: $("o-ret").checked, extraFillers: $("o-extra").checked });
async function plan(say, opts) {
  const m = primary(), words = await ensureWords(m.id, say);
  say("Finding what to cut...");
  const { planCleanup } = await import("./clean.js");
  const levels = await analyseLevels(S.files.get(m.id));
  return { m, words, res: planCleanup(words, levels, m.duration, opts) };
}
const stats = (res) => { const p = [["filler", res.stats.fillers], ["repeat", res.stats.repeats], ["retake", res.stats.retakes], ["silence", res.stats.silences]].filter((x) => x[1]).map((x) => x[1] + " " + x[0] + (x[1] > 1 ? "s" : "")); return p.length ? "Removed " + p.join(", ") + "." : "Nothing to remove."; };
async function guarded(btn, st, fn) {
  if (busy) return; busy = true; const b = btn; b.disabled = true; pause();
  try { await fn((m) => { st.textContent = m; }); } catch (e) { console.error(e); st.textContent = "That did not work: " + e.message; } finally { busy = false; b.disabled = false; }
}
const oneRecordingMsg = "This works on one recording at a time. Run it first, then add more clips, or remove the extra clips.";

$("cleanup").addEventListener("click", () => guarded($("cleanup"), $("cleaninfo"), async (say) => {
  if (!onlyOneRecording()) return say(oneRecordingMsg);
  const { m, res } = await plan(say, cleanOpts());
  edit((P) => { ops.setSegments(P, m.id, ops.keepFromCuts(m.duration, res.cuts)); P.pages = []; ops.captionsFromSource(P, new Map([[m.id, res.words.filter((w) => !w.why)]]), P.capStyle, m.id); });
  setTime(0); say(`${stats(res)} Saved ${res.stats.seconds} s: ${fmt0(m.duration)} became ${fmt0(total())}. Undo brings it back.`);
}));
$("autocut").addEventListener("click", () => guarded($("autocut"), $("cleaninfo"), async (say) => {
  if (!onlyOneRecording()) return say(oneRecordingMsg);
  const m = primary(); say("Listening...");
  const levels = await analyseLevels(S.files.get(m.id)); if (!levels.length) return say("This video has no audio to analyse.");
  const sorted = levels.map((l) => l.db).sort((x, y) => x - y), loud = sorted[Math.floor(sorted.length * 0.9)], thr = Math.max(-55, loud - 22), fake = []; let s = null;
  for (const l of levels) { if (l.db >= thr) { if (s === null) s = l.t; } else if (s !== null) { fake.push({ t: "x" + fake.length, s, e: l.t }); s = null; } }
  if (s !== null) fake.push({ t: "x" + fake.length, s, e: m.duration });
  const { planCleanup } = await import("./clean.js"), r = planCleanup(fake, [], m.duration, { fillers: false, repeats: false, retakes: false, silences: true });
  if (!r.cuts.length) return say("No long silences found.");
  edit((P) => { ops.setSegments(P, m.id, ops.keepFromCuts(m.duration, r.cuts)); P.pages = []; if (S.words.has(m.id)) ops.captionsFromSource(P, new Map([[m.id, S.words.get(m.id)]]), P.capStyle, m.id); });
  setTime(0); say(`Cut ${r.cuts.length} silent gap${r.cuts.length > 1 ? "s" : ""}. ${fmt0(m.duration)} became ${fmt0(total())}.`);
}));

function fillCapStyles() {
  for (const sel2 of [$("capstyle")]) { if (sel2.options.length) continue; for (const [k, v] of Object.entries(M.STYLES)) sel2.appendChild(new Option(v.label, k)); }
}
$("capstyle").addEventListener("change", (e) => { edit((P) => { ops.restyleCaptions(P, e.target.value); return true; }); capHint(); });
function capHint() { const s = M.STYLES[$("capstyle").value]; $("capdemo").textContent = s ? "Font: " + s.caption.fonts[0][0] + (s.caption.hi ? ". The spoken word is highlighted." : ".") : ""; }
$("autocap").addEventListener("click", () => guarded($("autocap"), $("capstatus"), async (say) => {
  for (const m of S.P.media) await ensureWords(m.id, say);
  edit((P) => { ops.captionsFromSource(P, S.words, $("capstyle").value || P.capStyle); });
  say(`Added ${ops.captionClips(S.P).length} captions. Click one on the timeline to fix a word.`);
}));
$("addcap").addEventListener("click", () => { const c = edit((P) => ops.addCaptionAt(P, S.t, "New caption", 2)); if (c) { const last = ops.captionClips(S.P).find((x) => Math.abs(x.start - S.t) < 0.01); if (last) { S.sel = { kind: "clip", id: last.id }; renderTimeline(); renderInspector(); } } });
$("usescript").addEventListener("click", () => {
  const words = $("script").value.split(/\s+/).filter(Boolean); if (!words.length || !total()) return;
  const per = total() / words.length;
  edit((P) => { ops.captionsFromTimeline(P, words.map((w, i) => ({ w, s: i * per, e: (i + 1) * per - 0.02 })), $("capstyle").value || P.capStyle); });
});

$("autopilot").addEventListener("click", () => guarded($("autopilot"), $("apinfo"), async (say) => {
  if (!onlyOneRecording()) return say(oneRecordingMsg);
  const { m, words, res } = await plan(say, { silences: true, fillers: true, repeats: true, retakes: true, extraFillers: false });
  say("Editing...");
  let rep;
  edit((P) => { rep = ops.autopilot(P, m.id, words, res.cuts, { pages: $("ap-pages").checked, punch: $("ap-punch").checked }); });
  if (ai.loadSettings() && $("ai-key").value) { try { await runAi(say); } catch (e) { say("Autopilot finished; the AI helper said: " + e.message); } }
  $("capstyle").value = rep.style; capHint(); setTime(0);
  say(`Done: ${rep.tone} tone, ${stats(res).replace(/\.$/, "")}, ${rep.captions} captions, ${rep.pages} page${rep.pages === 1 ? "" : "s"}, ${rep.punches} punch-in${rep.punches === 1 ? "" : "s"}${rep.hook ? ", headline “" + rep.hook + "”" : ""}. ${fmt0(m.duration)} became ${fmt0(rep.total)}. Everything can be changed; Undo brings back the original.`);
}));

// ---------- transitions and punch-ins (apply to the selected video clip) ----------
document.querySelectorAll("[data-tr]").forEach((b) => b.addEventListener("click", () => {
  const f = selectedClip(); if (!f || f.clip.kind !== "video") { $("trinfo").textContent = "Select a video clip on the timeline first."; return; }
  const type = b.dataset.tr;
  edit((P) => { if (type === "none") M.setTransition(P, f.clip.id, "in", "none"); else ops.setTransition(P, f.clip.id, type, 0.5); });
  $("trinfo").textContent = "Set on the selected clip. Change the length in the clip bar.";
}));
document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
  const f = selectedClip(); if (!f || f.clip.kind !== "video") { alert("Select a video clip on the timeline first."); return; }
  const z = +b.dataset.zoom; edit((P) => { if (z === 1) M.setZoom(P, f.clip.id, 1, 1); else ops.setPunch(P, f.clip.id, z, { from: 1 }); });
}));

// ---------- headline and pages ----------
$("headline").addEventListener("input", (e) => { if (!liveBase) liveBase = snap(); ops.setHeadline(S.P, e.target.value, { dur: Math.min(4.2, total() || 4) }); renderTimeline(); });
$("headline").addEventListener("change", () => { if (liveBase && snap() !== liveBase) hist.push(liveBase); liveBase = null; changed(); });
function addPageAt(kind) {
  const t = Math.min(S.t, Math.max(0, total() - 1));
  edit((P) => ops.addPage(P, { start: t, end: t + 4, style: (P.pages || []).length % 2 ? "light" : "dark", text: kind === "quote" ? "Your *title*" : "By the *numbers*", motion: kind === "quote" ? { type: "quote", quote: "Type a line from your video here." } : { type: "counter", value: 1000, caption: "what it counts" } }));
  const pg = (S.P.pages || []).find((p) => Math.abs(p.start - t) < 0.01); if (pg) { S.sel = { kind: "page", id: pg.id }; renderTimeline(); renderInspector(); }
}
$("addpage-quote").addEventListener("click", () => addPageAt("quote")); $("addpage-counter").addEventListener("click", () => addPageAt("counter"));
function renderPageList() {
  const l = (S.P && S.P.pages) || [];
  $("pagelist").innerHTML = l.length ? l.map((p, i) => `<div class="pgrow"><button class="linkbtn" data-pg="${p.id}">Page ${i + 1} at ${fmt0(p.start)}: ${esc((p.closing ? p.closing.text : p.text || "").replace(/\*/g, "").slice(0, 28))}</button></div>`).join("") : "No pages yet.";
}
$("pagelist").addEventListener("click", (e) => { const b = e.target.closest("[data-pg]"); if (!b) return; const p = S.P.pages.find((x) => x.id === b.dataset.pg); if (p) { S.sel = { kind: "page", id: p.id }; pause(); setTime(p.start + 0.3); renderTimeline(); renderInspector(); } });

// ---------- media list (add an imported video at the playhead) ----------
function renderMedia() {
  const list = $("medialist"); if (!S.P) { list.innerHTML = ""; return; }
  list.innerHTML = S.P.media.length ? S.P.media.map((m) => `<div class="mediaitem"><div class="thumb" aria-hidden="true"></div><div class="mname" title="${esc(m.name)}">${esc(m.name)}</div><button class="btn sm" data-addmedia="${m.id}">Add at playhead</button></div>`).join("") : `<p class="small">No videos yet. Add one above.</p>`;
}
$("medialist").addEventListener("click", (e) => {
  const b = e.target.closest("[data-addmedia]"); if (!b) return;
  edit((P) => { const c = M.addMediaClip(P, b.dataset.addmedia, S.t); if (c) c.fit = "cover"; return !!c; });
});

// ---------- shorts ----------
$("shorts").addEventListener("click", () => guarded($("shorts"), $("shortlist"), async (say) => {
  if (!onlyOneRecording()) return say(oneRecordingMsg);
  const m = primary(), words = await ensureWords(m.id, say), list = ops.shortsFor(words, { n: 3 });
  if (!list.length) return say("Could not find a good short in this recording. It may be too short.");
  $("shortlist").innerHTML = list.map((s, i) => `<div class="short"><b>${fmt0(s.start)} to ${fmt0(s.end)}</b> (${Math.round(s.end - s.start)} s) <span class="small">${esc(s.title)}...</span><br><button class="btn sm" data-short="${i}">Use this short</button></div>`).join("");
  $("shortlist").onclick = (e) => {
    const b = e.target.closest("[data-short]"); if (!b) return; const s = list[+b.dataset.short];
    edit((P) => { ops.useShort(P, m.id, s.start, s.end); ops.captionsFromSource(P, new Map([[m.id, words]]), P.capStyle, m.id); }); setTime(0);
    $("shortlist").insertAdjacentHTML("afterbegin", `<p class="small">The timeline now holds only that short. Undo brings the full recording back.</p>`);
  };
  say(`Found ${list.length} short${list.length > 1 ? "s" : ""}. Pick one to use it.`);
}));

// ---------- optional AI helper (own key) ----------
function fillAi() {
  const sel2 = $("ai-provider"); for (const [k, v] of Object.entries(ai.PROVIDERS)) sel2.appendChild(new Option(v.label, k));
  const s = ai.loadSettings(); if (s) { sel2.value = s.provider; $("ai-key").value = s.key; $("ai-remember").checked = !!localStorage.getItem("reelloom.ai"); }
}
async function runAi(say) {
  const m = primary(), words = S.words.get(m.id); if (!words) throw new Error("Make captions or run Autopilot first so there is a transcript.");
  const settings = { provider: $("ai-provider").value, key: $("ai-key").value.trim() }; if (!settings.key) throw new Error("Paste your key first.");
  ai.saveSettings(settings, $("ai-remember").checked);
  say("Asking your AI provider (only the transcript is sent)...");
  const plan2 = await ai.askForPlan(settings, ops.captionWordsOnTimeline(S.P).map((w) => w.w).join(" ") || words.map((w) => w.t).join(" "), (S.P.pages || []).length);
  return edit((P) => ops.applyAiPlan(P, plan2));
}
$("ai-run").addEventListener("click", () => guarded($("ai-run"), $("ai-info"), async (say) => { const n = await runAi(say); say(n ? "Done. The hook and page titles were updated. Undo restores the rule-based ones." : "The AI gave nothing to change."); }));
$("ai-forget").addEventListener("click", () => { ai.forget(); $("ai-key").value = ""; $("ai-info").textContent = "Key removed from this browser."; });

// ---------- export (dialog) ----------
let abort = null;
$("export").addEventListener("click", async () => {
  if (!("VideoEncoder" in window)) { $("expstatus").textContent = "This browser can't export. Use Chrome or Edge on a computer."; return; }
  if (busy) return; busy = true; pause(); abort = new AbortController();
  const btn = $("export"), st = $("expstatus"), bar = $("prog"); btn.disabled = true; $("dl").hidden = true; $("result").hidden = true; bar.hidden = false; $("cancelexp").hidden = false;
  try {
    const t0 = performance.now(), opt = { width: +$("size").value, loudness: $("loud").checked, signal: abort.signal, onStatus: (m) => { st.textContent = m; }, onProgress: (p) => { bar.firstElementChild.style.width = Math.round(p * 100) + "%"; } };
    const blob = await exportProject(S.P, S.files, opt);
    const a = $("dl"); a.href = URL.createObjectURL(blob); a.download = (S.name || "reel") + "-reel.mp4"; a.hidden = false;
    const v = $("result"); v.src = a.href; v.hidden = false;
    st.textContent = `Done in ${Math.round((performance.now() - t0) / 1000)} s: ${(blob.size / 1048576).toFixed(1)} MB, ${fmt0(total())}${opt.stats ? ", " + opt.stats.after.toFixed(1) + " LUFS" : ""}. Press Download.`;
  } catch (e) { console.error(e); st.textContent = "Export failed: " + e.message; }
  finally { busy = false; btn.disabled = false; $("cancelexp").hidden = true; abort = null; }
});
$("cancelexp").addEventListener("click", () => abort && abort.abort());

// ---------- start screen: aspect, new, open, library, tiles, templates ----------
S.aspect = "9:16";
$("aspect").addEventListener("change", (e) => { S.aspect = e.target.value; });
$("startNew").addEventListener("click", () => { S.pending = null; $("file").click(); });
$("openlib").addEventListener("click", () => $("library").scrollIntoView({ behavior: "smooth", block: "start" }));
$("openlib2").addEventListener("click", () => { closeMenus(); if (S.P) { backToStart(); } setTimeout(() => $("openlib").click(), 0); });
function closeMenus() { document.querySelectorAll("details.menu").forEach((d) => (d.open = false)); }
$("showStart").checked = localStorage.getItem("reelloom.showStart") !== "0";
$("showStart").addEventListener("change", (e) => localStorage.setItem("reelloom.showStart", e.target.checked ? "1" : "0"));
document.querySelectorAll(".snav-btn").forEach((b) => b.addEventListener("click", () => startPage(b.dataset.spage)));
document.querySelectorAll("[data-spage-link]").forEach((b) => b.addEventListener("click", () => startPage(b.dataset.spageLink)));
function startPage(name) {
  document.querySelectorAll(".snav-btn").forEach((b) => b.classList.toggle("active", b.dataset.spage === name));
  document.querySelectorAll(".spage").forEach((p) => { p.hidden = p.dataset.spage !== name; });
}
document.querySelectorAll("[data-tile]").forEach((b) => b.addEventListener("click", () => { S.pending = b.dataset.tile; $("file").click(); }));
// Templates: a caption style for the next project.
$("styleCards").innerHTML = Object.entries(M.STYLES).map(([k, v]) => `<div class="card"><b>${esc(v.label)}</b><span class="small">Font: ${esc(v.caption.fonts[0][0])}${v.caption.upper ? ", capitals" : ""}</span><button class="btn sm" data-style="${k}">Use this style</button></div>`).join("");
$("styleCards").addEventListener("click", (e) => { const b = e.target.closest("[data-style]"); if (!b) return; S.pendingStyle = b.dataset.style; $("file").click(); });
function backToStart() {
  pause(); for (const e of els.values()) { e.removeAttribute("src"); e.load(); } els.clear(); for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.P = null; S.files.clear(); S.urls.clear(); S.words.clear(); S.sel = null; showEditor(false); renderLibrary();
}
$("backstart").addEventListener("click", () => { closeMenus(); if (confirm("Back to the start screen? Your project stays saved in this browser.")) backToStart(); });
$("newproj").addEventListener("click", () => { closeMenus(); if (confirm("Start a new project? The current one stays saved in this browser.")) { backToStart(); S.pending = null; $("file").click(); } });
$("reflib").addEventListener("click", () => renderLibrary());

async function renderLibrary() {
  const box = $("library");
  let list = []; try { list = await store.allProjects(); } catch { box.innerHTML = `<p class="small">Projects cannot be listed in this browser.</p>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty"><div class="empty-art" aria-hidden="true"></div><p>Your projects appear here.</p></div>`; return; }
  box.innerHTML = list.map((r) => `<div class="pcard"><button class="pcard-open" data-open="${esc(r.id)}"><div class="pthumb" aria-hidden="true"></div><b>${esc(r.name || "Untitled")}</b><span class="small">${new Date(r.updated).toLocaleString()} · ${fmt0(r.dur || 0)}</span></button><button class="linkbtn small" data-del="${esc(r.id)}">Delete</button></div>`).join("");
}
$("library").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]"), d = e.target.closest("[data-del]");
  if (o) { const rec = await store.getProject(o.dataset.open); if (rec) resume(rec); }
  if (d && confirm("Delete this project and its video from this browser? This cannot be undone.")) { await store.deleteProject(d.dataset.del); renderLibrary(); }
});
async function resume(rec) {
  S.P = rec.project; S.pid = rec.id; S.name = rec.name; S.words = new Map(Object.entries(rec.words || {})); S.files.clear(); S.urls.clear(); hist.clear(); S.sel = null; S.t = 0;
  for (const m of S.P.media) {
    const f = await store.loadMedia(rec.id, m.id);
    if (!f) { alert("The video file for this project is no longer stored in this browser. Please add it again."); S.P = null; return; }
    S.files.set(m.id, f); S.urls.set(m.id, URL.createObjectURL(f));
  }
  showEditor(true); changed();
}

function renderAll() {
  if (!S.P) return;
  renderTimeline(); renderInspector(); renderPageList(); renderMedia();
  $("undo").disabled = !hist.canUndo; $("redo").disabled = !hist.canRedo;
  $("projname").textContent = S.name || "Untitled project";
  const h = ops.headlineClip(S.P); if (document.activeElement !== $("headline")) $("headline").value = h ? h.text : "";
  if (S.P.capStyle && document.activeElement !== $("capstyle")) $("capstyle").value = S.P.capStyle; capHint();
  $("inspector").classList.toggle("on", !!S.sel);
  const tc = document.querySelector('[data-panel="transitions"]');
  if (tc) { const f = selectedClip(); $("trinfo").textContent = f && f.clip.kind === "video" ? "Selected clip: " + (f.clip.trIn ? f.clip.trIn.type : "hard cut") + "." : "Select a video clip on the timeline first."; }
}

// First load: go to the start screen, or straight back to the last project if the start screen is turned off.
(async () => {
  fillAi(); fillCapStyles(); startPage("start");
  renderLibrary();
  try {
    if (localStorage.getItem("reelloom.showStart") === "0") { const rec = await store.latestProject(); if (rec) { await resume(rec); return; } }
  } catch { /* no storage: start screen */ }
})();
window.__reelloom = { els, S, M, ops, edit, hist, render, setTime, play, pause, exportNow: () => exportProject(S.P, S.files, { width: 540 }) };
