// Saves the project in this browser (IndexedDB): the project JSON and the video files, so a refresh or a closed tab loses nothing.
const DB = "reelloom", V = 1;
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("projects", { keyPath: "id" }); d.createObjectStore("media"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const get = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function saveProject(id, name, project, words) {
  const d = await open(), tx = d.transaction("projects", "readwrite");
  tx.objectStore("projects").put({ id, name, updated: Date.now(), project, words: words || null }); await done(tx); d.close();
}
export async function saveMedia(projectId, mediaId, blob, name) {
  const d = await open(), tx = d.transaction("media", "readwrite"); tx.objectStore("media").put({ blob, name }, projectId + "/" + mediaId); await done(tx); d.close();
}
export async function loadMedia(projectId, mediaId) {
  const d = await open(), v = await get(d.transaction("media").objectStore("media").get(projectId + "/" + mediaId)); d.close();
  return v ? new File([v.blob], v.name || "video.mp4", { type: v.blob.type || "video/mp4" }) : null;
}
export async function latestProject() {
  const d = await open(), all = await get(d.transaction("projects").objectStore("projects").getAll()); d.close();
  return all.sort((a, b) => b.updated - a.updated)[0] || null;
}
export async function deleteProject(id) {
  const d = await open(), tx = d.transaction(["projects", "media"], "readwrite");
  tx.objectStore("projects").delete(id);
  const mk = tx.objectStore("media").openKeyCursor();
  mk.onsuccess = () => { const c = mk.result; if (c) { if (String(c.key).startsWith(id + "/")) tx.objectStore("media").delete(c.key); c.continue(); } };
  await done(tx); d.close();
}

// Every saved project, newest first (without the video files), for the Project Library.
export async function allProjects() {
  const d = await open(), all = await get(d.transaction("projects").objectStore("projects").getAll()); d.close();
  return all.map((r) => ({ id: r.id, name: r.name, updated: r.updated, dur: r.project ? (globalThis.SAModel ? globalThis.SAModel.duration(r.project) : 0) : 0 })).sort((a, b) => b.updated - a.updated);
}
export async function getProject(id) {
  const d = await open(), r = await get(d.transaction("projects").objectStore("projects").get(id)); d.close(); return r || null;
}
