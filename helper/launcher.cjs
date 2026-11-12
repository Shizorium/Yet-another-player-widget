/* Node.js SEA entry point. Only built-in modules are needed before extraction. */
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");
const sea = require("node:sea");

const args = process.argv.slice(2);
let stopping = false, logFile;
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
function argument(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
async function prepare(manifest, root) {
  await fs.mkdir(root,{recursive:true});
  for (const item of manifest.files) {
    const file = path.resolve(root,item.path);
    if (!file.startsWith(root + path.sep)) throw new Error("Некорректный путь внутри сборки.");
    try { if (sha256(await fs.readFile(file)) === item.sha256) continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
    console.log(`Подготовка: ${path.basename(item.path)}`);
    const content = zlib.gunzipSync(Buffer.from(sea.getAsset(item.asset)));
    if (sha256(content) !== item.sha256) throw new Error(`Повреждён встроенный компонент ${item.path}. Скачайте модуль заново.`);
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary,content); await fs.rename(temporary,file);
  }
}
function verify(root) {
  const tools = [["Node.js","node.exe","--version"],["yt-dlp","yt-dlp.exe","--version"],["FFmpeg","ffmpeg.exe","-version"],["ffprobe","ffprobe.exe","-version"]];
  const versions = {};
  for (const [name,file,flag] of tools) {
    const result = spawnSync(path.join(root,file),[flag],{encoding:"utf8",windowsHide:true,timeout:30000,maxBuffer:1024*1024});
    if (result.error || result.status !== 0) throw new Error(`${name} не запускается: ${result.error?.message || result.stderr?.trim() || result.status}`);
    versions[name] = result.stdout.trim().split(/\r?\n/)[0];
  }
  return versions;
}
async function main() {
  if (!sea.isSea()) throw new Error("Используйте собранный Helper.exe. Этот файл — исходный код сборки.");
  if (args.includes("--help")) {
    console.log("Yet another player widget — Helper.exe\n\nЗапуск: Helper.exe (в папке helper модуля)\nПроверка встроенных программ: Helper.exe --check\nДругой модуль: Helper.exe --module-dir ПУТЬ\nБез ожидания Enter при ошибке: --no-pause"); return;
  }
  const manifest = JSON.parse(sea.getAsset("bundle-manifest.json","utf8"));
  const privateRoot = path.resolve(process.env.YAPW_RUNTIME_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(),"YetAnotherPlayerWidget"));
  const root = path.join(privateRoot,"runtime",manifest.buildId);
  logFile = path.join(privateRoot,"helper-error.log");
  console.log(`Yet another player widget — помощник ${manifest.version}\n`);
  await prepare(manifest,root);
  if (args.includes("--check")) {
    console.log(JSON.stringify({ok:true,version:manifest.version,buildId:manifest.buildId,platform:process.platform,arch:process.arch,versions:verify(root)},null,2)); return;
  }
  const moduleDir = path.resolve(argument("--module-dir") || process.env.YAPW_MODULE_DIR || path.join(path.dirname(process.execPath),".."));
  let module;
  try { module = JSON.parse(await fs.readFile(path.join(moduleDir,"module.json"),"utf8")); } catch {}
  if (module?.id !== "yet-another-player-widget") throw new Error("Модуль не найден. Поместите Helper.exe в папку helper установленного модуля или укажите --module-dir ПУТЬ.");
  const env = { ...process.env, YAPW_MODULE_DIR:moduleDir, YAPW_YTDLP:path.join(root,"yt-dlp.exe"), YAPW_FFMPEG:root };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = spawn(path.join(root,"node.exe"),[path.join(root,"helper","server.mjs")],{cwd:moduleDir,env,stdio:"inherit",windowsHide:false});
  for (const signal of ["SIGINT","SIGTERM"]) process.on(signal,() => { stopping = true; if (signal === "SIGTERM") child.kill(signal); });
  const code = await new Promise((resolve,reject) => { child.once("error",reject); child.once("exit",(code,signal) => resolve(code ?? (stopping || signal === "SIGINT" ? 0 : 1))); });
  if (code && !stopping) throw new Error(`Помощник завершился с кодом ${code}. Причина указана выше.`);
}
main().catch(async error => {
  console.error(`\nОшибка: ${error.message}`);
  if (logFile) {
    try { await fs.appendFile(logFile,`${new Date().toISOString()} ${error.stack || error.message}\n`); console.error(`Журнал: ${logFile}`); } catch {}
  }
  process.exitCode = 1;
  if (process.stdin.isTTY && !args.includes("--no-pause") && !stopping) {
    const readline = require("node:readline").createInterface({input:process.stdin,output:process.stdout});
    await new Promise(resolve => readline.question("Нажмите Enter, чтобы закрыть окно…",resolve)); readline.close();
  }
});
