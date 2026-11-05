// Project operations that do not touch the page: they work on the plain project object from model.js.
// In the browser the model is globalThis.SAModel (loaded by a script tag); the tests set it before importing this file.
const M = () => globalThis.SAModel;
const round = (x) => Math.round(x * 1000) / 1000;
let pid = 0;
const newId = (p) => p + Date.now().toString(36) + (pid++).toString(36);

// ---- history: snapshots of the whole project (small JSON), so undo/redo cover every kind of edit ----
export function makeHistory(limit = 100) {
  const undo = [], redo = [];
  return {
    push(before) { if (undo[undo.length - 1] === before) return; undo.push(before); if (undo.length > limit) undo.shift(); redo.length = 0; },
    undo(current) { if (!undo.length) return null; redo.push(current); return undo.pop(); },
    redo(current) { if (!redo.length) return null; undo.push(current); return redo.pop(); },
    get canUndo() { return undo.length > 0; }, get canRedo() { return redo.length > 0; },
    clear() { undo.length = 0; redo.length = 0; },
  };
}

// words from the speech model ({t,s,e}) or from the project ({w,s,e}) -> the project's shape
export const toModelWords = (ws) => ws.map((w) => ({ w: w.w != null ? w.w : w.t, s: w.s, e: w.e }));

export function newReel(preset = "9:16") { const P = M().newProject(preset, 30); P.pages = []; P.capStyle = "apollo"; return P; }

// ---- media and the main timeline ----
export function addVideo(P, info) {
  const m = M().addMedia(P, { id: info.id, name: info.name, kind: "video", duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio !== false });
  const c = M().addMediaClip(P, m.id);
  if (c) c.fit = "cover";
  return { media: m, clip: c };
}

export function keepFromCuts(dur, cuts, min = 0.04) {
  const cs = cuts.filter((c) => c.b - c.a > 0.01).sort((a, b) => a.a - b.a), segs = []; let p = 0;
  for (const c of cs) { if (c.a > p) segs.push({ a: p, b: c.a }); p = Math.max(p, c.b); }
  if (p < dur) segs.push({ a: p, b: dur });
  return segs.filter((s) => s.b - s.a > min);
}

// Replace the main picture track with consecutive pieces of one recording (source ranges), ripple-packed from 0.
export function setSegments(P, mediaId, segs) {
  const vt = P.tracks.find((t) => t.kind === "video"), old = vt.clips.find((c) => c.mediaId === mediaId) || {};
  vt.clips = [];
  let cursor = 0;
  for (const s of segs) {
    const c = { id: newId("c"), kind: "video", mediaId, start: round(cursor), dur: round(s.b - s.a), in: round(s.a), volume: old.volume == null ? 1 : old.volume, fit: old.fit || "cover" };
    vt.clips.push(c); cursor += c.dur;
  }
  return vt.clips;
}

// Remove everything that was derived from an earlier pass: captions, headline, pages, zoom.
export function clearDerived(P) {
  for (const t of P.tracks) if (t.kind === "text") t.clips = t.clips.filter((c) => !c.cap && !c.headline);
  P.pages = [];
}

// ---- captions ----
export function captionClips(P) { return P.tracks.filter((t) => t.kind === "text").flatMap((t) => t.clips.filter((c) => c.cap)); }
export function captionWordsOnTimeline(P) {
  const out = []; for (const c of captionClips(P)) for (const w of c.words) out.push({ w: w.w, s: round(c.start + w.s), e: round(c.start + w.e), brk: false });
  return out.sort((a, b) => a.s - b.s);
}
function stripCaptions(P) { for (const t of P.tracks) if (t.kind === "text") t.clips = t.clips.filter((c) => !c.cap); }

