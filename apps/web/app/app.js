import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink, Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } from "./vendor/mediabunny.min.mjs";

const $ = (id) => document.getElementById(id);
const S = {
  file: null, url: "", dur: 0, vw: 0, vh: 0,
  cuts: [],            // [{a,b}] removed ranges in source seconds, sorted and merged
  caps: [],            // [{s,e,t}] captions in source seconds
  mark: null,
  style: { size: 56, hi: "#F2A93A", headline: "", punch: true },
};

const video = document.createElement("video");
video.muted = false; video.playsInline = true; video.preload = "auto";
const cv = $("cv"), ctx = cv.getContext("2d");

// ---------- support check ----------
if (!("VideoEncoder" in window) || !("AudioEncoder" in window)) $("support").hidden = false;

// ---------- helpers ----------
const fmt = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ":" + String(s).padStart(2, "0"); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function mergeCuts() {
  S.cuts = S.cuts.filter((c) => c.b - c.a > 0.05).sort((x, y) => x.a - y.a);
  const out = [];
  for (const c of S.cuts) { const l = out[out.length - 1]; if (l && c.a <= l.b + 0.01) l.b = Math.max(l.b, c.b); else out.push({ a: c.a, b: c.b }); }
  S.cuts = out;
}
function keepSegments() {
  const segs = []; let p = 0;
  for (const c of S.cuts) { if (c.a > p) segs.push({ a: p, b: c.a }); p = Math.max(p, c.b); }
  if (p < S.dur) segs.push({ a: p, b: S.dur });
  return segs.filter((s) => s.b - s.a > 0.04);
}
const keptDuration = () => keepSegments().reduce((n, s) => n + (s.b - s.a), 0);
const cutAt = (t) => S.cuts.find((c) => t >= c.a && t < c.b);

// ---------- drawing (shared by preview and export) ----------
function wrapLines(g, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean), lines = []; let cur = [];
  for (const w of words) {
    const test = cur.concat(w).join(" ");
    if (cur.length && g.measureText(test).width > maxW) { lines.push(cur); cur = [w]; } else cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}
function capIndexAt(t) { return S.caps.findIndex((c) => t >= c.s && t < c.e); }

function drawFrame(g, W, H, src, sw, sh, t) {
  const k = W / 1080;                       // all sizes are authored for a 1080 wide frame
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  const ci = capIndexAt(t);
  const zoom = S.style.punch && ci >= 0 && ci % 2 === 1 ? 1.12 : 1;
  const sc = Math.max(W / sw, H / sh) * zoom;
  const dw = sw * sc, dh = sh * sc;
  const fx = 0.5, fy = 0.38;               // zoom toward the face area
  const dx = clamp(W * fx - dw * fx, W - dw, 0), dy = clamp(H * fy - dh * fy, H - dh, 0);
  if (src) g.drawImage(src, dx, dy, dw, dh);

  g.textAlign = "center"; g.textBaseline = "middle";
  if (S.style.headline) {
    g.font = "800 " + 64 * k + "px system-ui, 'Segoe UI', Arial, sans-serif";
    const lines = wrapLines(g, S.style.headline, W * 0.84).map((l) => l.join(" "));
    const lh = 76 * k, top = 150 * k;
    lines.forEach((line, i) => {
      const y = top + i * lh;
      g.lineWidth = 10 * k; g.strokeStyle = "rgba(0,0,0,.7)"; g.lineJoin = "round"; g.strokeText(line, W / 2, y);
      g.fillStyle = "#fff"; g.fillText(line, W / 2, y);
    });
  }
  if (ci >= 0) {
    const c = S.caps[ci], size = S.style.size * k;
    g.font = "800 " + size + "px system-ui, 'Segoe UI', Arial, sans-serif";
    const lines = wrapLines(g, c.t, W * 0.8), total = lines.reduce((n, l) => n + l.length, 0) || 1;
    const hiIdx = Math.min(total - 1, Math.floor(((t - c.s) / Math.max(0.01, c.e - c.s)) * total));
    const lh = size * 1.3, padX = 30 * k, padY = 18 * k;
    const boxW = Math.max(...lines.map((l) => g.measureText(l.join(" ")).width)) + padX * 2, boxH = lines.length * lh + padY * 2 - (lh - size);
    const cy = H * 0.76, bx = (W - boxW) / 2, by = cy - boxH / 2;
    g.fillStyle = "rgba(10,10,12,.62)"; g.beginPath(); g.roundRect(bx, by, boxW, boxH, 26 * k); g.fill();
    let n = 0;
    lines.forEach((line, li) => {
      const y = by + padY + (size) / 2 + li * lh, full = line.join(" "), lw = g.measureText(full).width;
      let x = W / 2 - lw / 2; g.textAlign = "left";
      line.forEach((w, wi) => {
        g.fillStyle = n === hiIdx ? S.style.hi : "#fff";
        g.fillText(w, x, y); x += g.measureText(w + (wi < line.length - 1 ? " " : "")).width; n++;
      });
    });
    g.textAlign = "center";
  }
}

