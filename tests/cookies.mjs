import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { youtubeCookies, MAX_COOKIES_BYTES, ID } from "../scripts/model.js";
import { createHelper, Downloader } from "../helper/server.mjs";
import { Downloads } from "../scripts/downloads.js";
import { fullView } from "../scripts/view.js";

// All cookie values in this file are synthetic; no browser profiles or user files are read.
const sample = (value = "VALID_TEST_COOKIE") => `# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tTEST_SESSION\t${value}\n.other.test\tTRUE\t/\tTRUE\t0\tOTHER\tOTHER_SITE_SECRET\n`;
const until = async check => { const deadline = Date.now() + 10000; while (!(await check())) { if (Date.now() > deadline) throw new Error("Cookie fixture timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } };
function request(port, endpoint, { token = "fixture-key", method = "GET", body, raw, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: endpoint, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body || raw ? { "Content-Type": "application/json" } : {}) } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, text }));
    });
    req.on("error", reject); req.end(raw ?? (body ? JSON.stringify(body) : undefined));
  });
}

export async function cookiesTests(test) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "yapw-cookies-"));
  let helper, worker;
  const savedGame = globalThis.game;
  try {
    await test("Netscape cookies accept HttpOnly/BOM/CRLF, retain only YouTube domains and reject malformed or oversized files without echoing values", () => {
      const parsed = youtubeCookies("\uFEFF" + sample().replace(/\n/g, "\r\n"));
      assert.equal(parsed.count, 1); assert.match(parsed.text, /#HttpOnly_\.youtube.com/); assert.doesNotMatch(parsed.text, /OTHER_SITE_SECRET|other.test/);
      assert.throws(() => youtubeCookies('{"secret":"DO_NOT_ECHO"}'), error => !error.message.includes("DO_NOT_ECHO") && /Netscape/.test(error.message));
      for (const text of [sample().replace(/youtube.com/g, "youtube.com.evil.test"), sample().replace(".youtube.com\tTRUE", "youtube.com\tTRUE"), sample().replace("\tTRUE\t0", "\tmaybe\t0"), sample().replace("\t0\t", "\tbroken\t"), "x".repeat(MAX_COOKIES_BYTES + 1)]) assert.throws(() => youtubeCookies(text));
    });
    await test("Cookie API enforces authentication/origin, validates before replacing, persists privately, detects manual updates and never returns values", async () => {
      const options = { stateDir: path.join(fixture, "http-state"), mediaDir: path.join(fixture, "http-media"), cookiesFile: path.join(fixture, "private", "cookies.txt"), token: "fixture-key", port: 0 };
      helper = await createHelper(options); let port = helper.server.address().port;
      assert.equal((await request(port, "/cookies", { token: "" })).status, 401);
      assert.equal((await request(port, "/cookies", { token: "", method: "POST", body: { text: sample() } })).status, 401);
      assert.equal((await request(port, "/cookies", { method: "POST", origin: "https://foreign.test", body: { text: sample() } })).status, 403);
      let response = await request(port, "/cookies", { method: "POST", body: { text: sample() } });
      assert.equal(response.status, 200); assert.equal(response.body.configured, true); assert.equal(response.body.count, 1);
      assert.doesNotMatch(response.text, /VALID_TEST_COOKIE|OTHER_SITE_SECRET|TEST_SESSION/);
      const original = await fs.readFile(options.cookiesFile, "utf8"); assert.doesNotMatch(original, /OTHER_SITE_SECRET/);
      response = await request(port, "/cookies", { method: "POST", body: { text: "invalid DO_NOT_ECHO" } });
      assert.equal(response.status, 400); assert.doesNotMatch(response.text, /DO_NOT_ECHO/); assert.equal(await fs.readFile(options.cookiesFile, "utf8"), original);
      response = await request(port, "/cookies", { method: "POST", raw: "DO_NOT_ECHO_INVALID_JSON" });
      assert.equal(response.status, 400); assert.doesNotMatch(response.text, /DO_NOT_ECHO/);
      assert.equal((await request(port, "/cookies", { method: "POST", body: { text: "x".repeat(MAX_COOKIES_BYTES + 1) } })).status, 400);
      assert.equal((await request(port, "/cookies", { method: "POST", raw: "x".repeat(MAX_COOKIES_BYTES * 2 + 1) })).status, 413);
      for (const endpoint of ["/health", "/jobs?world=fixture", "/cookies"]) assert.doesNotMatch((await request(port, endpoint)).text, /VALID_TEST_COOKIE|OTHER_SITE_SECRET/);
      await fs.writeFile(options.cookiesFile, sample("MANUALLY_REPLACED"));
      assert.equal((await request(port, "/cookies")).body.configured, true);
      await helper.close(); helper = await createHelper(options); port = helper.server.address().port;
      assert.equal((await request(port, "/health")).body.cookies.configured, true);
      response = await request(port, "/cookies", { method: "POST", body: { clear: true } });
      assert.equal(response.body.configured, false); await assert.rejects(() => fs.access(options.cookiesFile), { code: "ENOENT" });
      await helper.close(); helper = null;
    });
    await test("Worker passes private cookie copies to both playlist resolution and download, preserves the source, cleans copies and guides age errors", async () => {
      const options = { stateDir: path.join(fixture, "worker-state"), mediaDir: path.join(fixture, "worker-media"), cookiesFile: path.join(fixture, "worker-private", "cookies.txt"), command: process.execPath, commandPrefix: [fileURLToPath(new URL("fake-dlp.mjs", import.meta.url))] };
      worker = new Downloader(options); await worker.init();
      const age = await worker.enqueue({ world: "fixture", key: "age", kind: "download", url: "https://youtu.be/agecheck001" }); await until(() => !worker.running);
      assert.equal(age.status, "error"); assert.match(age.error, /подтверждения возраста|подтверждения? возраста|cookies.txt/);
      await worker.saveCookies(sample()); const original = await fs.readFile(options.cookiesFile, "utf8");
      const execute = worker.execute.bind(worker), snapshots = [];
      worker.execute = async (...params) => {
        const args = params[0], file = args[args.indexOf("--cookies") + 1];
        assert.ok(args.includes("--cookies")); assert.notEqual(file, options.cookiesFile);
        assert.match(await fs.readFile(file, "utf8"), /VALID_TEST_COOKIE/); snapshots.push(file);
        return execute(...params);
      };
      await worker.enqueue({ world: "fixture", key: "age", kind: "download", url: age.url, retry: true });
      const playlist = await worker.enqueue({ world: "fixture", key: "playlist", kind: "resolve", url: "https://www.youtube.com/playlist?list=PLabcdefghijklmnop" });
      await until(() => !worker.running); assert.equal(age.status, "ready"); assert.equal(playlist.status, "ready"); assert.equal(snapshots.length, 2);
      assert.equal(await fs.readFile(options.cookiesFile, "utf8"), original);
      for (const file of snapshots) await assert.rejects(() => fs.access(file), { code: "ENOENT" });
      assert.doesNotMatch(await fs.readFile(path.join(options.stateDir, "jobs.json"), "utf8"), /VALID_TEST_COOKIE|OTHER_SITE_SECRET/);
      assert.doesNotMatch(await fs.readFile(path.join(options.mediaDir, "agecheck001", "track.info.json"), "utf8"), /cookies|http_headers|SYNTHETIC_METADATA_SECRET/);
      assert.equal((await fs.readdir(options.stateDir)).some(name => name.startsWith("cookies-download-")), false);
      await fs.writeFile(options.cookiesFile, "broken"); assert.equal((await worker.cookiesStatus()).configured, false);
      const cached = await worker.enqueue({ world: "fixture", key: "cached-age", kind: "download", url: age.url }); await until(() => !worker.running); assert.equal(cached.status, "ready");
      await worker.close(); worker = null;
    });
    await test("Cookie uploads filter other sites before transmission, reject bad files and players, and explain old helper versions", async () => {
      globalThis.game = { user: { isGM: true }, settings: { get: () => ({}), set: () => { throw new Error("Cookies must never be saved in Foundry settings"); } } };
      const downloads = new Downloads({}, () => {}), requests = [];
      downloads.request = async (endpoint, body) => { requests.push({ endpoint, body }); return { configured: true, count: 1, file: "private/cookies.txt" }; };
      const file = { size: sample().length, text: async () => sample() };
      await downloads.uploadCookies(file); assert.equal(downloads.cookies.configured, true); assert.doesNotMatch(requests[0].body.text, /OTHER_SITE_SECRET/);
      await assert.rejects(() => downloads.uploadCookies({ size: MAX_COOKIES_BYTES + 1, text: async () => sample() }), /1 МБ/);
      await assert.rejects(() => downloads.uploadCookies({ size: 10, text: async () => "bad" }), /Netscape/);
      game.user.isGM = false; await assert.rejects(() => downloads.uploadCookies(file), /ведущий/); await assert.rejects(() => downloads.cookiesRequest(), /ведущий/); assert.equal(requests.length, 1);
      game.user.isGM = true; downloads.request = async () => { throw new Error("Неизвестный адрес."); }; await assert.rejects(() => downloads.cookiesRequest(), /обновите и перезапустите/);
    });
    await test("Downloads tab exposes cookie controls and safe status only to the GM", () => {
      const library = { playlists: [], current: null, layerEntries: [], tracks: () => [], playbackOptions: () => ({ autoplay: true, repeat: true }) };
      const view = { library, query: "", tab: "queue", downloads: { cookies: { configured: true, count: 1 }, online: true, message: "Test" } };
      assert.match(fullView(view), /data-action="cookies-upload"/); assert.match(fullView(view), /data-action="cookies-remove"/); assert.match(fullView(view), /Подключены · 1 cookies/);
      assert.doesNotMatch(fullView({ ...view, tab: "library" }), /data-action="cookies-upload"/);
      game.user.isGM = false; assert.equal(fullView(view), "");
    });
  } finally {
    if (helper) await helper.close(); if (worker) await worker.close(); globalThis.game = savedGame;
    if (path.dirname(path.resolve(fixture)) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith("yapw-cookies-")) throw new Error("Unexpected cookie fixture path");
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
