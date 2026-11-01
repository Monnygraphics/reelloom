// Integrated loudness (ITU-R BS.1770 / EBU R128) for 48 kHz audio, and a gain that lands on a target without clipping.
// Pure functions so they can be tested in Node against ffmpeg's ebur128.
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
const HPF = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] };

function biquad(x, c) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b[0] * x[i] + c.b[1] * x1 + c.b[2] * x2 - c.a[1] * y1 - c.a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// channels: array of Float32Array at 48000 Hz. Returns LUFS, or -Infinity for silence.
export function lufs(channels, sr = 48000) {
  const weighted = channels.map((c) => biquad(biquad(c, SHELF), HPF));
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), n = weighted[0].length, ms = [];
  for (let s = 0; s + block <= n; s += hop) {
    let sum = 0;
    for (const w of weighted) { let p = 0; for (let i = s; i < s + block; i++) p += w[i] * w[i]; sum += p / block; }
    ms.push(sum);
  }
  const loud = (m) => -0.691 + 10 * Math.log10(m);
  const abs = ms.filter((m) => loud(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = loud(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = abs.filter((m) => loud(m) > rel);
  return kept.length ? loud(kept.reduce((a, b) => a + b, 0) / kept.length) : -Infinity;
}

// Gentle limiter: samples below the knee are untouched, louder ones are rounded off so nothing passes the ceiling.
export function softLimit(channels, knee = 0.6, ceiling = Math.pow(10, -1.5 / 20)) {
  const span = ceiling - knee;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > knee) c[i] = Math.sign(c[i]) * (knee + span * Math.tanh((v - knee) / span)); }
}

// Brings the audio to the target loudness in place (two passes, because limiting lowers the level a little). Returns what it did.
export function normalize(channels, target = -14, sr = 48000) {
  const before = lufs(channels, sr);
  if (!isFinite(before)) return { gainDb: 0, before, after: before };
  let total = 0;
  for (let pass = 0; pass < 2; pass++) {
    const now = pass === 0 ? before : lufs(channels, sr);
    const g = Math.max(pass === 0 ? -20 : -3, Math.min(pass === 0 ? 14 : 4, target - now));
    if (Math.abs(g) < 0.1) break;
    const k = Math.pow(10, g / 20);
    for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= k;
    softLimit(channels); total += g;
  }
  return { gainDb: total, before, after: lufs(channels, sr) };
}
