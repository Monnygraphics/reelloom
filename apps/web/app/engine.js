// One drawing routine for the whole project, used by the live preview and by the export, so they cannot drift.
// drawProject(g, P, t, W, H, env): draws project time t into a W x H canvas context.
//   env.frame(clip, t) -> { img, w, h } | null   the picture of a video/image clip at project time t (null = not ready yet)
// Everything is authored in the project's own size (1080 x 1920 for a reel) and scaled to W x H.
// Needs the project model (model.js) as globalThis.SAModel.

export const FONT_FILES = [
  ["Montserrat", 700, "montserrat-700.woff2"], ["Poppins", 500, "poppins-500.woff2"], ["Inter", 600, "inter-600.woff2"],
  ["Anton", 400, "anton-400.woff2"], ["Libre Baskerville", 400, "libre-baskerville-400.woff2"], ["Cormorant Garamond", 700, "cormorant-garamond-700.woff2"],
];
export const hasFamily = (f) => f === "Arial" || FONT_FILES.some(([n]) => n.toLowerCase() === String(f).toLowerCase());

let fontsLoading = null;
// Loads the bundled open-licence fonts (SIL OFL). Safe to call many times.
export function loadFonts(base = new URL("./fonts/", import.meta.url).href) {
  if (fontsLoading) return fontsLoading;
  fontsLoading = Promise.all(FONT_FILES.map(async ([name, weight, file]) => {
    try { const ff = new FontFace(name, `url(${base}${file})`, { weight: String(weight) }); await ff.load(); document.fonts.add(ff); } catch (e) { console.warn("font", name, e); }
  }));
  return fontsLoading;
}

const ACCENT = "#F2A93A";
const fam = (c) => (c.font ? `"${c.font}", Arial` : "Arial") + ", sans-serif";

function rr(g, x, y, w, h, r, fill) { g.beginPath(); g.roundRect(x, y, w, h, Math.min(r, h / 2)); g.fillStyle = fill; g.fill(); }

// Caption: the shared layout from the model, then pill, every word, and the spoken word on top.
export function drawCaption(g, P, c, t) {
  const M = globalThis.SAModel, weight = c.fw || 700;
  const fontOf = (sz) => `${weight} ${sz}px ${fam(c)}`;
  const words = c.upper ? c.words.map((w) => Object.assign({}, w, { w: w.w.toUpperCase() })) : c.words;
  const cc = Object.assign({}, c, { words });
  g.fontKerning = "normal"; g.textAlign = "left"; g.textBaseline = "alphabetic";
  const L = M.captionLayout(cc, P.canvas, (s, sz) => { g.font = fontOf(sz); return g.measureText(s).width; });
  g.font = fontOf(L.size);
  if (L.pill) {
    rr(g, L.pill.x, L.pill.y, L.pill.w, L.pill.h, L.pill.r, (c.pill === "light" ? "rgba(255,255,255," : "rgba(16,16,16,") + (c.pillA == null ? 0.46 : c.pillA) + ")");
    g.beginPath(); g.roundRect(L.pill.x + 1, L.pill.y + 1, L.pill.w - 2, L.pill.h - 2, L.pill.r); g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.26)"; g.stroke();
  }
  const put = (str, x, colour) => {
    if (c.shadow) { g.shadowColor = "rgba(0,0,0,.55)"; g.shadowOffsetX = Math.max(1, 2 * L.k); g.shadowOffsetY = Math.max(1, 3 * L.k); g.shadowBlur = 4 * L.k; }
    if (c.outline) { g.lineJoin = "round"; g.lineWidth = 2 * Math.max(2, Math.round(L.size / 14)); g.strokeStyle = "rgba(0,0,0,.85)"; g.strokeText(str, x, L.base); }
    g.fillStyle = colour; g.fillText(str, x, L.base); g.shadowColor = "transparent"; g.shadowOffsetX = g.shadowOffsetY = g.shadowBlur = 0;
  };
  L.words.forEach((w) => put(w.w, w.x, c.color || "#fff"));
  if (c.hi) {
    const rel = t - c.start;
    L.words.forEach((w, i) => {
      const to = i < L.words.length - 1 ? L.words[i + 1].s : w.e + 0.15;
      if (rel >= w.s && rel < to) {
        if (L.wordPill) rr(g, L.wordPill[i].x, L.wordPill[i].y, L.wordPill[i].w, L.wordPill[i].h, L.wordPill[i].r, c.hi);
        put(w.w, w.x, L.wordPill ? c.color || "#fff" : c.hi);
      }
    });
  }
  return L;
}

