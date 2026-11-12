import { ID, youtubeTrack, clone, isDownloadActive } from "./model.js";

export class Downloads {
  constructor(library, changed) { this.library = library; this.changed = changed; this.online = false; this.message = "Помощник не подключён"; this.busy = false; }
  get config() { return game.settings.get(ID, "helper"); }
  async request(endpoint, body) {
    const { url, token } = this.config;
    if (!url || !token) throw new Error("Откройте настройки плеера и подключите помощник загрузок.");
    let base;
    try { base = new URL(url); } catch { throw new Error("Некорректный адрес помощника."); }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Используйте HTTP(S)-адрес помощника.");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}${endpoint}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, credentials: "omit", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Ошибка помощника: ${response.status}`);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Помощник не ответил за 15 секунд.");
      if (error instanceof TypeError) throw new Error("Нет связи с помощником. Запустите Start-Helper.cmd и проверьте адрес, ключ и разрешение браузера на локальную сеть.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async check() {
    try { await this.request("/health"); this.online = true; this.message = "Помощник подключён"; }
    catch (error) { this.online = false; this.message = error.message; throw error; }
    finally { this.changed(); }
  }
  flushCancellations() {
    if (this.cancelSync) return this.cancelSync;
    this.cancelSync = this._flushCancellations().finally(() => { this.cancelSync = null; });
    return this.cancelSync;
  }
  async _flushCancellations() {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    const pending = this.library.playlists.flatMap(p => this.library.tracks(p)).filter(t => t.type === "youtube" && t.cancelRequested);
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      try {
        await this.request("/jobs/cancel", { world: game.world.id, tasks: batch.map(t => ({ key: `track:${t.id}`, jobId: t.jobId ?? null })) });
        for (const item of batch) await this.library.updateTrack(item.id, t => {
          if (t.cancelRequested && t.downloadGeneration === item.downloadGeneration) Object.assign(t, { status: "cancelled", cancelRequested: false, error: "" });
        });
        this.online = true; this.message = "Помощник подключён";
      } catch (error) {
        const message = /Неизвестный адрес/.test(error.message) ? "Перезапустите помощник Start-Helper.cmd: для отмены нужна обновлённая версия." : `Отмена ожидает подключения помощника. ${error.message}`;
        for (const item of batch) await this.library.updateTrack(item.id, t => { if (t.cancelRequested) t.error = message; });
        this.online = false; this.message = message;
        break;
      }
    }
    this.changed();
  }
  async reconcileJobs(jobs) {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return 0;
    const orphan = job => {
      if (job.world && job.world !== game.world.id) return false;
      if (!["queued", "resolving", "downloading", "processing"].includes(job.status)) return false;
      const trackId = job.key?.match(/^track:([\w-]{1,100})$/)?.[1] ?? job.key?.match(/^[A-Za-z0-9]{16}:([A-Za-z0-9]{16})$/)?.[1];
      if (!trackId) return false;
      return !this.library.playlists.some(p => (p.getFlag(ID, "tracks") ?? []).some(t => t.id === trackId || t.jobId === job.id));
    };
    const candidates = jobs.filter(orphan);
    let removed = 0;
    for (let i = 0; i < candidates.length; i += 100) {
      // Recheck the live documents after every request, including tracks moved between playlists.
      const batch = candidates.slice(i, i + 100).filter(orphan);
      if (!batch.length) continue;
      await this.request("/jobs/cancel", { world: game.world.id, tasks: batch.map(job => ({ key: job.key, jobId: job.id })) });
      removed += batch.length;
    }
    return removed;
  }
  async tick() {
    // Only one GM submits and applies jobs, including when multiple GM clients are connected.
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || this.busy) return;
    this.busy = true;
    try {
      if (!this.config.token) return;
      const world = game.world.id;
      await this.flushCancellations();
      let { jobs } = await this.request(`/jobs?world=${encodeURIComponent(world)}`);
      if (await this.reconcileJobs(jobs)) ({ jobs } = await this.request(`/jobs?world=${encodeURIComponent(world)}`));
      this.online = true; this.message = "Помощник подключён";
      for (const p of this.library.playlists) {
        const snapshot = this.library.tracks(p);
        const patches = new Map();
        for (const track of snapshot) {
          const existing = track.retry ? null : jobs.find(j => j.id === track.jobId || j.key === `track:${track.id}` || j.key === `${p.id}:${track.id}`);
          const recovered = track.status === "error" && existing?.status === "ready";
          if (track.type !== "youtube" || (!isDownloadActive(track) && !recovered) || track.cancelRequested) continue;
          const latest = this.library.playlists.map(p => (p.getFlag(ID, "tracks") ?? []).find(t => t.id === track.id)).find(Boolean);
          if (!latest || (!isDownloadActive(latest) && !(recovered && latest.status === "error")) || latest.cancelRequested || latest.downloadGeneration !== track.downloadGeneration) continue;
          let job = existing;
          if (!job) job = await this.request("/jobs", { world, key: `track:${track.id}`, kind: track.kind === "playlist" ? "resolve" : "download", url: track.source, retry: Boolean(track.retry) });
          const patch = { jobId: job.id, status: job.status, progress: Math.round(job.progress || 0), error: job.error || "", retry: false };
          if (job.status === "ready") {
            if (track.kind === "playlist") patch.entries = job.result.entries;
            else Object.assign(patch, job.result, { name: track.customName ? track.name : job.result.name || track.name, status: "ready" });
          }
          if (patch.entries || Object.entries(patch).some(([key, value]) => track[key] !== value)) patches.set(track.id, { generation: track.downloadGeneration, patch });
        }
        if (patches.size) await this.library.edit(p.id, tracks => {
          for (let i = tracks.length - 1; i >= 0; i--) {
            const t = tracks[i], record = patches.get(t.id), patch = record?.patch;
            if (!patch || (!isDownloadActive(t) && !(t.status === "error" && patch.status === "ready")) || t.cancelRequested || t.downloadGeneration !== record.generation) continue;
            if (patch.entries) {
              const seen = new Set(tracks.map(t => t.sourceKey));
              const entries = [];
              for (const entry of patch.entries) {
                if (entry.unavailable) { entries.push({ id: foundry.utils.randomID(), kind: "track", type: "youtube", name: entry.name, source: "", status: "error", error: "Видео удалено, закрыто или недоступно.", progress: 0 }); continue; }
                if (seen.has(entry.sourceKey)) continue;
                const added = youtubeTrack(entry.source, entry.name, foundry.utils.randomID());
                Object.assign(added, { duration: entry.duration, cover: entry.cover }); entries.push(added); seen.add(added.sourceKey);
              }
              tracks.splice(i, 1, ...entries);
            } else Object.assign(t, clone(patch));
          }
        });
      }
    } catch (error) { this.online = false; this.message = error.message; }
    finally { this.busy = false; this.changed(); }
  }
}