function render() {
  if (!S.file) return;
  drawFrame(ctx, cv.width, cv.height, video, S.vw, S.vh, video.currentTime);
}

// ---------- timeline / UI ----------
function drawTimeline() {
  const pct = (t) => (t / S.dur) * 100 + "%";
  $("tl-cuts").innerHTML = S.cuts.map((c, i) => `<div class="tl-cut" data-i="${i}" title="Click to put back" style="left:${pct(c.a)};width:${((c.b - c.a) / S.dur) * 100}%"></div>`).join("");
  $("tl-caps").innerHTML = S.caps.map((c) => `<div class="tl-cap" style="left:${pct(c.s)};width:${((c.e - c.s) / S.dur) * 100}%"></div>`).join("");
  const kept = keptDuration();
  $("cutinfo").textContent = S.cuts.length ? `${S.cuts.length} cut${S.cuts.length > 1 ? "s" : ""}, reel length ${fmt(kept)} (was ${fmt(S.dur)}).` : "No cuts yet.";
}
function drawHead() {
  $("tl-head").style.left = (video.currentTime / S.dur) * 100 + "%";
  $("clock").textContent = fmt(video.currentTime) + " / " + fmt(S.dur);
}
function drawCapList() {
  $("caplist").innerHTML = S.caps.map((c, i) => `<div class="cap-row" data-i="${i}">
    <input type="number" step="0.1" min="0" value="${c.s.toFixed(1)}" data-f="s" aria-label="Start seconds">
    <input type="number" step="0.1" min="0" value="${c.e.toFixed(1)}" data-f="e" aria-label="End seconds">
    <input value="${esc(c.t)}" data-f="t" aria-label="Caption text">
    <button data-del title="Delete caption" aria-label="Delete caption">&times;</button></div>`).join("");
}
function refresh() { mergeCuts(); S.caps.sort((a, b) => a.s - b.s); drawTimeline(); drawCapList(); render(); }

// ---------- load a file ----------
async function loadFile(file) {
  if (!file || !file.type.startsWith("video/")) { alert("Please choose a video file."); return; }
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file; S.url = URL.createObjectURL(file); S.cuts = []; S.caps = []; S.mark = null;
  video.src = S.url;
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("This video can't be played by your browser.")); }).catch((e) => { alert(e.message); throw e; });
  S.dur = video.duration; S.vw = video.videoWidth; S.vh = video.videoHeight;
  cv.width = 540; cv.height = 960;
  $("start").hidden = true; $("editor").hidden = false;
  $("dl").hidden = true; $("expstatus").textContent = ""; $("capstatus").textContent = "";
  video.currentTime = 0; refresh(); drawHead();
}
$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

// ---------- playback ----------
let raf = 0;
function tick() {
  const t = video.currentTime, c = cutAt(t);
  if (!video.paused && c) { if (c.b >= S.dur - 0.02) { video.pause(); video.currentTime = c.a; } else video.currentTime = c.b; }
  render(); drawHead();
  raf = requestAnimationFrame(tick);
}
video.addEventListener("play", () => { $("play").textContent = "Pause"; cancelAnimationFrame(raf); tick(); });
video.addEventListener("pause", () => { $("play").textContent = "Play"; cancelAnimationFrame(raf); render(); drawHead(); });
video.addEventListener("seeked", () => { render(); drawHead(); });
video.addEventListener("ended", () => { video.pause(); });
$("play").addEventListener("click", () => { if (video.paused) { if (cutAt(video.currentTime)) video.currentTime = cutAt(video.currentTime).b; video.play(); } else video.pause(); });
$("timeline").addEventListener("click", (e) => {
  const cutEl = e.target.closest(".tl-cut");
  if (cutEl) { S.cuts.splice(+cutEl.dataset.i, 1); refresh(); return; }
  const r = $("timeline").getBoundingClientRect();
  video.currentTime = clamp(((e.clientX - r.left) / r.width) * S.dur, 0, S.dur);
});
document.addEventListener("keydown", (e) => {
  if (!S.file || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  if (e.code === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 5 : 1));
  if (e.code === "ArrowRight") video.currentTime = Math.min(S.dur, video.currentTime + (e.shiftKey ? 5 : 1));
});