export function drawText(g, P, c) {
  const { w: W, h: H } = P.canvas, size = c.size || 72, lines = String(c.text || "").split("\n");
  g.font = `${c.fw || 700} ${size}px ${fam(c)}`; g.textAlign = "center"; g.textBaseline = "middle";
  const lh = size * 1.2, cx = (c.x == null ? 0.5 : c.x) * W, cy = (c.y == null ? 0.8 : c.y) * H, top = cy - (lh * lines.length) / 2;
  if (c.bg) {
    const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + size / 2;
    g.fillStyle = c.bg + Math.round((c.bgA == null ? 0.6 : c.bgA) * 255).toString(16).padStart(2, "0");
    g.fillRect(cx - bw / 2, top - size / 4, bw, lh * lines.length + size / 2);
  } else { g.lineJoin = "round"; g.lineWidth = Math.max(4, size / 7); g.strokeStyle = "rgba(0,0,0,.85)"; lines.forEach((l, i) => g.strokeText(l, cx, top + lh * (i + 0.5))); }
  g.fillStyle = c.color || "#fff"; lines.forEach((l, i) => g.fillText(l, cx, top + lh * (i + 0.5)));
}

// Wraps text and draws it centred. *word* marks the accent colour.
export function drawRich(g, text, cx, y, maxW, size, lh, colour, accent = ACCENT) {
  g.font = `700 ${size}px "Montserrat", Arial, sans-serif`; g.textAlign = "left"; g.textBaseline = "alphabetic";
  const toks = []; let inAcc = false;
  for (const raw of String(text || "").split(/\s+/).filter(Boolean)) {
    const word = raw.replace(/\*/g, ""), starts = raw.startsWith("*") && word.length > 0, ends = raw.endsWith("*") && word.length > 0;
    const acc = inAcc || starts;
    if (starts && !ends) inAcc = true; else if (ends) inAcc = false;
    if (word) toks.push({ w: word, acc });
  }
  const sp = g.measureText(" ").width, lines = []; let cur = [], cw = 0;
  for (const tk of toks) {
    const w = g.measureText(tk.w).width;
    if (cur.length && cw + sp + w > maxW) { lines.push({ ws: cur, w: cw }); cur = []; cw = 0; }
    cw += (cur.length ? sp : 0) + w; cur.push(Object.assign({ mw: w }, tk));
  }
  if (cur.length) lines.push({ ws: cur, w: cw });
  lines.forEach((ln, i) => {
    let x = cx - ln.w / 2; const yy = y + i * lh;
    ln.ws.forEach((tk) => { g.fillStyle = tk.acc ? accent : colour; g.fillText(tk.w, x, yy); x += tk.mw + sp; });
  });
  return lines.length;
}

const ease = (p) => p * p * (3 - 2 * p);
const PIP = { crop: [0, 330, 1080, 832], box: [60, 1110, 960, 740, 34] };

// A split explainer page: plain background, the page content, and the speaker in a rounded picture at the bottom.
export function drawPage(g, P, pg, t, snap) {
  const { w: W, h: H } = P.canvas, dark = pg.style !== "light", fg = dark ? "#F5F2EA" : "#17171A", mute = dark ? "rgba(245,242,234,.7)" : "rgba(23,23,26,.65)";
  const a = Math.max(0, Math.min(1, (t - pg.start) / 0.18, (pg.end - t) / 0.18)), prog = Math.min(1, Math.max(0, (t - pg.start) / 0.5));
  g.save(); g.globalAlpha = a; g.fillStyle = dark ? "#0A0A0C" : "#EDEBE8"; g.fillRect(0, 0, W, H);
  const rise = (1 - ease(prog)) * 40;
  if (pg.closing) {
    g.fillStyle = ACCENT; g.font = '700 40px "Montserrat", Arial, sans-serif'; g.textAlign = "center"; g.textBaseline = "alphabetic";
    if ("letterSpacing" in g) g.letterSpacing = "8px"; g.fillText(String(pg.closing.kicker || "THE LESSON").toUpperCase(), W / 2, 330 + rise); if ("letterSpacing" in g) g.letterSpacing = "0px";
    drawRich(g, pg.closing.text, W / 2, 470 + rise, 880, 78, 100, fg);
  } else {
    if (pg.text) drawRich(g, pg.text, W / 2, 250 + rise, 900, 84, 104, fg);
    const m = pg.motion || {};
    if (m.type === "counter") {
      const v = Math.round((m.value || 0) * ease(Math.min(1, Math.max(0, (t - pg.start - 0.2) / 1.4))));
      g.fillStyle = ACCENT; g.font = '800 200px "Montserrat", Arial, sans-serif'; g.textAlign = "center"; g.textBaseline = "alphabetic";
      g.fillText((m.prefix || "") + v.toLocaleString("en-US") + (m.suffix || ""), W / 2, 640 + rise);
      if (m.caption) drawRich(g, m.caption, W / 2, 760 + rise, 860, 52, 66, mute, mute);
    } else if (m.type === "quote" && m.quote) {
      g.fillStyle = ACCENT; g.font = '700 150px "Montserrat", Arial, sans-serif'; g.textAlign = "center"; g.fillText("“", W / 2, 520 + rise);
      drawRich(g, m.quote, W / 2, 640 + rise, 860, 54, 72, fg);
    } else if (m.type === "points" && Array.isArray(m.items)) {
      m.items.slice(0, 4).forEach((it, i) => { const on = Math.min(1, Math.max(0, (t - pg.start - 0.3 - i * 0.35) / 0.3)); g.globalAlpha = a * on; drawRich(g, "*" + (i + 1) + ".* " + it, W / 2, 520 + i * 120 + rise, 860, 54, 66, fg); });
    }
  }
  g.restore();
  if (pg.pip !== false && snap) {
    const k = snap.width / W, [sx, sy, sw, sh] = PIP.crop, [dx, dy, dw, dh, r] = PIP.box;
    g.save(); g.globalAlpha = a; g.beginPath(); g.roundRect(dx, dy, dw, dh, r); g.clip(); g.drawImage(snap, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh); g.restore();
  }
}

