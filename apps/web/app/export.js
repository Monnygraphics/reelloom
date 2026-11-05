// Export the whole project to an MP4 inside the browser (WebCodecs through mediabunny). Nothing is uploaded.
// Frames come from the same drawProject() the preview uses; audio is mixed from every clip on the timeline.
import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink, Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } from "./vendor/mediabunny.min.mjs";
import { drawProject, loadFonts } from "./engine.js";

const RATE = 48000;

// Hands out the decoded frames of one clip in order; `at(ts)` is the frame showing at source time ts.
class Feeder {
  constructor(sink, a, b) { this.it = sink.canvases(a, b)[Symbol.asyncIterator](); this.cur = null; this.next = null; this.done = false; }
  async pull() { const r = await this.it.next(); if (r.done) { this.done = true; return null; } return r.value; }
  async at(ts) {
    if (!this.cur) this.cur = await this.pull();
    for (;;) {
      if (!this.next && !this.done) this.next = await this.pull();
      if (this.next && this.next.timestamp <= ts + 1e-4) { this.cur = this.next; this.next = null; } else break;
    }
    return this.cur;
  }
  async close() { try { await this.it.return?.(); } catch {} }
}

export function outputSize(P, width) {
  const W = width, H = Math.round((W * P.canvas.h) / P.canvas.w / 2) * 2;
  return { W: W % 2 ? W + 1 : W, H };
}

// Mixes every audible clip into two 48 kHz channels. `inputs` maps mediaId -> mediabunny Input.
export async function mixAudio(P, inputs, onProgress) {
  const M = globalThis.SAModel, total = M.duration(P), n = Math.ceil(total * RATE) + 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  const jobs = [];
  for (const t of P.tracks) for (const c of t.clips) { const m = M.mediaOf(P, c); if ((c.kind === "audio" || c.kind === "video") && m && m.hasAudio && inputs.get(m.id)) jobs.push({ c, m }); }
  const sinks = new Map(); let done = 0, any = false;
  for (const { c, m } of jobs) {
    if (!sinks.has(m.id)) { const tr = await inputs.get(m.id).getPrimaryAudioTrack(); sinks.set(m.id, tr ? new AudioBufferSink(tr) : null); }
    const sink = sinks.get(m.id); if (!sink) continue;
    const vol = c.volume == null ? 1 : c.volume, fi = c.trIn && c.trIn.type === "fade" ? c.trIn.dur : 0, fo = c.trOut ? c.trOut.dur : 0, edge = 0.006;
    for await (const wb of sink.buffers(c.in, c.in + c.dur)) {
      const b = wb.buffer, sr = b.sampleRate, ch0 = b.getChannelData(0), ch1 = b.numberOfChannels > 1 ? b.getChannelData(1) : ch0;
      const step = sr / RATE;                                             // source samples per output sample
      const o0 = Math.round((c.start + (wb.timestamp - c.in)) * RATE), len = Math.floor(b.length / step);
      for (let i = 0; i < len; i++) {
        const o = o0 + i; if (o < 0 || o >= n) continue;
        const tl = o / RATE - c.start; if (tl < 0 || tl >= c.dur) continue;  // outside the clip
        const sp = i * step, i0 = Math.floor(sp), f = sp - i0, i1 = Math.min(i0 + 1, b.length - 1);
        let g = vol;
        g *= Math.min(1, tl / edge, (c.dur - tl) / edge);                  // a few ms of fade stops clicks at every cut
        if (fi) g *= Math.min(1, tl / fi); if (fo) g *= Math.min(1, (c.dur - tl) / fo);
        L[o] += (ch0[i0] * (1 - f) + ch0[i1] * f) * g; R[o] += (ch1[i0] * (1 - f) + ch1[i1] * f) * g;
      }
      any = true;
    }
    done++; if (onProgress) onProgress(done / jobs.length);
  }
  return any ? { chans: [L, R], length: n } : null;
}

