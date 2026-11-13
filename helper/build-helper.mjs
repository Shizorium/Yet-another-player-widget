// Developer tool: node helper/build-helper.mjs --node node.exe --ffmpeg PATH --ffprobe PATH
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { peImports } from "../tests/pe-imports.mjs";

const helper = path.dirname(fileURLToPath(import.meta.url)), moduleDir = path.dirname(helper), build = path.join(helper,".build");
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const outputDir = path.resolve(arg("--output-dir") || helper);
const node = path.resolve(arg("--node") || path.join(build,"bin","node.exe"));
const ffmpeg = arg("--ffmpeg"), ffprobe = arg("--ffprobe");
if (!ffmpeg || !ffprobe) throw new Error("Укажите --ffmpeg и --ffprobe: абсолютные пути к статическим сборкам Windows x64.");
const postject = path.join(helper,"build-tools","node_modules","postject","dist","cli.js");
await fs.access(postject);
const metadata = JSON.parse(await fs.readFile(path.join(moduleDir,"module.json"),"utf8"));
const sources = JSON.parse(await fs.readFile(path.join(helper,"component-sources.json"),"utf8"));
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const gzip = promisify(zlib.gzip);
await fs.mkdir(path.join(build,"assets"),{recursive:true});
const files = [
  [node,"node.exe"], [path.join(helper,"bin","yt-dlp.exe"),"yt-dlp.exe"],
  [path.resolve(ffmpeg),"ffmpeg.exe"], [path.resolve(ffprobe),"ffprobe.exe"],
  [path.join(helper,"server.mjs"),"helper/server.mjs"], [path.join(moduleDir,"scripts","model.js"),"scripts/model.js"]
];
for (const name of (await fs.readdir(path.join(helper,"licenses"))).sort()) files.push([path.join(helper,"licenses",name),`licenses/${name}`]);
const assets = {}, records = [];
for (const [source,target] of files) {
  const data = await fs.readFile(source), hash = sha256(data), asset = target.replaceAll("/","_") + ".gz";
  const expected = target === "node.exe" ? sources.node.sha256 : target === "yt-dlp.exe" ? sources.ytdlp.sha256 : sources.ffmpeg.files[target];
  if (expected && expected !== hash) throw new Error(`Не совпала контрольная сумма ${target}. Обновите component-sources.json только после проверки официального выпуска.`);
  const output = path.join(build,"assets",asset);
  console.log(`Упаковка ${target}: ${Math.round(data.length/1024/1024)} МБ`);
  await fs.writeFile(output,await gzip(data,{level:9}));
  assets[asset] = output; records.push({path:target,asset,sha256:hash,bytes:data.length});
}
const packageText = Buffer.from('{"type":"module"}'), packageAsset = path.join(build,"assets","package.json.gz");
await fs.writeFile(packageAsset,await gzip(packageText));assets["package.json.gz"]=packageAsset;
records.push({path:"package.json",asset:"package.json.gz",sha256:sha256(packageText),bytes:packageText.length});
const buildId = sha256(Buffer.from(JSON.stringify({version:metadata.version,files:records}))).slice(0,20);
const manifest = {version:metadata.version,buildId,platform:"win32",arch:"x64",files:records};
const manifestFile = path.join(build,"bundle-manifest.json");await fs.writeFile(manifestFile,JSON.stringify(manifest,null,2));assets["bundle-manifest.json"]=manifestFile;
const blob = path.join(build,"helper.blob"), configFile = path.join(build,"sea-config.json");
await fs.writeFile(configFile,JSON.stringify({main:path.join(helper,"launcher.cjs"),output:blob,disableExperimentalSEAWarning:true,useCodeCache:false,useSnapshot:false,assets},null,2));
function run(args) { const result=spawnSync(node,args,{stdio:"inherit",windowsHide:true});if(result.error)throw result.error;if(result.status)throw new Error(`Ошибка сборки (${result.status}).`); }
run(["--experimental-sea-config",configFile]);
await fs.mkdir(outputDir,{recursive:true});
const executable = path.join(outputDir,"Helper.exe"), binary = await fs.readFile(node);
// The generated program has its own identity; discard the original Node signature.
const pe=binary.readUInt32LE(60),optional=pe+24,directories=optional+(binary.readUInt16LE(optional)===0x20b?112:96),certificate=directories+4*8;
const certificateOffset=binary.readUInt32LE(certificate),certificateSize=binary.readUInt32LE(certificate+4);
binary.writeUInt32LE(0,certificate);binary.writeUInt32LE(0,certificate+4);
await fs.writeFile(executable,certificateOffset&&certificateOffset+certificateSize===binary.length?binary.subarray(0,certificateOffset):binary);
run([postject,executable,"NODE_SEA_BLOB",blob,"--sentinel-fuse","NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
const imports=await peImports(executable);
if(imports.some(name=>/vcruntime|msvcp|libstdc|libgcc/i.test(name)))throw new Error("EXE требует внешние DLL. Используйте автономную сборку Node.js.");
const executableHash=sha256(await fs.readFile(executable));
await fs.writeFile(executable+".sha256",`${executableHash}  Helper.exe\n`);
await fs.writeFile(path.join(outputDir,"bundle-info.json"),JSON.stringify({...manifest,executableSha256:executableHash,imports},null,2));
console.log(`Готово: ${executable}\nВерсия ${metadata.version}; ${Math.round((await fs.stat(executable)).size/1024/1024)} МБ; SHA256 ${executableHash}`);
