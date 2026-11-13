import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ID } from "../scripts/model.js";

const AUDIO = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a", ".aac", ".webm", ".opus", ".mp4", ".aiff"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const key = value => typeof value === "string" && /^[\w-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); };
const stat = async file => { try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const hash = async file => { const digest = crypto.createHash("sha256"); for await (const part of createReadStream(file)) digest.update(part); return digest.digest("hex"); };

// Each public directory contains one track. A junction exposes only that directory,
// never the parent selected by the user. Stable URLs survive subsequent disk moves.
export class MediaStorage {
  constructor({ moduleDir, stateDir, configFile, idle = async () => {}, changed = () => {} }) {
    this.moduleDir = path.resolve(moduleDir); this.dataDir = path.dirname(path.dirname(this.moduleDir));
    this.publicDir = path.join(this.dataDir, "yapw-media"); this.configFile = configFile ?? path.join(stateDir, "storage.json");
    this.idle = idle; this.changed = changed; this.config = { worlds: {} }; this.busy = false; this.writes = Promise.resolve();
  }
  async init() {
    try { this.config = JSON.parse(await fs.readFile(this.configFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error(`Не удалось прочитать настройки хранилища: ${error.message}`); }
    if (!this.config?.worlds || typeof this.config.worlds !== "object") throw new Error("Повреждены настройки хранилища.");
    if (this.config.switch) await this.recoverSwitch();
    for (const item of this.config.job?.cleanup ?? []) if (item.alias && item.backup && !await stat(item.alias) && await stat(item.backup)) {
      this.validateAlias(item); await fs.rename(item.backup, item.alias);
    }
    const job = this.config.job;
    if (job && ["queued", "moving"].includes(job.status)) { job.status = "error"; job.errors.push({ message: "Помощник был закрыт во время переноса. Завершите применение скопированных файлов, затем повторите перенос." }); await this.save(); }
  }
  save() {
    const text = JSON.stringify(this.config, null, 2);
    return this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.configFile), { recursive: true });
      await fs.writeFile(`${this.configFile}.tmp`, text, { mode: 0o600 }); await fs.rename(`${this.configFile}.tmp`, this.configFile);
    });
  }
  validate(world, playlist, track) { if (!key(world) || (playlist != null && !key(playlist)) || (track != null && !key(track))) throw new Error("Некорректный идентификатор хранилища."); }
  world(world) { this.validate(world); return this.config.worlds[world] ?? { enabled: false, root: null, playlists: {} }; }
  root(world, playlist) { const state = this.world(world); return Object.hasOwn(state.playlists, playlist) ? state.playlists[playlist] : state.root; }
  location(world, playlist, track) {
    this.validate(world, playlist, track);
    const root = this.root(world, playlist), anchor = path.join(this.publicDir, world, track);
    return { anchor, directory: root ? path.join(root, "YetAnotherPlayerWidget", world, track) : anchor, prefix: `yapw-media/${world}/${track}` };
  }
  status(world, playlist = null) {
    this.validate(world, playlist); const state = this.world(world), root = this.root(world, playlist);
    const job = this.config.job?.world === world ? this.config.job : null;
    return { enabled: state.enabled, root: state.root, override: playlist != null && Object.hasOwn(state.playlists, playlist), playlistRoot: root, defaultDirectory: this.publicDir,
      directory: root ? path.join(root, "YetAnotherPlayerWidget", world) : path.join(this.publicDir, world), configFile: this.configFile, busy: this.busy,
      job: job ? { ...job, cleanup: undefined, tracks: undefined } : null };
  }
  async owner(directory, world, track) {
    try { const info = JSON.parse(await fs.readFile(path.join(directory, ".yapw.json"), "utf8")); return info.module === ID && info.world === world && info.track === track; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  }
  async mark(directory, world, track) { await fs.writeFile(path.join(directory, ".yapw.json"), JSON.stringify({ module: ID, world, track }), { flag: "wx" }); }
  async recoverSwitch() {
    const { world, track, anchor, backup, directory, stage, hadAnchor } = this.config.switch;
    this.validate(world, null, track);
    if (anchor !== path.join(this.publicDir, world, track) || !backup.startsWith(`${anchor}.previous-`) || !stage.startsWith(`${directory}.moving-`)) throw new Error("Неожиданный путь незавершённого переноса.");
    const current = await stat(anchor), previous = await stat(backup);
    if (current && (previous || !hadAnchor)) { if (current.isSymbolicLink()) await fs.unlink(anchor); else await this.removeOwned(anchor, world, track); }
    if (previous) await fs.rename(backup, anchor);
    if (directory !== anchor && await stat(directory)) await this.removeOwned(directory, world, track);
    if (await stat(stage)) await this.removeOwned(stage, world, track);
    delete this.config.switch; await this.save();
  }
  async prepare(world, playlist, track) {
    if (this.busy) throw new Error("Дождитесь завершения переноса хранилища.");
    const location = this.location(world, playlist, track);
    await this.ensure(location, world, track);
    return { directory: location.directory, prefix: location.prefix };
  }
  async ensure(location, world, track) {
    const { directory, anchor } = location, entry = await stat(anchor);
    if (entry) {
      if (!await this.owner(anchor, world, track)) throw new Error("Папка трека уже занята посторонними файлами.");
      if (path.resolve(await fs.realpath(anchor)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error("Место хранения этого трека изменилось. Откройте «Хранилище» и выполните перенос плейлиста.");
      return;
    }
    if (await stat(directory)) { if (!await this.owner(directory, world, track)) throw new Error("Папка назначения уже занята посторонними файлами."); }
    else { await fs.mkdir(directory, { recursive: true }); await this.mark(directory, world, track); }
    if (directory !== anchor) { await fs.mkdir(path.dirname(anchor), { recursive: true }); await fs.symlink(directory, anchor, process.platform === "win32" ? "junction" : "dir"); }
  }
  local(url, extensions) {
    if (!url || /^https?:\/\//i.test(url) || /^data:/i.test(url)) return null;
    let relative; try { relative = decodeURIComponent(url); } catch { throw new Error("Некорректный путь медиафайла."); }
    if (relative.includes("\\") || relative.includes(":") || relative.includes("\0") || relative.startsWith("/") || relative.split("/").some(part => part === ".." || part === ".")) throw new Error("Разрешены только пути медиафайлов внутри Foundry Data.");
    const file = path.resolve(this.dataDir, relative);
    if (!inside(this.dataDir, file) || !extensions.has(path.extname(file).toLowerCase())) throw new Error("Этот тип файла нельзя переносить в музыкальное хранилище.");
    return { file, url, extension: path.extname(file).toLowerCase() };
  }
  async copy(source, destination) {
    const info = await fs.stat(source); if (!info.isFile() || !info.size) throw new Error("Исходный медиафайл отсутствует или пуст.");
    await fs.copyFile(source, destination, 1);
    const output = await fs.stat(destination);
    if (info.size !== output.size || await hash(source) !== await hash(destination)) throw new Error("Проверка скопированного файла не пройдена. Исходный файл сохранён.");
  }
  async removeOwned(directory, world, track) {
    if (!await this.owner(directory, world, track)) throw new Error("Не удалось подтвердить владельца папки трека; исходные файлы сохранены.");
    // Delete only the files created by this storage, with no recursion through links.
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (!item.isFile() || !(/^(audio(?:-[\w-]+)?|cover)\.[\w]+$/.test(item.name) || [".yapw.json", "track.mp3", "track.jpg", "track.info.json", "track.complete.json"].includes(item.name))) throw new Error("В старой папке есть посторонние файлы; она сохранена.");
    }
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
  async relocate(world, track) {
    const audio = this.local(track.path, AUDIO);
    if (!audio) return null;
    const cover = this.local(track.cover, IMAGE), location = this.location(world, track.playlist, track.id), { anchor, directory, prefix } = location;
    const oldAnchor = await stat(anchor), oldDirectory = oldAnchor ? await fs.realpath(anchor) : null;
    if (oldAnchor && !await this.owner(anchor, world, track.id)) throw new Error("Публичная папка трека занята посторонними файлами.");
    const stable = track.path.startsWith(`${prefix}/`);
    if (oldDirectory && path.resolve(oldDirectory).toLowerCase() === path.resolve(directory).toLowerCase() && stable) return { id: track.id, oldPath: track.path, oldCover: track.cover, path: track.path, cover: track.cover, playlist: track.playlist };
    const stage = `${directory}.moving-${crypto.randomBytes(8).toString("hex")}`;
    const backup = `${anchor}.previous-${crypto.randomBytes(8).toString("hex")}`;
    let published = false, backedUp = false;
    const youtubeDirectory = path.dirname(audio.file);
    const legacyYoutube = path.dirname(youtubeDirectory) === path.join(this.moduleDir, "storage", "youtube") && /^[\w-]{11}$/.test(path.basename(youtubeDirectory)) && path.basename(audio.file) === "track.mp3";
    const audioName = stable || legacyYoutube ? path.basename(audio.file) : `audio${audio.extension}`;
    const coverName = cover ? (stable && track.cover.startsWith(`${prefix}/`) || legacyYoutube && path.dirname(cover.file) === youtubeDirectory ? path.basename(cover.file) : `cover${cover.extension}`) : null;
    try {
      if (await stat(directory) && directory !== anchor) throw new Error("Папка назначения для трека уже существует. Выберите другое хранилище или освободите эту папку вручную.");
      this.config.switch = { world, track: track.id, anchor, backup, stage, directory, hadAnchor: Boolean(oldAnchor) }; await this.save();
      await fs.mkdir(stage, { recursive: true }); await this.mark(stage, world, track.id);
      await this.copy(audio.file, path.join(stage, audioName));
      if (cover) await this.copy(cover.file, path.join(stage, coverName));
      // Download cache metadata is safe and required to reuse MP3s after restart.
      if (stable) for (const name of ["track.info.json", "track.complete.json"]) {
        try { await fs.copyFile(path.join(anchor, name), path.join(stage, name), 1); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (legacyYoutube) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(youtubeDirectory, "track.info.json"), "utf8"));
          const info = { id: path.basename(youtubeDirectory), title: String(raw.title || track.name || track.id), duration: Number.isFinite(raw.duration) ? raw.duration : null };
          await fs.writeFile(path.join(stage, "track.info.json"), JSON.stringify(info));
          await fs.writeFile(path.join(stage, "track.complete.json"), JSON.stringify({ id: info.id, size: (await fs.stat(path.join(stage, audioName))).size }));
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await fs.mkdir(path.dirname(anchor), { recursive: true });
      if (oldAnchor) { await fs.rename(anchor, backup); backedUp = true; }
      if (directory === anchor) await fs.rename(stage, anchor);
      else { await fs.rename(stage, directory); published = true; await fs.symlink(directory, anchor, process.platform === "win32" ? "junction" : "dir"); }
    } catch (error) {
      if (backedUp && !await stat(anchor)) await fs.rename(backup, anchor);
      if (published) await this.removeOwned(directory, world, track.id);
      if (await stat(stage)) await this.removeOwned(stage, world, track.id);
      delete this.config.switch;
      throw error;
    }
    const cleanup = [];
    if (backedUp) cleanup.push({ directory: oldAnchor.isSymbolicLink() ? oldDirectory : backup, link: oldAnchor.isSymbolicLink() ? backup : null, world, track: track.id });
    const legacy = value => value && inside(path.join(this.moduleDir, "storage", "uploads"), value.file) ? { file: value.file, url: value.url } : null;
    if (legacyYoutube) cleanup.push({ alias: youtubeDirectory, anchor });
    cleanup.push(...[legacy(audio), legacy(cover)].filter(Boolean));
    return { id: track.id, playlist: track.playlist, oldPath: track.path, oldCover: track.cover, path: `${prefix}/${audioName}`, cover: coverName ? `${prefix}/${coverName}` : track.cover || "", cleanup };
  }
  async start(data) {
    if (this.starting) throw new Error("Другой перенос уже запускается.");
    this.starting = true;
    try { return await this.startMove(data); } finally { this.starting = false; }
  }
  async startMove(data) {
    const { world, playlist = null, root = null } = data; this.validate(world, playlist);
    if (this.busy || this.config.job && !this.config.job.finished) throw new Error("Сначала завершите предыдущий перенос через окно «Хранилище».");
    if (!Array.isArray(data.tracks) || data.tracks.length > 20000) throw new Error("Некорректный список треков для переноса.");
    const ids = new Set();
    for (const track of data.tracks) { this.validate(world, track.playlist, track.id); if (playlist && track.playlist !== playlist || ids.has(track.id)) throw new Error("Некорректный список плейлиста."); ids.add(track.id); this.local(track.path, AUDIO); this.local(track.cover, IMAGE); }
    if (root !== null && (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0") || root.length > 1000)) throw new Error("Укажите полный путь к папке на компьютере сервера Foundry, например D:\\FoundryMusic.");
    const chosen = root === null ? null : path.resolve(root);
    if (chosen && (inside(this.publicDir, chosen) || inside(chosen, this.publicDir) && chosen !== this.dataDir || inside(this.moduleDir, chosen))) throw new Error("Выберите папку вне модуля и служебного хранилища yapw-media.");
    const state = structuredClone(this.world(world)); state.enabled = true;
    if (data.configure !== false) {
      if (playlist) { if (chosen === null) delete state.playlists[playlist]; else state.playlists[playlist] = chosen; }
      else { state.root = chosen; state.playlists = {}; }
    }
    // Validate permissions before changing the rule for future files.
    const base = (playlist ? (state.playlists[playlist] ?? state.root) : state.root);
    const probeDir = base ? path.join(base, "YetAnotherPlayerWidget", world) : path.join(this.publicDir, world);
    await fs.mkdir(probeDir, { recursive: true });
    const probe = path.join(probeDir, `.write-${crypto.randomBytes(8).toString("hex")}`);
    await fs.writeFile(probe, "", { flag: "wx" }); await fs.unlink(probe);
    const previousConfig = structuredClone(this.config);
    this.config.worlds[world] = state;
    const job = { id: crypto.randomBytes(12).toString("hex"), world, playlist, status: "queued", total: data.tracks.length, done: 0, skipped: 0, results: [], errors: [], cleanup: [], finished: false };
    this.config.job = job; this.busy = true;
    try { await this.save(); } catch (error) { this.config = previousConfig; this.busy = false; throw error; }
    this.task = this.run(job, data.tracks);
    return this.status(world, playlist);
  }
  async run(job, tracks) {
    try {
      await this.idle(); job.status = "moving"; await this.save();
      for (const track of tracks) {
        try { const result = await this.relocate(job.world, track); if (result) { job.cleanup.push(...(result.cleanup ?? [])); delete result.cleanup; job.results.push(result); } else job.skipped++; }
        catch (error) { job.errors.push({ id: track.id, name: String(track.name || track.id), message: error.message }); }
        delete this.config.switch; job.done++; await this.save();
      }
      job.status = job.errors.length ? "error" : "ready";
    } catch (error) { job.status = "error"; job.errors.push({ message: error.message }); }
    finally {
      try { await this.save(); }
      catch (error) { job.status = "error"; job.persistError = true; job.errors.push({ message: `Не удалось сохранить состояние переноса: ${error.message}. Исходники ещё не удалены.` }); }
      finally { this.busy = false; this.changed(); }
    }
  }
  async finish({ world, id, references }) {
    this.validate(world); const job = this.config.job;
    if (!job || job.world !== world || job.id !== id || this.busy || !["ready", "error"].includes(job.status)) throw new Error("Перенос ещё не завершён или относится к другому миру.");
    if (job.persistError) throw new Error("Не удалось сохранить состояние переноса. Освободите место для настроек помощника и перезапустите его. Исходники сохранены.");
    if (job.finished) return this.status(world);
    if (!Array.isArray(references) || references.length > 100000 || references.some(p => typeof p !== "string")) throw new Error("Некорректный список используемых файлов.");
    const used = new Set(references.map(p => { try { return decodeURIComponent(p); } catch { return p; } }));
    job.warnings = [];
    for (const item of job.cleanup) {
      try {
        if (item.alias) await this.aliasLegacy(item);
        else if (item.file) {
          if (!used.has(decodeURIComponent(item.url)) && inside(path.join(this.moduleDir, "storage"), item.file)) await fs.unlink(item.file);
        } else {
          await this.removeOwned(item.directory, item.world, item.track);
          if (item.link) await fs.unlink(item.link);
        }
      } catch (error) { if (error.code !== "ENOENT") job.warnings.push(error.message); }
    }
    job.finished = true; job.cleanup = []; await this.save(); return this.status(world);
  }
  validateAlias(item) {
    if (path.dirname(item.alias) !== path.join(this.moduleDir, "storage", "youtube") || !/^[\w-]{11}$/.test(path.basename(item.alias)) || !inside(this.publicDir, item.anchor) || item.backup && !item.backup.startsWith(`${item.alias}.previous-`)) throw new Error("Неожиданный путь старого хранилища YouTube.");
  }
  async aliasLegacy(item) {
    this.validateAlias(item);
    // Other worlds may still use this cache URL. Keep it as a directory link so
    // moving one world's music never breaks their already downloaded tracks.
    const entry = await stat(item.alias); if (entry?.isSymbolicLink() || !entry) return;
    const names = await fs.readdir(item.alias, { withFileTypes: true });
    if (names.some(file => !file.isFile() || !["track.mp3", "track.jpg", "track.info.json", "track.complete.json"].includes(file.name))) throw new Error("В старой папке YouTube есть дополнительные файлы; она сохранена.");
    for (const name of ["track.mp3", "track.jpg"].filter(name => names.some(file => file.name === name))) {
      if (await hash(path.join(item.alias, name)) !== await hash(path.join(item.anchor, name))) throw new Error("Старый файл YouTube изменился или используется с другой обложкой; он сохранён.");
    }
    item.backup = `${item.alias}.previous-${crypto.randomBytes(8).toString("hex")}`; await this.save();
    await fs.rename(item.alias, item.backup);
    try { await fs.symlink(item.anchor, item.alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { await fs.rename(item.backup, item.alias); throw error; }
    for (const name of names) await fs.unlink(path.join(item.backup, name.name)); await fs.rmdir(item.backup);
  }
  async close() { await this.task; await this.writes; }
}