export async function exportProject(P, files, o = {}) {
  const M = globalThis.SAModel, say = o.onStatus || (() => {}), prog = o.onProgress || (() => {}), fps = P.canvas.fps || 30;
  const total = M.duration(P); if (total <= 0) throw new Error("There is nothing on the timeline.");
  const { W, H } = outputSize(P, o.width || 1080);
  await loadFonts(); await Promise.all(["Montserrat", "Poppins", "Inter", "Anton", "Libre Baskerville", "Cormorant Garamond"].map((f) => document.fonts.load(`700 40px "${f}"`).catch(() => {})));
  const inputs = new Map(), sinks = new Map();
  for (const m of P.media) {
    const f = files.get(m.id); if (!f) continue;
    const input = new Input({ source: new BlobSource(f), formats: ALL_FORMATS }); inputs.set(m.id, input);
    const vt = await input.getPrimaryVideoTrack(); if (!vt) continue;
    const s = Math.min(1, 2048 / Math.max(vt.displayWidth, vt.displayHeight)), w = Math.max(2, Math.round(vt.displayWidth * s)), h = Math.max(2, Math.round(vt.displayHeight * s));
    sinks.set(m.id, { sink: new CanvasSink(vt, { width: w, height: h, fit: "fill" }), w, h });
  }
  if (!sinks.size) throw new Error("No video found to export.");
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const g = cv.getContext("2d");
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vsrc = new CanvasSource(cv, { codec: "avc", bitrate: QUALITY_HIGH }); output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null; const hasAudio = P.media.some((m) => m.hasAudio);
  if (hasAudio) { asrc = new AudioBufferSource({ codec: "aac", bitrate: 128000 }); output.addAudioTrack(asrc); }
  await output.start();

  const feeders = new Map(), frames = new Map(), nFrames = Math.ceil(total * fps - 1e-6);
  const env = { frame: (clip) => frames.get(clip.id) || null };
  say("Rendering video...");
  for (let i = 0; i < nFrames; i++) {
    if (o.signal && o.signal.aborted) throw new Error("Export cancelled.");
    const t = i / fps; frames.clear();
    const live = new Set();
    for (const { clip } of M.visibleAt(P, t)) {
      if (clip.kind !== "video") continue;
      const sk = sinks.get(clip.mediaId); if (!sk) continue; live.add(clip.id);
      let fd = feeders.get(clip.id); if (!fd) { fd = new Feeder(sk.sink, clip.in, clip.in + clip.dur + 0.25); feeders.set(clip.id, fd); }
      const wc = await fd.at(clip.in + (t - clip.start)); if (wc) frames.set(clip.id, { img: wc.canvas, w: sk.w, h: sk.h });
    }
    for (const [id, fd] of feeders) if (!live.has(id)) { await fd.close(); feeders.delete(id); }
    drawProject(g, P, t, W, H, env);
    await vsrc.add(t, 1 / fps);
    if (i % 5 === 0) { prog(0.9 * (i / nFrames)); await new Promise((r) => setTimeout(r)); }
  }
  for (const fd of feeders.values()) await fd.close();

  if (asrc) {
    say("Mixing the sound...");
    const mix = await mixAudio(P, inputs, (p) => prog(0.9 + 0.04 * p));
    if (mix) {
      if (o.loudness !== false) { say("Setting the loudness..."); const { normalize } = await import("./loudness.js"); o.stats = normalize(mix.chans, -14); }
      const chunk = RATE * 5;
      for (let a = 0; a < mix.length; a += chunk) {
        const len = Math.min(chunk, mix.length - a), ab = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: RATE });
        ab.copyToChannel(mix.chans[0].subarray(a, a + len), 0); ab.copyToChannel(mix.chans[1].subarray(a, a + len), 1);
        await asrc.add(ab);
      }
    }
  }
  say("Finishing...");
  vsrc.close(); if (asrc) asrc.close();
  await output.finalize(); prog(1);
  return new Blob([output.target.buffer], { type: "video/mp4" });
}
