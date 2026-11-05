// Optional AI helper: "bring your own free key". The key stays in this browser (session by default, local storage only if the visitor
// ticks "remember"). Calls go straight from the browser to the provider the visitor picked. There is no proxy and no shared key.
// If anything fails the caller falls back to the rule-based director.
export const PROVIDERS = {
  groq: { label: "Groq (free key at console.groq.com)", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", kind: "openai" },
  openrouter: { label: "OpenRouter (free models)", url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free", kind: "openai" },
  gemini: { label: "Google Gemini (free key at aistudio.google.com)", url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", model: "gemini-2.0-flash", kind: "gemini" },
};
const KEY = "reelloom.ai";

export function loadSettings(storage = globalThis) {
  try {
    const s = JSON.parse(storage.sessionStorage.getItem(KEY) || storage.localStorage.getItem(KEY) || "null");
    return s && PROVIDERS[s.provider] ? s : null;
  } catch { return null; }
}
export function saveSettings(s, remember, storage = globalThis) {
  try { storage.sessionStorage.removeItem(KEY); storage.localStorage.removeItem(KEY); } catch {}
  if (!s || !s.key) return;
  try { (remember ? storage.localStorage : storage.sessionStorage).setItem(KEY, JSON.stringify({ provider: s.provider, key: s.key })); } catch {}
}
export const forget = (storage = globalThis) => saveSettings(null, false, storage);

export function buildPrompt(transcript, pageCount) {
  return `You help edit a short vertical talking-head video. Here is the transcript:\n"""\n${transcript.slice(0, 6000)}\n"""\n` +
    `Reply with JSON only, no other text: {"hook": "a punchy on-screen headline of 3 to 8 words taken from or true to the transcript", ` +
    `"pages": [${Array.from({ length: Math.max(0, pageCount) }, () => '{"title": "2 to 5 word title, put the key word between asterisks like *this*", "quote": "one strong sentence from the transcript"}').join(", ")}]}. ` +
    `Never invent facts that are not in the transcript.`;
}

// Pulls the first JSON object out of the answer and keeps only safe, short strings.
export function parsePlan(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const clean = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const hook = clean(j.hook, 80), pages = Array.isArray(j.pages) ? j.pages.slice(0, 12).map((p) => ({ title: clean(p && p.title, 60), quote: clean(p && p.quote, 200) })) : [];
  if (!hook && !pages.some((p) => p.title || p.quote)) return null;
  return { hook, pages };
}

export async function askForPlan({ provider, key }, transcript, pageCount, fetchFn = globalThis.fetch.bind(globalThis)) {
  const P = PROVIDERS[provider]; if (!P || !key) throw new Error("Pick a provider and paste your key.");
  const prompt = buildPrompt(transcript, pageCount);
  let res;
  if (P.kind === "gemini") {
    res = await fetchFn(P.url + "?key=" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, responseMimeType: "application/json" } }) });
  } else {
    res = await fetchFn(P.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ model: P.model, temperature: 0.4, messages: [{ role: "user", content: prompt }] }) });
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "The provider did not accept that key." : res.status === 429 ? "The free limit is used up for now. Try again later." : "The provider answered " + res.status + ".");
  const j = await res.json();
  const text = P.kind === "gemini" ? j.candidates?.[0]?.content?.parts?.[0]?.text : j.choices?.[0]?.message?.content;
  const plan = parsePlan(text); if (!plan) throw new Error("The answer could not be used.");
  return plan;
}
