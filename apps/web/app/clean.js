// Automatic clean-up: decides what to cut from word timings plus an audio loudness track.
// Pure functions, no DOM, so they can be tested in Node.
//
// words:  [{t, s, e}]            spoken words with start/end seconds (from Whisper)
// levels: [{t, db}]              loudness every ~50 ms of the whole clip (from the audio)
// returns { cuts:[{a,b,why}], dropped:Set<index>, stats }

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hm", "hmm", "mm", "mmm", "eh", "mhm"]);
const EXTRA_PHRASES = [["you", "know"], ["i", "mean"], ["sort", "of"], ["kind", "of"]];
const EXTRA_WORDS = new Set(["basically", "literally", "actually"]);

export const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, "");
const endsSentence = (w) => /[.!?]$/.test(w);

export function planCleanup(words, levels, dur, o = {}) {
  const opt = Object.assign({ silences: true, fillers: true, repeats: true, retakes: true, extraFillers: false, pause: 0.7 }, o);
  const W = words.map((w, i) => ({ ...w, i, n: norm(w.t), why: null }));
  const kill = (w, why) => { if (!w.why) w.why = why; };

  if (opt.fillers) {
    for (const w of W) if (FILLERS.has(w.n)) kill(w, "filler");
    if (opt.extraFillers) {
      for (const w of W) if (EXTRA_WORDS.has(w.n)) kill(w, "filler");
      for (let i = 0; i + 1 < W.length; i++) for (const p of EXTRA_PHRASES) if (W[i].n === p[0] && W[i + 1].n === p[1]) { kill(W[i], "filler"); kill(W[i + 1], "filler"); }
    }
  }

  if (opt.repeats) {
    // A phrase said twice in a row ("I want to, I want to talk"): drop the first copy, keep the last.
    for (let n = 4; n >= 1; n--) {
      for (let i = 0; i + 2 * n <= W.length; i++) {
        let same = true;
        for (let k = 0; k < n; k++) { const a = W[i + k], b = W[i + n + k]; if (a.why || b.why || !a.n || a.n !== b.n) { same = false; break; } }
        if (!same) continue;
        const last = W[i + n - 1], next = W[i + n];
        if (next.s - last.e > 1.0 || endsSentence(last.t)) continue;
        for (let k = 0; k < n; k++) kill(W[i + k], "repeat");
      }
    }
  }

  if (opt.retakes) {
    // A sentence that is started again: the earlier, near-identical (or unfinished) attempt goes.
    const segs = []; let cur = [];
    for (const w of W) {
      if (w.why) continue;
      const prev = cur[cur.length - 1];
      if (prev && (endsSentence(prev.t) || w.s - prev.e > 0.8)) { segs.push(cur); cur = []; }
      cur.push(w);
    }
    if (cur.length) segs.push(cur);
    const setOf = (s) => new Set(s.map((w) => w.n).filter(Boolean));
    for (let j = 0; j < segs.length; j++) {
      const a = segs[j]; if (a.length < 3) continue;
      for (let k = j + 1; k <= Math.min(j + 2, segs.length - 1); k++) {
        const b = segs[k]; if (b[0].s - a[a.length - 1].e > 20) continue;
        const A = setOf(a), B = setOf(b), inter = [...A].filter((x) => B.has(x)).length, jac = inter / (A.size + B.size - inter || 1);
        const prefix = a.length < b.length && a.every((w, i) => w.n === b[i].n);
        if (jac >= 0.75 || prefix) { for (const w of a) kill(w, "retake"); break; }
      }
    }
  }

  const cuts = [];
  const kept = W.filter((w) => !w.why);
  // 1. Cut every run of dropped words.
  for (let i = 0; i < W.length;) {
    if (!W[i].why) { i++; continue; }
    let j = i; while (j + 1 < W.length && W[j + 1].why) j++;
    const prevKept = [...W.slice(0, i)].reverse().find((w) => !w.why), nextKept = W.slice(j + 1).find((w) => !w.why);
    const a = Math.max(prevKept ? prevKept.e + 0.03 : 0, W[i].s - 0.03), b = Math.min(nextKept ? nextKept.s - 0.03 : dur, W[j].e + 0.05);
    const why = W.slice(i, j + 1).every((w) => w.why === W[i].why) ? W[i].why : "mixed";
    if (b - a > 0.05) cuts.push({ a, b, why });
    i = j + 1;
  }

  // 2. Sounds between words that Whisper left out (a spoken "um" often is not in the transcript), and plain silences.
  const sorted = levels.map((l) => l.db).sort((x, y) => x - y);
  const loud = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : -20;
  const voiceThr = Math.max(-50, loud - 16);
  const step = levels.length > 1 ? levels[1].t - levels[0].t : 0.05;
  const voicedRuns = (from, to) => {
    const runs = []; let s = null;
    for (const l of levels) {
      if (l.t < from || l.t > to) { if (s !== null) { runs.push([s, l.t]); s = null; } continue; }
      if (l.db > voiceThr) { if (s === null) s = l.t; } else if (s !== null) { runs.push([s, l.t]); s = null; }
    }
    if (s !== null) runs.push([s, to]);
    return runs;
  };
  const gaps = [];
  if (kept.length) {
    gaps.push([0, kept[0].s]);
    for (let i = 0; i + 1 < kept.length; i++) gaps.push([kept[i].e, kept[i + 1].s]);
    gaps.push([kept[kept.length - 1].e, dur]);
  }
  gaps.forEach(([g0, g1], gi) => {
    const first = gi === 0, last = gi === gaps.length - 1;
    if (opt.fillers && levels.length) {
      const lo = g0 + (first ? 0.05 : 0.12), hi = g1 - (last ? 0.05 : 0.12);
      if (hi - lo >= 0.25) for (const [x, y] of voicedRuns(lo, hi)) if (y - x >= 0.25 && y - x <= 1.6) cuts.push({ a: x - 0.02, b: y + 0.02, why: "filler" });
    }
    if (opt.silences && g1 - g0 > opt.pause) {
      const a = first ? g0 : g0 + 0.2, b = last ? g1 : g1 - 0.2;
      if (b - a > 0.15) cuts.push({ a, b, why: "silence" });
    }
  });

  cuts.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const c of cuts) {
    const l = merged[merged.length - 1];
    if (l && c.a <= l.b + 0.02) { l.b = Math.max(l.b, c.b); if (l.why !== c.why) l.parts = Object.assign(l.parts || { [l.why]: 1 }, { [c.why]: 1 }); }
    else merged.push({ ...c });
  }
  const stats = { fillers: 0, repeats: 0, retakes: 0, silences: 0, seconds: 0 };
  for (const c of merged) {
    stats.seconds += c.b - c.a;
    const whys = Object.keys(c.parts || { [c.why]: 1 });
    for (const w of whys) { if (w === "filler") stats.fillers++; else if (w === "repeat") stats.repeats++; else if (w === "retake") stats.retakes++; else if (w === "silence") stats.silences++; }
  }
  stats.seconds = Math.round(stats.seconds * 10) / 10;
  return { cuts: merged, words: W, stats };
}

// Group word timings into short caption lines: up to 4 words, break on a pause or the end of a sentence.
export function group(words) {
  const caps = []; let cur = [];
  const flush = () => { if (cur.length) { caps.push({ s: cur[0].s, e: cur[cur.length - 1].e, t: cur.map((w) => w.t).join(" ") }); cur = []; } };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.s - prev.e > 0.6) flush();
    cur.push(w);
    if (cur.length >= 4 || /[.!?]$/.test(w.t)) flush();
  }
  flush();
  for (let i = 0; i < caps.length; i++) {                  // hold each caption until the next one starts, up to 0.4 s
    const next = caps[i + 1];
    caps[i].e = next ? Math.min(next.s, caps[i].e + 0.4) : caps[i].e + 0.4;
  }
  return caps;
}

