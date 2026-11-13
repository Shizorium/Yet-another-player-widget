import http from "node:http";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { youtubeSource, youtubeCookies, MAX_COOKIES_BYTES, ID } from "../scripts/model.js";
import { MediaStorage } from "./storage.mjs";

const moduleDir = path.resolve(process.env.YAPW_MODULE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
export const defaultStateDir = process.env.YAPW_STATE_DIR || path.join(os.tmpdir(), `yapw-${crypto.createHash("sha256").update(moduleDir).digest("hex").slice(0, 12)}`);
export const defaultCookiesFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "YetAnotherPlayerWidget", "cookies.txt");
const publicPrefix = `modules/${ID}/storage/youtube`;
const activeStatuses = new Set(["queued", "resolving", "downloading", "processing"]);

export class Downloader {
  constructor(options = {}) {
    this.stateDir = options.stateDir ?? defaultStateDir;
    this.mediaDir = options.mediaDir ?? path.join(moduleDir, "storage", "youtube");
    const bundled = path.join(moduleDir, "helper", "bin", "yt-dlp.exe");
    this.command = options.command ?? process.env.YAPW_YTDLP ?? (process.platform === "win32" && existsSync(bundled) ? bundled : "yt-dlp");
    this.commandPrefix = options.commandPrefix ?? [];
    this.cookiesFile = path.resolve(options.cookiesFile ?? process.env.YAPW_COOKIES ?? (options.stateDir || process.env.YAPW_STATE_DIR ? path.join(this.stateDir, "cookies.txt") : defaultCookiesFile));
    this.cookieWrites = Promise.resolve();
    this.jobs = [];
    this.running = false;
    this.stopped = false;
    this.persistQueue = Promise.resolve();
    const storageModule = options.moduleDir ?? moduleDir;
    const configFile = options.storageConfig ?? (options.stateDir || process.env.YAPW_STATE_DIR ? path.join(this.stateDir, "storage.json") : path.join(path.dirname(defaultCookiesFile), `storage-${crypto.createHash("sha256").update(storageModule).digest("hex").slice(0,12)}.json`));
    this.storage = new MediaStorage({ moduleDir: storageModule, stateDir: this.stateDir, configFile,
      idle: async () => { while (this.running) await new Promise(resolve => setTimeout(resolve, 50)); }, changed: () => { if (!this.stopped) void this.pump(); } });
  }
  async init() {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.mediaDir, { recursive: true });
    await this.storage.init();
    for (const name of await fs.readdir(this.stateDir)) if (/^cookies-session-[a-f0-9]{24}\.txt$/.test(name)) await fs.rm(path.join(this.stateDir, name), { force: true });
    try { this.jobs = JSON.parse(await fs.readFile(path.join(this.stateDir, "jobs.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error(`Не удалось прочитать очередь: ${error.message}`); }
    for (const job of this.jobs) if (activeStatuses.has(job.status)) { job.status = "queued"; job.progress = 0; }
    for (const job of this.jobs) if (["queued", "error"].includes(job.status)) {
      const cached = await this.cachedResult(job);
      if (cached) Object.assign(job, { result: cached, status: "ready", progress: 100, error: "", updatedAt: Date.now() });
    }
    await this.persist();
    void this.pump();
  }
  persist() {
    const content = JSON.stringify(this.jobs, null, 2);
    const task = this.persistQueue.catch(() => {}).then(async () => {
      const file = path.join(this.stateDir, "jobs.json");
      await fs.writeFile(`${file}.tmp`, content, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    this.persistQueue = task;
    return task;
  }
  async readCookies() {
    try {
      const stat = await fs.stat(this.cookiesFile);
      if (!stat.isFile() || stat.size > MAX_COOKIES_BYTES) throw new Error("Файл cookies должен быть текстовым и не больше 1 МБ.");
      return youtubeCookies(await fs.readFile(this.cookiesFile, "utf8"));
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async cookiesStatus() {
    try {
      const cookies = await this.readCookies();
      return { configured: Boolean(cookies), count: cookies?.count ?? 0, file: this.cookiesFile };
    } catch { return { configured: false, count: 0, file: this.cookiesFile, error: "Не удалось прочитать cookies.txt. Замените его файлом Netscape с cookies YouTube." }; }
  }
  saveCookies(text) {
    const cookies = text === null ? null : youtubeCookies(text);
    const task = this.cookieWrites.catch(() => {}).then(async () => {
      const dataDir = path.dirname(path.dirname(moduleDir));
      const relative = path.relative(dataDir, this.cookiesFile);
      if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Cookies нельзя сохранять в общедоступной папке Foundry Data. Укажите YAPW_COOKIES вне неё или используйте путь по умолчанию.");
      if (!cookies) await fs.rm(this.cookiesFile, { force: true });
      else {
        await fs.mkdir(path.dirname(this.cookiesFile), { recursive: true, mode: 0o700 });
        const temporary = `${this.cookiesFile}.${crypto.randomBytes(12).toString("hex")}.tmp`;
        try {
          await fs.writeFile(temporary, cookies.text.replace(/\n/g, os.EOL), { mode: 0o600, flag: "wx" });
          await fs.rename(temporary, this.cookiesFile);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      return this.cookiesStatus();
    });
    this.cookieWrites = task;
    return task;
  }
  async cookieSnapshot() {
    await this.cookieWrites.catch(() => {});
    const cookies = await this.readCookies();
    if (!cookies) return null;
    const file = path.join(this.stateDir, `cookies-session-${crypto.randomBytes(12).toString("hex")}.txt`);
    await fs.writeFile(file, cookies.text.replace(/\n/g, os.EOL), { mode: 0o600, flag: "wx" });
    return file;
  }
  async enqueue(data) {
    const source = youtubeSource(data.url);
    if (!/^[\w-]{1,100}$/.test(data.world ?? "") || !/^[\w:-]{1,180}$/.test(data.key ?? "")) throw new Error("Некорректный идентификатор задания.");
    if (!["resolve", "download"].includes(data.kind)) throw new Error("Неизвестный тип задания.");
    if (data.kind === "download" && source.playlist) throw new Error("Сначала прочитайте содержимое плейлиста.");
    this.storage.validate(data.world, data.playlist);
    let job = this.jobs.find(j => j.world === data.world && j.key === data.key);
    if (job) {
      if (data.retry && ["error", "cancelled"].includes(job.status)) { Object.assign(job, { kind: data.kind, playlist: data.playlist ?? job.playlist, url: source.url, status: "queued", error: "", progress: 0, result: null }); await this.persist(); }
    } else {
      job = { id: crypto.randomBytes(12).toString("hex"), key: data.key, world: data.world, playlist: data.playlist, url: source.url, kind: data.kind, status: "queued", progress: 0, error: "", result: null, createdAt: Date.now() };
      this.jobs.push(job);
      await this.persist();
    }
    void this.pump();
    return job;
  }
  async cancel({ world, tasks }) {
    if (!/^[\w-]{1,100}$/.test(world ?? "") || !Array.isArray(tasks) || !tasks.length || tasks.length > 100 || tasks.some(t => !/^[\w:-]{1,180}$/.test(t?.key ?? "") || (t.jobId != null && !/^[\w-]{1,100}$/.test(t.jobId)))) throw new Error("Некорректный список отмены.");
    const targets = new Set();
    for (const task of tasks) {
      for (const job of this.jobs.filter(j => j.world === world && (j.key === task.key || (task.jobId && j.id === task.jobId)))) targets.add(job);
      // A tombstone also blocks an enqueue request that was already in flight when cancellation began.
      if (!this.jobs.some(j => j.world === world && j.key === task.key)) {
        const job = { id: crypto.randomBytes(12).toString("hex"), world, key: task.key, kind: null, url: "", status: "cancelled", progress: 0, result: null, error: "", createdAt: Date.now() };
        this.jobs.push(job); targets.add(job);
      }
    }
    for (const job of targets) if (activeStatuses.has(job.status)) Object.assign(job, { status: "cancelled", result: null, error: "", updatedAt: Date.now() });
    await this.persist();
    if (targets.has(this.currentJob) && this.child) await this.killChildTree();
    return { cancelled: [...targets].filter(j => j.status === "cancelled").length };
  }
  async killChildTree() {
    const child = this.child, done = this.childDone;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await new Promise((resolve, reject) => {
        const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false });
        killer.on("error", reject);
        killer.on("close", code => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(new Error("Не удалось остановить загрузчик. Повторите отмену после перезапуска помощника.")));
      });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await done;
  }
  execute(args, onLine, timeout = 30 * 60 * 1000, job) {
    return new Promise((resolve, reject) => {
      if (job?.status === "cancelled") return reject(new Error("Загрузка отменена."));
      const child = spawn(this.command, [...this.commandPrefix, ...args], { windowsHide: true, shell: false, detached: process.platform !== "win32", env: process.env });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      this.child = child;
      this.childDone = new Promise(done => child.once("close", done));
      let stdout = "", stderr = "", pending = "", size = 0, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.child = null;
        if (error) reject(error); else resolve(stdout);
      };
      const timer = setTimeout(() => { void this.killChildTree().catch(() => child.kill()); finish(new Error("Превышено время ожидания загрузки.")); }, timeout);
      child.stdout.on("data", chunk => {
        const value = chunk; size += Buffer.byteLength(chunk, "utf8");
        if (size > 32 * 1024 * 1024) { child.kill(); finish(new Error("Слишком большой ответ загрузчика.")); return; }
        stdout += value; pending += value;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) onLine?.(line);
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
      child.on("error", error => finish(new Error(error.code === "ENOENT" ? "Не найден yt-dlp. Установите его или укажите YAPW_YTDLP." : error.message)));
      child.on("close", code => { if (pending) onLine?.(pending); finish(code === 0 ? null : new Error(stderr.trim().slice(-2400) || `Загрузчик завершился с кодом ${code}.`)); });
    });
  }
  trackLocation(job, legacy = false) {
    const source = youtubeSource(job.url);
    if (!legacy && job.world && this.storage.world(job.world).enabled) {
      const track = job.key.match(/^track:([\w-]{1,100})$/)?.[1] ?? job.key.match(/^[\w-]+:([\w-]{1,100})$/)?.[1] ?? job.id;
      const location = this.storage.location(job.world, job.playlist, track);
      return { dir: location.anchor, prefix: location.prefix, location, track };
    }
    return { dir: path.join(this.mediaDir, source.videoId), prefix: `${publicPrefix}/${source.videoId}` };
  }
  async cachedResult(job, legacy = false) {
    if (job.kind !== "download") return null;
    const source = youtubeSource(job.url);
    if (!source.videoId) return null;
    const { dir, prefix } = this.trackLocation(job, legacy);
    try {
      const [audio, text] = await Promise.all([fs.stat(path.join(dir, "track.mp3")), fs.readFile(path.join(dir, "track.info.json"), "utf8")]);
      if (!audio.isFile() || !audio.size) return null;
      const info = JSON.parse(text);
      if (info.id && info.id !== source.videoId) return null;
      const audioPath = `${prefix}/track.mp3`;
      let complete = this.jobs.some(j => j.status === "ready" && j.result?.path === audioPath);
      if (!complete) {
        try { const marker = JSON.parse(await fs.readFile(path.join(dir, "track.complete.json"), "utf8")); complete = marker.id === source.videoId && marker.size === audio.size; } catch {}
      }
      if (!complete) return null;
      const cover = existsSync(path.join(dir, "track.jpg")) ? `${prefix}/track.jpg` : "";
      return { name: String(info.title || source.videoId), duration: Number.isFinite(info.duration) ? info.duration : null, path: audioPath, cover, warning: cover ? "" : "YouTube не предоставил превью." };
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
  }
  async run(job) {
    const cached = await this.cachedResult(job);
    if (cached) return cached;
    if (job.kind === "download" && job.world && this.storage.world(job.world).enabled) {
      const legacy = await this.cachedResult(job, true);
      if (legacy) {
        const { location, track, dir } = this.trackLocation(job);
        await this.storage.ensure(location, job.world, track);
        const source = path.join(this.mediaDir, youtubeSource(job.url).videoId);
        for (const name of ["track.mp3", "track.jpg", "track.info.json", "track.complete.json"]) {
          try { await fs.copyFile(path.join(source, name), path.join(dir, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        const result = await this.cachedResult(job); if (result) return result;
      }
    }
    const cookiesFile = await this.cookieSnapshot();
    try { return await this.runDownload(job, cookiesFile); }
    finally { if (cookiesFile) await fs.rm(cookiesFile, { force: true }); }
  }
  async runDownload(job, cookiesFile) {
    const common = ["--ignore-config", "--no-colors", "--encoding", "utf-8", "--socket-timeout", "30", "--retries", "3", "--js-runtimes", `node:${process.execPath}`];
    if (process.env.YAPW_FFMPEG) common.push("--ffmpeg-location", process.env.YAPW_FFMPEG);
    if (cookiesFile) common.push("--cookies", cookiesFile);
    if (job.kind === "resolve") {
      job.status = "resolving"; await this.persist();
      const output = await this.execute([...common, "--flat-playlist", "--dump-single-json", "--yes-playlist", "--", job.url], null, 5 * 60 * 1000, job);
      const info = JSON.parse(output);
      if (!Array.isArray(info.entries)) throw new Error("В ответе YouTube не найден список треков.");
      const entries = info.entries.filter(Boolean).map(entry => {
        let source;
        try { source = youtubeSource(entry.webpage_url || entry.url || entry.id); } catch { source = null; }
        return { name: String(entry.title || "Недоступное видео"), source: source?.url ?? "", sourceKey: source?.key ?? "", duration: Number.isFinite(entry.duration) ? entry.duration : null, unavailable: !source,
          cover: source?.videoId ? `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg` : "" };
      });
      if (!entries.length) throw new Error("Плейлист пуст, закрыт или недоступен.");
      return { title: String(info.title || "Плейлист YouTube"), entries };
    }
    return this.downloadTrack(job, common, Boolean(cookiesFile));
  }
  async downloadTrack(job, common, privateDownload) {
    const source = youtubeSource(job.url), { dir, prefix, location, track } = this.trackLocation(job);
    if (location) await this.storage.ensure(location, job.world, track);
    await fs.mkdir(dir, { recursive: true });
    const work = privateDownload ? await fs.mkdtemp(path.join(this.stateDir, "cookies-download-")) : dir;
    try {
      if (job.status === "cancelled") throw new Error("Загрузка отменена.");
      job.status = "downloading"; await this.persist();
      await this.execute([...common, "--no-playlist", "--newline", "--progress", "--progress-delta", "1", "--progress-template", "download:YAPW:%(progress._percent_str)s", "--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg", "-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K", "--no-mtime", "-o", path.join(work, "track.%(ext)s"), "--", job.url], line => {
        if (job.status === "cancelled") return;
        const match = line.match(/^YAPW:\s*([\d.]+)%/);
        if (match) job.progress = Math.min(99, Number(match[1]));
        if (/ExtractAudio|ThumbnailsConvertor|Deleting original/.test(line)) job.status = "processing";
      }, undefined, job);
      const files = await fs.readdir(work);
      if (!files.includes("track.mp3")) throw new Error("Загрузчик не создал MP3-файл. Проверьте наличие FFmpeg.");
      const raw = JSON.parse(await fs.readFile(path.join(work, "track.info.json"), "utf8"));
      const info = { id: source.videoId, title: String(raw.title || source.videoId), duration: Number.isFinite(raw.duration) ? raw.duration : null };
      // Raw yt-dlp metadata can contain cookies and request headers; publish only these safe fields.
      if (privateDownload) {
        await fs.copyFile(path.join(work, "track.mp3"), path.join(dir, "track.mp3"));
        if (files.includes("track.jpg")) await fs.copyFile(path.join(work, "track.jpg"), path.join(dir, "track.jpg"));
      }
      await fs.writeFile(path.join(dir, "track.info.json"), JSON.stringify(info));
      const audioStat = await fs.stat(path.join(dir, "track.mp3"));
      await fs.writeFile(path.join(dir, "track.complete.json"), JSON.stringify({ id: source.videoId, size: audioStat.size, completedAt: Date.now() }));
      const cover = files.includes("track.jpg") ? `${prefix}/track.jpg` : "";
      return { name: info.title, duration: info.duration, path: `${prefix}/track.mp3`, cover, warning: cover ? "" : "YouTube не предоставил превью." };
    } finally {
      if (privateDownload) {
        if (path.dirname(path.resolve(work)) !== path.resolve(this.stateDir) || !/^cookies-download-[a-zA-Z0-9]{6}$/.test(path.basename(work))) throw new Error("Неожиданный путь временной загрузки.");
        await fs.rm(work, { recursive: true, force: true });
      }
    }
  }
  async pump() {
    if (this.running || this.stopped || this.storage.busy) return;
    this.running = true;
    try {
      let job;
      while (!this.stopped && !this.storage.busy && (job = this.jobs.find(j => j.status === "queued"))) {
        this.currentJob = job;
        try { const result = await this.run(job); if (job.status !== "cancelled") Object.assign(job, { result, status: "ready", progress: 100, error: "" }); }
        catch (error) { if (job.status !== "cancelled") { job.status = "error"; job.error = /confirm your age|age.restricted|Use --cookies/i.test(error.message) ? "YouTube требует входа или подтверждения возраста. Во вкладке «Загрузки» добавьте cookies.txt аккаунта, которому доступно это видео, затем повторите загрузку." : /429|Too Many Requests|Sign in to confirm.*not a bot/i.test(error.message) ? "YouTube временно ограничил запросы или требует проверку на бота. Подождите и повторите позже; при требовании входа можно добавить cookies.txt во вкладке «Загрузки». Уже скачанные треки берутся из локального хранилища." : error.message; } }
        this.currentJob = null;
        job.updatedAt = Date.now(); await this.persist();
      }
    } catch (error) { console.error("Ошибка сохранения очереди:", error.message); }
    finally { this.running = false; }
  }
  async close() { this.stopped = true; await this.killChildTree(); await this.storage.close(); await this.persistQueue; await this.cookieWrites.catch(() => {}); }
}

export async function createHelper(options = {}) {
  const downloader = new Downloader(options);
  let token = options.token, ready = false;
  const allowed = new Set(options.origins ?? (process.env.YAPW_ORIGINS || "http://localhost:30000,http://127.0.0.1:30000").split(",").map(s => s.trim()));
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const reply = (code, value) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    if (!ready) return reply(503,{error:"Помощник запускается. Повторите подключение через несколько секунд."});
    if (origin && !allowed.has(origin)) return reply(403, { error: "Адрес Foundry отсутствует в YAPW_ORIGINS помощника." });
    if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const received = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return reply(401, { error: "Неверный ключ помощника. Скопируйте ключ из окна запуска." });
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, version: "1.5.0", features: ["cancel", "cache", "standalone", "cookies", "storage"], cookies: await downloader.cookiesStatus() });
      if (req.method === "GET" && url.pathname === "/storage") return reply(200, downloader.storage.status(url.searchParams.get("world"), url.searchParams.get("playlist")));
      if (req.method === "GET" && url.pathname === "/cookies") return reply(200, await downloader.cookiesStatus());
      if (req.method === "GET" && url.pathname === "/jobs") return reply(200, { jobs: downloader.jobs.filter(j => j.world === url.searchParams.get("world")), cookies: await downloader.cookiesStatus() });
      if (req.method === "POST" && ["/jobs", "/jobs/cancel", "/cookies", "/storage/move", "/storage/finish", "/storage/prepare"].includes(url.pathname)) {
        let body = "";
        const limit = url.pathname.startsWith("/storage/") ? 8 * 1024 * 1024 : url.pathname === "/cookies" ? MAX_COOKIES_BYTES * 2 : 32 * 1024;
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > limit) return reply(413, { error: "Слишком большой запрос." }); }
        let data;
        try { data = JSON.parse(body); } catch { throw new Error("Некорректный JSON-запрос."); }
        if (url.pathname === "/storage/prepare") return reply(200, await downloader.storage.prepare(data.world, data.playlist, data.track));
        if (url.pathname === "/storage/move") return reply(200, await downloader.storage.start(data));
        if (url.pathname === "/storage/finish") {
          const result = await downloader.storage.finish(data);
          for (const moved of result.job.results) for (const job of downloader.jobs) if (job.world === data.world && (job.key === `track:${moved.id}` || job.key?.endsWith(`:${moved.id}`))) {
            if (job.result?.path === moved.oldPath) Object.assign(job.result, { path: moved.path, cover: moved.cover });
          }
          await downloader.persist(); return reply(200, result);
        }
        if (url.pathname === "/cookies") {
          if (data?.clear !== true && typeof data?.text !== "string") throw new Error("Выберите файл cookies.txt.");
          return reply(200, await downloader.saveCookies(data.clear === true ? null : data.text));
        }
        return reply(200, url.pathname === "/jobs/cancel" ? await downloader.cancel(data) : await downloader.enqueue(data));
      }
      reply(404, { error: "Неизвестный адрес." });
    } catch (error) { reply(400, { error: error.message }); }
  });
  try {
    // Claim the port before reading/processing the queue, including when a legacy helper is running.
    if (options.port != null) await new Promise((resolve,reject) => {
      server.once("error",reject);server.listen(options.port,"127.0.0.1",() => {server.off("error",reject);resolve();});
    });
    await downloader.init();
    const tokenFile = path.join(downloader.stateDir,"token.txt");
    if (!token) { try { token = (await fs.readFile(tokenFile,"utf8")).trim(); } catch {} }
    if (!token) { token = crypto.randomBytes(32).toString("hex"); await fs.writeFile(tokenFile,token,{mode:0o600}); }
    ready = true;
  } catch (error) {
    await downloader.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    throw error;
  }
  return { server, downloader, token, async close() { await downloader.close(); if(server.listening)await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const helper = await createHelper({port:Number(process.env.YAPW_PORT || 32123)});
    const port = helper.server.address().port;
    console.log(`\nYet another player widget — помощник загрузок\nАдрес: http://127.0.0.1:${port}\nКлюч: ${helper.token}\nCookies: ${helper.downloader.cookiesFile}\n\nВставьте адрес и ключ в настройках плеера Foundry.\nФайл cookies.txt можно добавить во вкладке «Загрузки» или положить по указанному пути.\nОчередь работает, пока открыт этот процесс.\n`);
    helper.server.on("error",error => {console.error(error.message);process.exitCode=1;});
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await helper.close(); process.exit(0); });
  } catch (error) {
    console.error(error.code === "EADDRINUSE" ? "Помощник уже запущен либо выбранный порт занят. Сначала закройте прежнее окно помощника." : error.message);
    process.exitCode=1;
  }
}
