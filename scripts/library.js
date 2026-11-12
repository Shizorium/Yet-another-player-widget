import { ID, ROOT, clone, audioPath, youtubeTrack, importPlan, isDownloadActive, isDownloadFinished, isInDownloadQueue } from "./model.js";

export class Library {
  constructor() { this.queue = Promise.resolve(); }
  get playlists() { return game.playlists.filter(p => p.getFlag(ID, "managed") === true); }
  tracks(playlist) { return clone(playlist?.getFlag(ID, "tracks") ?? []); }
  write(callback) {
    const task = this.queue.catch(() => {}).then(() => {
      if (!game.user.isGM) throw new Error("Музыкой управляет ведущий.");
      return callback();
    });
    this.queue = task;
    return task;
  }
  create(name, extra = {}) {
    return this.write(() => this._create(name, extra));
  }
  removePlaylists(ids) {
    return this.write(async () => {
      const targets = [...new Set(ids)].map(id => game.playlists.get(id)).filter(Boolean);
      if (targets.some(p => p.getFlag(ID, "managed") !== true)) throw new Error("Можно удалять только плейлисты этого плеера.");
      let removed = 0;
      try {
        for (const p of targets) {
          await p.delete();
          if (game.playlists.has(p.id)) throw new Error(`Foundry отменил удаление плейлиста «${p.name}».`);
          removed++;
        }
      } finally { await this._normalizePlayback(); }
      return removed;
    });
  }
  async _create(name, extra = {}) {
    name = String(name ?? "").trim();
    if (!name || name.length > 180) throw new Error("Введите название плейлиста до 180 символов.");
    // Playlist.fade requires a strictly positive number in v13; omit it to use Foundry's default.
    const playlist = await CONFIG.Playlist.documentClass.create({ name, mode: CONST.PLAYLIST_MODES.SEQUENTIAL, sorting: "m", channel: "music",
      flags: { [ID]: { managed: true, tracks: [], ...extra } } });
    if (!playlist?.id) throw new Error("Foundry не создал плейлист. Проверьте уведомления Foundry или консоль браузера: создание мог отменить другой модуль.");
    return playlist;
  }
  edit(playlistId, callback) {
    return this.write(async () => {
      const p = game.playlists.get(playlistId);
      if (!p?.getFlag(ID, "managed")) throw new Error("Плейлист уже удалён.");
      const tracks = this.tracks(p);
      const result = await callback(tracks, p);
      await p.setFlag(ID, "tracks", tracks);
      await this._sync(p, tracks);
      return result;
    });
  }
  async _sync(p, tracks) {
    const ready = tracks.filter(t => t.status === "ready" && t.path);
    const creates = ready.filter(t => !p.sounds.has(t.id)).map(t => ({ _id: t.id, name: t.name, path: t.path, volume: 0.8, channel: "music", sort: tracks.indexOf(t) * 1000,
      flags: { [ID]: { trackId: t.id, cover: t.cover ?? "", duration: t.duration } } }));
    if (creates.length) await p.createEmbeddedDocuments("PlaylistSound", creates, { keepId: true });
    const updates = ready.filter(t => p.sounds.has(t.id)).flatMap(t => {
      const s = p.sounds.get(t.id), sort = tracks.indexOf(t) * 1000;
      const update = { _id: t.id };
      if (s.sort !== sort) update.sort = sort;
      if (s.name !== t.name) update.name = t.name;
      if (s.path !== t.path) Object.assign(update, { path: t.path, playing: false, pausedTime: null });
      if (s.getFlag(ID, "cover") !== (t.cover ?? "")) update[`flags.${ID}.cover`] = t.cover ?? "";
      if (s.getFlag(ID, "duration") !== (t.duration ?? null)) update[`flags.${ID}.duration`] = t.duration ?? null;
      return Object.keys(update).length > 1 ? [update] : [];
    });
    if (updates.length) await p.updateEmbeddedDocuments("PlaylistSound", updates);
    const deleted = p.sounds.filter(s => !tracks.some(t => t.id === s.id)).map(s => s.id);
    if (deleted.length) await p.deleteEmbeddedDocuments("PlaylistSound", deleted);
  }
  reconcile() { return this.write(async () => { for (const p of this.playlists) await this._sync(p, this.tracks(p)); }); }
  addYoutube(playlistId, source, name = "") {
    return this.edit(playlistId, tracks => {
      const track = youtubeTrack(source, name, foundry.utils.randomID());
      if (tracks.some(t => t.sourceKey === track.sourceKey)) throw new Error("Этот трек или плейлист уже добавлен.");
      tracks.push(track);
      return track;
    });
  }
  addFile(playlistId, path, name = "", duration = null) {
    path = audioPath(path);
    return this.edit(playlistId, tracks => {
      tracks.push({ id: foundry.utils.randomID(), kind: "track", type: "file", name: name || decodeURIComponent(path.split("/").pop()).replace(/\.[^.]+$/, ""), path, source: path, status: "ready", duration, cover: "", progress: 100 });
    });
  }
  async removeTrack(playlistId, id) {
    await this.edit(playlistId, tracks => { const index = tracks.findIndex(t => t.id === id); if (index >= 0) tracks.splice(index, 1); });
    return this.normalizePlayback();
  }
  moveTrack(playlistId, id, direction) {
    return this.edit(playlistId, tracks => {
      const index = tracks.findIndex(t => t.id === id), next = index + direction;
      if (index >= 0 && next >= 0 && next < tracks.length) [tracks[index], tracks[next]] = [tracks[next], tracks[index]];
    });
  }
  updateTrack(id, callback) {
    return this.write(async () => {
      const playlist = this.playlists.find(p => this.tracks(p).some(t => t.id === id));
      if (!playlist) return false;
      const tracks = this.tracks(playlist);
      await callback(tracks.find(t => t.id === id));
      await playlist.setFlag(ID, "tracks", tracks);
      await this._sync(playlist, tracks);
      return true;
    });
  }
  transferTrack(sourceId, trackId, destinationId, beforeId = null) {
    return this.write(async () => {
      const source = this.playlists.find(p => p.id === sourceId);
      const destination = this.playlists.find(p => p.id === destinationId);
      if (!source || !destination) throw new Error("Один из плейлистов уже удалён.");
      const sourceTracks = this.tracks(source), destinationTracks = source === destination ? sourceTracks : this.tracks(destination);
      const index = sourceTracks.findIndex(t => t.id === trackId);
      if (index < 0) throw new Error("Трек уже удалён или перенесён.");
      if (source === destination && beforeId === trackId) return;
      if (beforeId && !destinationTracks.some(t => t.id === beforeId)) throw new Error("Порядок треков изменился. Перетащите трек ещё раз.");
      if (source !== destination && destinationTracks.some(t => t.id === trackId)) throw new Error("Этот трек уже находится в выбранном плейлисте.");
      const originalSource = clone(sourceTracks), originalDestination = clone(destinationTracks);
      const [track] = sourceTracks.splice(index, 1);
      const insertion = beforeId ? destinationTracks.findIndex(t => t.id === beforeId) : destinationTracks.length;
      destinationTracks.splice(insertion, 0, track);
      if (source === destination) {
        await source.setFlag(ID, "tracks", sourceTracks);
        await this._sync(source, sourceTracks);
        return;
      }
      const sound = source.sounds.get(trackId);
      const playing = Boolean(sound?.playing), paused = sound?.pausedTime != null;
      const position = Math.max(0, playing ? sound?.sound?.currentTime ?? 0 : sound?.pausedTime ?? 0);
      const selection = game.settings.get(ID, "selection") ?? {};
      // Create the destination before removing the source so a failed move cannot lose the track.
      try {
        await destination.setFlag(ID, "tracks", destinationTracks);
        await this._sync(destination, destinationTracks);
        await source.setFlag(ID, "tracks", sourceTracks);
        await this._sync(source, sourceTracks);
      } catch (error) {
        for (const [playlist, tracks] of [[source, originalSource], [destination, originalDestination]]) {
          try { await playlist.setFlag(ID, "tracks", tracks); await this._sync(playlist, tracks); }
          catch (restoreError) { console.error(`${ID} | Не удалось восстановить перенос`, restoreError); }
        }
        throw error;
      }
      const moved = destination.sounds.get(trackId);
      if (moved && sound) {
        const settings = { _id: trackId, repeat: Boolean(sound.repeat), pausedTime: playing || paused ? position : null };
        if (Number.isFinite(sound.volume)) settings.volume = sound.volume;
        await destination.updateEmbeddedDocuments("PlaylistSound", [settings]);
      }
      const relocate = ref => ref?.playlistId === sourceId && ref?.trackId === trackId ? { ...ref, playlistId: destinationId, trackId } : ref;
      const primary = relocate(selection);
      const wasLayer = (selection.layers ?? []).some(ref => ref.playlistId === sourceId && ref.trackId === trackId);
      await this._saveSelection(this._sound(primary) ?? (wasLayer ? null : (playing || paused) ? moved : this.current), (selection.layers ?? []).map(relocate));
      await this._syncMixModes();
      if (playing && moved) await this._updateSound(moved, { playing: true });
    });
  }
  retry(playlistId, id = null) {
    return this.edit(playlistId, tracks => {
      for (const t of tracks) if ((id ? t.id === id : !t.queueDismissed) && (t.status === "error" || (id && t.status === "cancelled"))) {
        if (t.type === "upload") continue;
        try { youtubeTrack(t.source, t.name, t.id); Object.assign(t, { status: "queued", progress: 0, error: "", jobId: null, retry: true, cancelRequested: false, queueDismissed: false, downloadGeneration: (t.downloadGeneration ?? 0) + 1 }); }
        catch (error) { t.error = error.message; }
      }
    });
  }
  clearDownloadQueue() {
    return this.write(async () => {
      let cleared = 0;
      for (const p of this.playlists) {
        const tracks = this.tracks(p), finished = tracks.filter(t => isInDownloadQueue(t) && isDownloadFinished(t));
        if (!finished.length) continue;
        for (const t of finished) t.queueDismissed = true;
        await p.setFlag(ID, "tracks", tracks);
        cleared += finished.length;
      }
      return cleared;
    });
  }
  cancelDownloads(playlistId = null, trackId = null) {
    return this.write(async () => {
      const cancelled = [];
      for (const p of this.playlists.filter(p => !playlistId || p.id === playlistId)) {
        const tracks = this.tracks(p), targets = tracks.filter(t => (!trackId || t.id === trackId) && isDownloadActive(t));
        if (!targets.length) continue;
        for (const t of targets) {
          Object.assign(t, { status: t.type === "youtube" ? "cancelling" : "cancelled", cancelRequested: t.type === "youtube", error: "", retry: false, downloadGeneration: (t.downloadGeneration ?? 0) + 1 });
          cancelled.push(clone(t));
        }
        await p.setFlag(ID, "tracks", tracks);
      }
      return cancelled;
    });
  }
  importYoutube() {
    return this.write(async () => {
      let source;
      try { source = game.settings.get("fvtt-youtube-player", "playlists"); }
      catch { throw new Error("Включите установленный YouTube Player Widget, чтобы прочитать его плейлисты."); }
      const plan = importPlan(source, this.playlists, () => foundry.utils.randomID());
      let count = 0;
      for (const item of plan) {
        const p = item.existing ?? await this._create(item.name, { importKey: item.key });
        await p.setFlag(ID, "tracks", [...this.tracks(p), ...item.tracks]);
        count += item.tracks.length;
      }
      return { playlists: plan.length, tracks: count };
    });
  }
  _ref(sound) { return sound ? { playlistId: sound.parent.id, trackId: sound.id } : {}; }
  _sound(ref) { return this.playlists.find(p => p.id === ref?.playlistId)?.sounds.get(ref.trackId); }
  _alive(sound) { return sound && (sound.playing || sound.pausedTime != null); }
  get layerEntries() {
    return (game.settings.get(ID, "selection")?.layers ?? []).map((ref, i) => ({ slot: ref.slot ?? i + 1, sound: this._sound(ref) }))
      .filter(entry => this._alive(entry.sound)).sort((a, b) => a.slot - b.slot);
  }
  get layers() { return this.layerEntries.map(entry => entry.sound); }
  soundAt(slot = 0) { return slot === 0 ? this.current : this.layerEntries.find(entry => entry.slot === slot)?.sound; }
  volumeFor(slot = 0) {
    const value = game.settings.get(ID, "layerVolumes")?.[slot];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
  }
  setVolume(slot, volume) {
    return this.write(async () => {
      if (!Number.isInteger(slot) || slot < 0) throw new Error("Неизвестный слой.");
      volume = Number(volume);
      if (!Number.isFinite(volume)) throw new Error("Укажите громкость от 0 до 100%.");
      volume = Math.max(0, Math.min(1, volume));
      await game.settings.set(ID, "layerVolumes", { ...game.settings.get(ID, "layerVolumes"), [slot]: volume });
      const sound = this.soundAt(slot);
      if (sound) await this._updateSound(sound, { volume });
    });
  }
  get playing() { return this.playlists.some(p => p.sounds.some(s => s.playing)); }
  get current() {
    const sounds = this.playlists.flatMap(p => p.sounds.contents), selection = game.settings.get(ID, "selection") ?? {};
    const selected = this._sound(selection);
    // A paused primary stays selected while an explicitly added layer keeps playing.
    if (this._alive(selected)) return selected;
    const mainSounds = sounds.filter(s => !this.layers.includes(s));
    return mainSounds.find(s => s.parent.id === selection.playlistId && s.playing)
      ?? selected ?? mainSounds.find(s => s.playing) ?? mainSounds.find(s => s.pausedTime != null);
  }
  async _saveSelection(primary, layers = []) {
    const previous = this.layerEntries;
    const refs = layers.map((ref, i) => ref?.parent ? { ...this._ref(ref), slot: previous.find(entry => entry.sound === ref)?.slot ?? i + 1 } : { ...ref, slot: ref.slot ?? i + 1 });
    const unique = refs.filter((ref, i) => this._alive(this._sound(ref)) && !(ref.playlistId === primary?.parent.id && ref.trackId === primary?.id)
      && refs.findIndex(r => r.playlistId === ref.playlistId && r.trackId === ref.trackId) === i);
    const selection = { ...this._ref(primary), ...(unique.length ? { layers: unique } : {}) };
    if (JSON.stringify(selection) !== JSON.stringify(game.settings.get(ID, "selection") ?? {})) await game.settings.set(ID, "selection", selection);
  }
  async _updateSound(sound, changes) {
    return sound.parent.update({ playing: sound.parent.sounds.some(s => s.id === sound.id ? (changes.playing ?? s.playing) : s.playing), sounds: [{ _id: sound.id, ...changes }] });
  }
  async _syncMixModes() {
    for (const p of this.playlists) {
      const mixing = p.sounds.filter(s => this._alive(s)).length > 1 || this.layers.some(s => s.parent.id === p.id && s !== this.current);
      const original = p.getFlag(ID, "mixMode");
      if (mixing && p.mode !== CONST.PLAYLIST_MODES.SIMULTANEOUS) {
        if (original == null) await p.setFlag(ID, "mixMode", p.mode);
        // Native sequential playback advances/stops its siblings when a sound ends.
        await p.update({ mode: CONST.PLAYLIST_MODES.SIMULTANEOUS });
      } else if (!mixing && original != null) {
        await p.update({ mode: original }); await p.setFlag(ID, "mixMode", null);
      }
    }
  }
  async _stopOtherSounds(keep = null, layers = []) {
    const preserved = new Set([keep, ...layers].filter(Boolean).map(s => `${s.parent.id}:${s.id}`));
    for (const p of this.playlists) {
      const sounds = p.sounds.filter(s => !preserved.has(`${p.id}:${s.id}`) && this._alive(s));
      if (!sounds.length) continue;
      // Native v13 stopAll() leaves pausedTime intact, so clear both document fields explicitly.
      await p.update({ playing: p.sounds.some(s => preserved.has(`${p.id}:${s.id}`) && s.playing), sounds: sounds.map(s => ({ _id: s.id, playing: false, pausedTime: null })) });
    }
  }
  normalizePlayback() {
    return this.write(() => this._normalizePlayback());
  }
  async _normalizePlayback() {
    const primary = this.current, layers = this.layers;
    await this._stopOtherSounds(primary, layers);
    await this._saveSelection(primary, layers);
    await this._syncMixModes();
  }
  play(playlistId, trackId) {
    return this.write(() => this._play(playlistId, trackId));
  }
  async _play(playlistId, trackId) {
    const p = game.playlists.get(playlistId), sound = p?.sounds.get(trackId);
    if (!p?.getFlag(ID, "managed") || !sound) throw new Error("Сначала дождитесь загрузки трека.");
    const layers = this.layers.filter(s => s !== sound);
    await this._stopOtherSounds(sound, layers);
    await this._saveSelection(sound, layers);
    await this._syncMixModes();
    // Updating this sound alone also works when a sibling on another layer is playing.
    return this._updateSound(sound, { playing: true, volume: this.volumeFor(0) });
  }
  addLayer(playlistId, trackId) {
    return this.write(() => this._playLayer(1, playlistId, trackId));
  }
  async _playLayer(slot, playlistId, trackId) {
    const sound = this._sound({ playlistId, trackId }), primary = this.current;
    if (!sound) throw new Error("Сначала дождитесь загрузки трека.");
    if (sound.playing) return;
    if (sound === primary && this._alive(primary)) return;
    const entries = this.layerEntries.filter(entry => entry.slot !== slot && entry.sound !== sound);
    const layers = entries.map(entry => entry.sound);
    // Change mode before playback can end, so a layer cannot advance/stop its siblings.
    if (sound.parent.mode !== CONST.PLAYLIST_MODES.SIMULTANEOUS) {
      if (sound.parent.getFlag(ID, "mixMode") == null) await sound.parent.setFlag(ID, "mixMode", sound.parent.mode);
      await sound.parent.update({ mode: CONST.PLAYLIST_MODES.SIMULTANEOUS });
    }
    await this._stopOtherSounds(primary === sound ? null : primary, layers);
    await this._updateSound(sound, { playing: true, pausedTime: null, volume: this.volumeFor(slot) });
    await this._saveSelection(primary === sound ? null : primary, [...entries.map(entry => ({ ...this._ref(entry.sound), slot: entry.slot })), { playlistId, trackId, slot }]);
    await this._syncMixModes();
  }
  stopTrack(playlistId, trackId) {
    return this.write(() => this._stopTrack(this._sound({ playlistId, trackId })));
  }
  async _stopTrack(sound) {
    if (!sound) return;
    const primary = this.current, layers = this.layers.filter(s => s !== sound);
    await this._updateSound(sound, { playing: false, pausedTime: null });
    await this._saveSelection(primary, layers);
    await this._syncMixModes();
  }
  stopLayer(slot = 0) { return this.write(() => this._stopTrack(this.soundAt(slot))); }
  toggle(slot = 0) {
    return this.write(async () => {
      const sound = this.soundAt(slot);
      if (!sound) return;
      const layers = this.layers;
      if (slot === 0 && !sound.playing) return this._play(sound.parent.id, sound.id);
      await this._stopOtherSounds(this.current, layers);
      await this._saveSelection(this.current, layers);
      return this._updateSound(sound, sound.playing ? { playing: false, pausedTime: Math.max(0, sound.sound?.currentTime ?? 0) } : { playing: true });
    });
  }
  stop() { return this.write(async () => { const primary = this.current; await this._stopOtherSounds(); await this._saveSelection(primary); await this._syncMixModes(); }); }
  step(direction, slot = 0) { return this.write(async () => {
    const sound = this.soundAt(slot);
    if (!sound) return;
    const occupied = [this.current, ...this.layers].filter(s => s && s !== sound);
    const order = sound.parent.playbackOrder ?? this.tracks(sound.parent).filter(t => sound.parent.sounds.has(t.id)).map(t => t.id);
    let index = order.indexOf(sound.id), next;
    for (let i = 0; i < order.length; i++) {
      index = (index + direction + order.length) % order.length;
      const candidate = sound.parent.sounds.get(order[index]);
      if (candidate && !occupied.includes(candidate)) { next = candidate; break; }
    }
    if (!next || next === sound) return;
    if (slot) return this._playLayer(slot, next.parent.id, next.id);
    return this._play(next.parent.id, next.id);
  }); }
  seek(seconds, slot = 0) {
    return this.write(async () => {
      const s = this.soundAt(slot);
      if (!s) return;
      await this._stopOtherSounds(this.current, this.layers);
      const duration = s.sound?.duration ?? s.getFlag(ID, "duration") ?? 0;
      seconds = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, duration - 0.05)));
      const playing = s.playing;
      // Two document updates also restart the native audio source on every connected client.
      await this._updateSound(s, { playing: false, pausedTime: seconds });
      if (playing) await this._updateSound(s, { playing: true, pausedTime: seconds });
    });
  }
}