// Build captions (one text clip per short phrase) in a named style from words that are already in timeline time.
export function makeCaptions(P, tlWords, styleName) {
  const style = M().STYLES[styleName] || M().STYLES.apollo, st = style.caption, was = st.upper;
  st.upper = false;                                   // keep the original case in the data; the drawing code applies upper-case
  let made; try { made = M().addCaptions(P, tlWords, styleName, { has: () => true }); } finally { st.upper = was; }
  for (const c of made) c.upper = !!was;
  P.capStyle = styleName; return made;
}
// srcWords: an array (for `mediaId`) or a Map of mediaId -> words, all in source seconds.
export function captionsFromSource(P, srcWords, styleName, mediaId) {
  stripCaptions(P);
  const get = (id) => (srcWords instanceof Map ? toModelWords(srcWords.get(id) || []) : !mediaId || id === mediaId ? toModelWords(srcWords) : []);
  const tl = M().timelineWords(P, get);
  const keep = tl.map((w) => ({ w: w.w, s: w.s, e: w.e }));
  return makeCaptions(P, keep, styleName || P.capStyle || "apollo");
}
// Change the look of every caption in place (text and timings are kept, including hand edits).
export function restyleCaptions(P, styleName) {
  const style = M().STYLES[styleName]; if (!style) return false; const st = style.caption, font = M().pickFont(styleName, () => true);
  for (const c of captionClips(P)) Object.assign(c, { size: st.size, color: st.color, y: st.y, pill: st.pill, pillA: st.pillA, hi: st.hi, hiMode: st.hiMode, shadow: st.shadow, outline: st.outline, font: font.family, fw: font.weight, upper: !!st.upper });
  P.capStyle = styleName; return true;
}
export function addCaptionAt(P, t, text = "New caption", dur = 2) {
  const style = M().STYLES[P.capStyle || "apollo"].caption, ws = text.split(/\s+/).filter(Boolean), per = dur / Math.max(1, ws.length);
  const made = makeCaptions(P, ws.map((w, i) => ({ w, s: round(t + i * per), e: round(t + (i + 1) * per) })), P.capStyle || "apollo");
  return made[0] || null;
}
// Change the text of one caption, keeping its timing (words are spread evenly over the clip).
export function setCaptionText(P, id, text) {
  const f = M().find(P, id); if (!f || !f.clip.cap) return false;
  const ws = text.split(/\s+/).filter(Boolean); if (!ws.length) return false; const per = f.clip.dur / ws.length;
  f.clip.text = text; f.clip.words = ws.map((w, i) => ({ w, s: round(i * per), e: round((i + 1) * per) })); return true;
}

// ---- headline ----
export function setHeadline(P, text, o = {}) {
  let found = null; for (const t of P.tracks) { const c = t.clips.find((x) => x.headline); if (c) { found = { t, c }; break; } }
  if (!text) { if (found) found.t.clips = found.t.clips.filter((c) => c !== found.c); return null; }
  if (found) { found.c.text = text; if (o.dur) found.c.dur = o.dur; return found.c; }
  const c = M().addText(P, o.start || 0, o.dur || 4, text); c.headline = true; c.size = 64; c.y = 0.14; c.font = "Montserrat"; c.fw = 700; c.trIn = { type: "fade", dur: 0.3 }; c.trOut = { type: "fade", dur: 0.3 };
  return c;
}
export const headlineClip = (P) => P.tracks.flatMap((t) => t.clips).find((c) => c.headline) || null;

// ---- pages (split explainer pages) ----
export function addPage(P, pg) {
  const page = Object.assign({ id: newId("p"), start: 0, end: 4, style: "dark", split: true, pip: true, text: "", motion: { type: "quote", quote: "" } }, pg);
  page.start = round(page.start); page.end = round(Math.max(page.start + 0.5, page.end)); (P.pages = P.pages || []).push(page); P.pages.sort((a, b) => a.start - b.start); return page;
}
export const removePage = (P, id) => { const n = (P.pages || []).length; P.pages = (P.pages || []).filter((p) => p.id !== id); return P.pages.length < n; };
export const pageAt = (P, t) => (P.pages || []).find((p) => t >= p.start && t < p.end) || null;