const pageAt = (P, t) => (P.pages || []).find((p) => t >= p.start && t < p.end);
export const PAGE_CAPTION_Y = 0.5391;
let snapCv = null;

export function drawProject(g, P, t, W, H, env) {
  const M = globalThis.SAModel, { w: PW, h: PH } = P.canvas, k = W / PW;
  g.save(); g.setTransform(k, 0, 0, H / PH, 0, 0);
  g.fillStyle = "#000"; g.fillRect(0, 0, PW, PH);
  const vis = M.visibleAt(P, t), isText = (c) => c.kind === "text";
  const alphaOf = (clip) => {
    let alpha = 1, dx = 0;
    if (clip.trIn) { const p = Math.min(1, (t - clip.start) / clip.trIn.dur); alpha = p; dx = clip.trIn.type === "slideleft" ? (1 - p) * PW : clip.trIn.type === "slideright" ? -(1 - p) * PW : 0; if (dx) alpha = 1; }
    if (clip.trOut) alpha = Math.min(alpha, Math.max(0, (M.end(clip) - t) / clip.trOut.dur));
    return { alpha: Math.max(0, Math.min(1, alpha)), dx };
  };
  for (const { clip } of vis) {
    if (isText(clip)) continue;
    const f = env.frame(clip, t); if (!f) continue;
    const { alpha, dx } = alphaOf(clip), w = f.w, h = f.h, z = clip.zoom;
    const fs0 = (clip.fit === "cover" ? Math.max : Math.min)(PW / w, PH / h), s = fs0 * M.zoomAt(clip, t), gr = clip.grade;
    g.globalAlpha = alpha; g.filter = gr ? `contrast(${gr.contrast}) saturate(${gr.saturation}) brightness(${1 + (gr.brightness || 0)})` : "none";
    const px = z && z.fx != null ? (PW - w * fs0) / 2 + z.fx * w * fs0 - z.fx * w * s : (PW - w * s) / 2;
    const py = z && z.fx != null ? (PH - h * fs0) / 2 + z.fy * h * fs0 - z.fy * h * s : (PH - h * s) / 2;   // the focus point stays put while zooming
    g.drawImage(f.img, px + dx, py, w * s, h * s);
    g.filter = "none"; g.globalAlpha = 1;
  }
  const pg = PW === 1080 && PH === 1920 ? pageAt(P, t) : null;   // pages and the picture window are designed for 9:16
  if (pg) {
    if (!snapCv) snapCv = document.createElement("canvas");
    snapCv.width = g.canvas.width; snapCv.height = g.canvas.height;
    const sg = snapCv.getContext("2d"); sg.setTransform(1, 0, 0, 1, 0, 0); sg.drawImage(g.canvas, 0, 0);
    drawPage(g, P, pg, t, snapCv);
  }
  for (const { clip } of vis) {
    if (!isText(clip)) continue;
    g.globalAlpha = alphaOf(clip).alpha;
    if (M.isCaption(clip)) drawCaption(g, P, pg ? Object.assign({}, clip, { y: PAGE_CAPTION_Y }) : clip, t); else drawText(g, P, clip);
    g.globalAlpha = 1;
  }
  g.restore();
}