export async function uploadFile(file, signal) {
  const picker = foundry.applications.apps.FilePicker;
  const path = `${ROOT}/storage/uploads`;
  // The module ships with this directory; unique names prevent replacing existing tracks.
  const safeName = `${foundry.utils.randomID()}-${file.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}`;
  const upload = new File([file], safeName, { type: file.type });
  const endpoint = (picker.implementation ?? picker).uploadURL;
  let result;
  if (signal && endpoint) {
    const body = new FormData(); body.set("source", "data"); body.set("target", path); body.set("upload", upload);
    const response = await fetch(endpoint, { method: "POST", body, signal });
    if (!response.ok) throw new Error(`Ошибка загрузки файла: ${response.status}`);
    result = await response.json();
  } else {
    if (signal?.aborted) throw signal.reason;
    result = await picker.upload("data", path, upload, {}, { notify: false });
  }
  if (!result?.path) throw new Error(result?.error || "Foundry не сохранил файл.");
  return result.path;
}

export function readDuration(path, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const audio = document.createElement("audio");
    const abort = () => { finish(null); reject(signal.reason); };
    const finish = value => { clearTimeout(timer); signal?.removeEventListener("abort", abort); audio.onloadedmetadata = audio.onerror = null; audio.removeAttribute("src"); audio.load(); if (!signal?.aborted) resolve(value); };
    const timer = setTimeout(() => finish(null), 12000);
    signal?.addEventListener("abort", abort, { once: true });
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
    audio.src = path;
  });
}
