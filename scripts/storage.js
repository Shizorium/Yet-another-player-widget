import { ID } from "./model.js";

export class Storage {
  constructor(library, downloads) { this.library = library; this.downloads = downloads; this.busy = false; }
  guard() {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) throw new Error("Хранилище меняет активный ведущий. Откройте плеер у него.");
  }
  async request(endpoint, body) {
    this.guard();
    try { return await this.downloads.request(endpoint, body, 120000); }
    catch (error) { if (/Неизвестный адрес/.test(error.message)) throw new Error("Для смены хранилища обновите и перезапустите helper/Helper.exe на компьютере сервера Foundry."); throw error; }
  }
  status(playlist = null) { return this.request(`/storage?world=${encodeURIComponent(game.world.id)}${playlist ? `&playlist=${encodeURIComponent(playlist)}` : ""}`); }
  tracks(playlist = null) {
    return this.library.playlists.filter(p => !playlist || p.id === playlist).flatMap(p => this.library.tracks(p).filter(t => t.path).map(t => ({ playlist: p.id, id: t.id, path: t.path, cover: t.cover || "", name: t.name })));
  }
  references() {
    return [...game.playlists.contents.flatMap(p => p.sounds.contents.map(s => s.path)), ...this.tracks().flatMap(t => [t.path, t.cover])].filter(Boolean);
  }
  async complete(status, progress) {
    let job = status.job;
    while (job && ["queued", "moving"].includes(job.status)) {
      progress?.(job); await new Promise(resolve => setTimeout(resolve, 700)); status = await this.status(job.playlist); job = status.job;
    }
    if (!job || job.finished) return status;
    if (job.persistError) throw new Error("Не удалось сохранить состояние переноса. Освободите место для настроек помощника и перезапустите его. Исходники сохранены.");
    progress?.(job);
    await this.library.applyStorage(job.results);
    const finished = await this.request("/storage/finish", { world: game.world.id, id: job.id, references: this.references() });
    if (job.errors.length) throw new Error(`Перенесено: ${job.results.length} из ${job.total}. ${job.errors.slice(0,3).map(error => `${error.name ? error.name + ": " : ""}${error.message}`).join(" ")} Исправьте причину и повторите перенос. Уже перенесённые треки доступны.`);
    return finished;
  }
  async change(playlist, root, progress, resume = false, tracks = null) {
    this.guard(); if (this.busy) throw new Error("Перенос уже выполняется.");
    this.busy = true; this.downloads.storageBusy = true;
    try {
      while (this.downloads.busy) await new Promise(resolve => setTimeout(resolve, 50));
      await game.settings.set(ID, "storageEnabled", true);
      let status = await this.status(playlist);
      if (status.job && !status.job.finished) status = await this.complete(status, progress);
      if (resume) return status;
      status = await this.request("/storage/move", { world: game.world.id, playlist, root, tracks: tracks ?? this.tracks(playlist), configure: tracks ? false : true });
      return await this.complete(status, progress);
    } finally { this.busy = false; this.downloads.storageBusy = false; this.downloads.changed(); }
  }
  async place(playlist, trackId) {
    if (!game.settings.get(ID, "storageEnabled")) return;
    const tracks = this.tracks(playlist).filter(t => t.id === trackId);
    if (tracks.length) await this.change(playlist, null, null, false, tracks);
  }
  async uploadTarget(playlist, track) {
    if (!game.settings.get(ID, "storageEnabled")) return null;
    if (this.busy) throw new Error("Дождитесь завершения переноса хранилища.");
    const result = await this.request("/storage/prepare", { world: game.world.id, playlist, track }); return result.prefix;
  }
}