// ---- the rule-based director ("Autopilot"), all on the visitor's device ----
// Takes the recording's words (source seconds) and the cleaned-up cut list; returns a report of what was done.
export function autopilot(P, mediaId, srcWords, cuts, o = {}) {
  const mod = M(), media = P.media.find((m) => m.id === mediaId), dur = media.duration;
  setSegments(P, mediaId, keepFromCuts(dur, cuts)); clearDerived(P);
  const mw = toModelWords(srcWords), tl = mod.timelineWords(P, () => mw).map((w) => ({ w: w.w, s: w.s, e: w.e }));
  const total = mod.duration(P);
  if (tl.length < 5) { const made = makeCaptions(P, tl, o.style || "apollo"); return { total, captions: made.length, pages: 0, punches: 0, hook: null, tone: "neutral" }; }
  const profile = mod.understand(tl), dir = mod.directorFor(profile), hook = mod.findHook(tl, profile);
  const style = o.style || (profile.tone === "fun" ? "ares" : profile.tone === "calm" ? "hestia" : "apollo");
  let hookInfo = null;
  if (hook && hook.text) {
    const text = o.hookText || hook.text.charAt(0).toUpperCase() + hook.text.slice(1);
    setHeadline(P, text, { start: 0, dur: Math.min(4.2, total)}); hookInfo = text;
  }
  const hookWin = hookInfo ? [{ start: 0, end: 4.3 }] : [];
  const closingRoom = 0;
  const cards = mod.planCards(tl, profile, total, { every: dir.cardEvery, avoid: hookWin, closingRoom });
  const keep = o.pages === false ? [] : cards;
  for (const c of keep) addPage(P, { start: c.start, end: c.end, style: c.style, text: c.text || "", motion: c.motion || null, closing: c.closing || null });
  const plan = mod.planPunch(tl, total, dir.punchEvery, { avoid: P.pages.concat(hookWin) });
  const punches = o.punch === false ? 0 : mod.applyPunch(P, plan, 0.4);
  const caps = makeCaptions(P, tl, style);
  return { total: round(total), cut: round(dur - total), captions: caps.length, pages: P.pages.length, punches, hook: hookInfo, tone: profile.tone, category: profile.category, style };
}

// Use the AI helper's answer (already validated) on top of what the rules produced.
export function applyAiPlan(P, ai) {
  let n = 0;
  if (ai.hook) { setHeadline(P, ai.hook, { dur: 4.2 }); n++; }
  (ai.pages || []).forEach((pg, i) => { const target = (P.pages || [])[i]; if (!target || !pg) return; if (pg.title) { target.text = pg.title; n++; } if (pg.quote && target.motion && target.motion.type === "quote") target.motion.quote = pg.quote; });
  return n;
}

// ---- shorts ----
export function shortsFor(srcWords, o = {}) { return M().findShorts(toModelWords(srcWords), o); }
// Reset the timeline to one stretch of the recording (a Short), keeping nothing derived.
export function useShort(P, mediaId, a, b) {
  clearDerived(P); setSegments(P, mediaId, [{ a, b }]);
  const vt = P.tracks.find((t) => t.kind === "video"); return vt.clips[0];
}
export function wordsInRange(srcWords, a, b) { return srcWords.filter((w) => w.s >= a - 0.001 && w.e <= b + 0.001); }

// ---- simple edits used by the buttons ----
export function splitAt(P, id, t) { return M().splitClip(P, id, t); }
export function clipAt(P, t, kinds = ["video"]) { for (const { clip } of M().visibleAt(P, t)) if (kinds.includes(clip.kind)) return clip; return null; }
// Fade the cut between two neighbouring clips, or slide in, on the clip that starts at `id`.
export function setTransition(P, id, type, dur = 0.5) {
  if (type === "crossfade") { const f = M().find(P, id); if (f && f.clip.trIn) delete f.clip.trIn; return M().crossfade(P, id, dur); }
  return M().setTransition(P, id, "in", type, dur);
}
export function setPunch(P, id, zoom, o = {}) { return M().setZoom(P, id, o.from || 1, zoom, { ease: o.ease || "inout", fx: o.fx == null ? 0.5 : o.fx, fy: o.fy == null ? 0.4 : o.fy }); }

// Captions from words that are already in timeline seconds (a pasted script, for example).
export function captionsFromTimeline(P, tlWords, styleName) { stripCaptions(P); return makeCaptions(P, tlWords, styleName || P.capStyle || "apollo"); }

// Swap a clip with its neighbour on the same track (dir -1 earlier, +1 later), keeping any gap between them.
export function reorderClip(P, id, dir) {
  const f = M().find(P, id); if (!f) return false;
  const list = f.track.clips.slice().sort((a, b) => a.start - b.start), i = list.indexOf(f.clip), j = i + dir;
  if (j < 0 || j >= list.length) return false;
  const [a, b] = i < j ? [list[i], list[j]] : [list[j], list[i]], gap = Math.max(0, b.start - (a.start + a.dur)), s0 = a.start;
  b.start = round(s0); a.start = round(s0 + b.dur + gap); f.track.clips.sort((x, y) => x.start - y.start); return true;
}
