// On-device captions: Whisper runs in this tab through transformers.js. The audio never leaves the device.
// The model files (about 80 MB) download once from Hugging Face and are cached by the browser.
import { pipeline, env } from "./vendor/transformers.js";
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from "./vendor/mediabunny.min.mjs";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;      // multi-thread needs cross-origin isolation, which a plain static host does not give
env.backends.onnx.wasm.proxy = false;

const MODEL = "Xenova/whisper-base";
let asr = null;

async function audioTo16k(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("This video has no audio.");
  const sink = new AudioBufferSink(track), parts = [];
  let rate = 16000, total = 0;
  for await (const { buffer } of sink.buffers()) {
    rate = buffer.sampleRate;
    const n = buffer.length, mono = new Float32Array(n), ch = buffer.numberOfChannels;
    for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    parts.push(mono); total += n;
  }
  const all = new Float32Array(total); let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  if (rate === 16000) return all;
  const ratio = rate / 16000, outLen = Math.floor(all.length / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {                       // box average: fine for speech and avoids aliasing
    const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

// Group word timings into short caption lines: up to 4 words, break on a pause or the end of a sentence.
function group(words) {
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

export async function transcribe(file, say) {
  say("Reading the audio...");
  const audio = await audioTo16k(file);
  if (!asr) {
    say("Downloading the speech model (one time, about 80 MB)...");
    const files = {};                                       // per-file byte counts, so the percentage covers the whole model
    asr = await pipeline("automatic-speech-recognition", MODEL, {
      dtype: "q8", device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          files[p.file] = { l: p.loaded, t: p.total };
          let l = 0, t = 0; for (const f of Object.values(files)) { l += f.l; t += f.t; }
          say("Downloading the speech model (one time)... " + Math.round((l / t) * 100) + "% of " + Math.round(t / 1048576) + " MB");
        } else if (p.status === "ready") say("Starting the speech model...");
      },
    });
  }
  say("Listening... this takes about as long as the clip is. Keep this tab open.");
  const out = await asr(audio, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5, task: "transcribe" });
  const words = (out.chunks || []).map((c) => ({ t: c.text.trim(), s: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.3 })).filter((w) => w.t);
  if (!words.length) throw new Error("No speech found.");
  return group(words);
}