// ---------- cuts ----------
$("mark").addEventListener("click", () => { S.mark = video.currentTime; $("mark").textContent = "Start marked at " + fmt(S.mark); $("cutnow").disabled = false; });
$("cutnow").addEventListener("click", () => {
  const a = Math.min(S.mark, video.currentTime), b = Math.max(S.mark, video.currentTime);
  S.cuts.push({ a, b }); S.mark = null; $("mark").textContent = "Mark start"; $("cutnow").disabled = true; refresh();
});
$("clearcuts").addEventListener("click", () => { S.cuts = []; refresh(); });

// Silence detection: decode the audio once, measure loudness in 50 ms windows, cut quiet stretches over 0.6 s.
$("autocut").addEventListener("click", async () => {
  const btn = $("autocut"); btn.disabled = true; btn.textContent = "Listening...";
  try {
    const input = new Input({ source: new BlobSource(S.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) { $("cutinfo").textContent = "This video has no audio to analyse."; return; }
    const sink = new AudioBufferSink(track), win = 0.05, levels = [];
    for await (const { buffer, timestamp } of sink.buffers()) {
      const d = buffer.getChannelData(0), n = Math.max(1, Math.floor(buffer.sampleRate * win));
      for (let i = 0; i + n <= d.length; i += n) {
        let sum = 0; for (let j = i; j < i + n; j++) sum += d[j] * d[j];
        levels.push({ t: timestamp + i / buffer.sampleRate, db: 10 * Math.log10(sum / n + 1e-12) });
      }
    }
    const sorted = levels.map((l) => l.db).sort((a, b) => a - b);
    const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
    const thr = Math.max(-55, loud - 22);                           // quiet = 22 dB below the loud speech
    let start = null, added = 0; const keepPad = 0.15, minGap = 0.6;
    const flush = (endT) => { if (start !== null && endT - start >= minGap) { S.cuts.push({ a: start + keepPad, b: endT - keepPad }); added++; } start = null; };
    for (const l of levels) { if (l.db < thr) { if (start === null) start = l.t; } else flush(l.t); }
    flush(levels.length ? levels[levels.length - 1].t + win : 0);
    refresh();
    $("cutinfo").textContent = added ? `Cut ${added} silent gap${added > 1 ? "s" : ""}. Reel length ${fmt(keptDuration())} (was ${fmt(S.dur)}). Click a red block to put one back.` : "No long silences found.";
  } catch (e) { $("cutinfo").textContent = "Could not analyse the audio: " + e.message; }
  finally { btn.disabled = false; btn.textContent = "Auto-cut silences"; }
});

// ---------- captions ----------
$("addcap").addEventListener("click", () => { const t = video.currentTime; S.caps.push({ s: t, e: Math.min(S.dur, t + 2), t: "New caption" }); refresh(); });
$("caplist").addEventListener("input", (e) => {
  const row = e.target.closest(".cap-row"); if (!row) return;
  const c = S.caps[+row.dataset.i], f = e.target.dataset.f;
  c[f] = f === "t" ? e.target.value : parseFloat(e.target.value) || 0;
  drawTimeline(); render();
});
$("caplist").addEventListener("change", () => refresh());
$("caplist").addEventListener("click", (e) => { if (e.target.closest("[data-del]")) { S.caps.splice(+e.target.closest(".cap-row").dataset.i, 1); refresh(); } });
$("usescript").addEventListener("click", () => {
  const words = $("script").value.split(/\s+/).filter(Boolean); if (!words.length) return;
  const per = 4, chunks = []; for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(" "));
  const segs = keepSegments(), total = segs.reduce((n, s) => n + (s.b - s.a), 0), each = total / chunks.length;
  let acc = 0; S.caps = chunks.map((t) => { const s = acc, e = acc + each; acc = e; return { s: toSource(s, segs), e: toSource(e - 0.02, segs), t }; });
  refresh();
});
function toSource(k, segs) { for (const s of segs) { const l = s.b - s.a; if (k <= l) return s.a + k; k -= l; } return segs.length ? segs[segs.length - 1].b : 0; }

$("autocap").addEventListener("click", async () => {
  const btn = $("autocap"), st = $("capstatus"); btn.disabled = true;
  try {
    const { transcribe } = await import("./transcribe.js");
    const caps = await transcribe(S.file, (msg) => { st.textContent = msg; });
    S.caps = caps; refresh(); st.textContent = `Added ${caps.length} captions. Check and fix any words below.`;
  } catch (e) { st.textContent = "Auto captions failed: " + e.message; }
  finally { btn.disabled = false; }
});

// ---------- look ----------
$("headline").addEventListener("input", (e) => { S.style.headline = e.target.value; render(); });
$("capsize").addEventListener("input", (e) => { S.style.size = +e.target.value; render(); });
$("hi").addEventListener("input", (e) => { S.style.hi = e.target.value; render(); });
$("punch").addEventListener("change", (e) => { S.style.punch = e.target.checked; render(); });

// ---------- export ----------
$("export").addEventListener("click", async () => {
  if (!("VideoEncoder" in window)) { $("expstatus").textContent = "This browser can't export. Use Chrome or Edge on a computer."; return; }
  video.pause();
  const btn = $("export"), st = $("expstatus"), bar = $("prog"); btn.disabled = true; $("dl").hidden = true; bar.hidden = false;
  const W = +$("size").value, H = Math.round((W * 16) / 9 / 2) * 2, fps = 30;
  try {
    const segs = keepSegments(), total = segs.reduce((n, s) => n + (s.b - s.a), 0);
    if (!segs.length) throw new Error("Everything is cut out.");
    const input = new Input({ source: new BlobSource(S.file), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
    if (!vt) throw new Error("No video track found.");
    const sink = new CanvasSink(vt, { width: W, height: H, fit: "cover" });
    const asink = at ? new AudioBufferSink(at) : null;
    const oc = new OffscreenCanvas(W, H), og = oc.getContext("2d");
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const vsrc = new CanvasSource(oc, { codec: "avc", bitrate: QUALITY_HIGH });
    output.addVideoTrack(vsrc, { frameRate: fps });
    let asrc = null;
    if (asink) { asrc = new AudioBufferSource({ codec: "aac", bitrate: 128000 }); output.addAudioTrack(asrc); }
    await output.start();
    let offset = 0;
    for (const seg of segs) {
      st.textContent = "Rendering video...";
      for await (const wc of sink.canvases(seg.a, seg.b)) {
        drawFrame(og, W, H, wc.canvas, W, H, wc.timestamp);
        await vsrc.add(offset + (wc.timestamp - seg.a), wc.duration);
        bar.firstElementChild.style.width = Math.min(95, ((offset + (wc.timestamp - seg.a)) / total) * 95) + "%";
      }
      if (asink) {
        for await (const wb of asink.buffers(seg.a, seg.b)) {
          const b = wb.buffer, sr = b.sampleRate, from = Math.max(0, Math.round((seg.a - wb.timestamp) * sr)), to = Math.min(b.length, Math.round((seg.b - wb.timestamp) * sr));
          if (to - from < 1) continue;
          let ab = b;
          if (from > 0 || to < b.length) {
            ab = new AudioBuffer({ length: to - from, numberOfChannels: b.numberOfChannels, sampleRate: sr });
            for (let c = 0; c < b.numberOfChannels; c++) ab.copyToChannel(b.getChannelData(c).subarray(from, to), c);
          }
          await asrc.add(ab);
        }
      }
      offset += seg.b - seg.a;
    }
    st.textContent = "Finishing...";
    vsrc.close(); if (asrc) asrc.close();
    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: "video/mp4" });
    const a = $("dl"); a.href = URL.createObjectURL(blob); a.download = S.file.name.replace(/\.[^.]+$/, "") + "-reel.mp4"; a.hidden = false;
    bar.firstElementChild.style.width = "100%";
    st.textContent = `Done: ${(blob.size / 1048576).toFixed(1)} MB, ${fmt(total)}. Press Download.`;
  } catch (e) { console.error(e); st.textContent = "Export failed: " + e.message; }
  finally { btn.disabled = false; }
});
