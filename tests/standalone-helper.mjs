// Copies only Helper.exe into an isolated folder. Never opens the user's world or helper state.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {peImports} from "./pe-imports.mjs";

const moduleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),"yapw-standalone-"));
const exeDir=path.join(fixture,"Чистый ПК с пробелами"),runtimeRoot=path.join(fixture,"private-runtime"),state=path.join(fixture,"private-state");
await fs.mkdir(exeDir);const exe=path.join(exeDir,"Helper.exe");await fs.copyFile(path.join(moduleRoot,"helper","Helper.exe"),exe);
const env={...process.env,PATH:path.join(process.env.SystemRoot||"C:\\Windows","System32"),YAPW_RUNTIME_DIR:runtimeRoot,YAPW_STATE_DIR:state,YAPW_PORT:"0"};
for(const key of ["NODE_OPTIONS","NODE_PATH","YAPW_NODE","YAPW_YTDLP","YAPW_FFMPEG","YAPW_COOKIES","YAPW_MODULE_DIR"])delete env[key];
function run(command,args,options={}){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env,cwd:fixture,windowsHide:true,...options});let stdout="",stderr="";
  child.stdout.on("data",data=>stdout+=data);child.stderr.on("data",data=>stderr+=data);child.once("error",reject);
  child.once("close",code=>resolve({code,stdout,stderr}));
});}
async function until(check){const deadline=Date.now()+30000;while(!(await check())){if(Date.now()>deadline)throw new Error("Timed out waiting for isolated helper");await new Promise(resolve=>setTimeout(resolve,50));}}
async function request(port,endpoint,{token,method="GET",body,origin}={}){return new Promise((resolve,reject)=>{
  const req=http.request({host:"127.0.0.1",port,path:endpoint,method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(origin?{Origin:origin}:{}),...(body?{"Content-Type":"application/json"}:{})}},res=>{let data="";res.on("data",chunk=>data+=chunk);res.on("end",()=>resolve({status:res.statusCode,body:data?JSON.parse(data):null}));});req.on("error",reject);req.end(body?JSON.stringify(body):undefined);
});}
let helper,mediaServer;
try{
  const checked=await run(exe,["--check","--no-pause"]);
  assert.equal(checked.code,0,checked.stderr);const diagnostic=JSON.parse(checked.stdout.slice(checked.stdout.indexOf("{")));
  assert.equal(diagnostic.ok,true);assert.equal(diagnostic.arch,"x64");assert.match(diagnostic.versions["Node.js"],/^v2[2-9]\./);
  const runtime=path.join(runtimeRoot,"runtime",diagnostic.buildId);
  assert.deepEqual(await fs.readdir(exeDir),["Helper.exe"]);
  for(const name of ["Helper.exe","node.exe","yt-dlp.exe","ffmpeg.exe","ffprobe.exe"]){
    const imports=await peImports(name==="Helper.exe"?exe:path.join(runtime,name));assert.equal(imports.some(dll=>/vcruntime|msvcp|libgcc|libstdc/i.test(dll)),false,`${name} requires an unbundled runtime`);
  }
  console.log("PASS Single EXE extracts all tools with no system Node, FFmpeg, Python or npm in PATH; PE imports need only Windows DLLs");
  const runtimeNode=path.join(runtime,"node.exe"),ffmpeg=path.join(runtime,"ffmpeg.exe"),ffprobe=path.join(runtime,"ffprobe.exe");
  const sourceAudio=path.join(fixture,"input.webm"),sourceCover=path.join(fixture,"cover.webp");
  assert.equal((await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=0.4","-c:a","libopus",sourceAudio])).code,0);
  assert.equal((await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=64x64","-frames:v","1",sourceCover])).code,0);
  mediaServer=http.createServer(async(req,res)=>{const file=req.url==="/cover.webp"?sourceCover:sourceAudio;res.end(await fs.readFile(file));});
  await new Promise(resolve=>mediaServer.listen(0,"127.0.0.1",resolve));const mediaPort=mediaServer.address().port;
  const infoFile=path.join(fixture,"input.info.json"),video="portable001";
  await fs.writeFile(infoFile,JSON.stringify({id:video,title:"Portable fixture",extractor:"generic",extractor_key:"Generic",webpage_url:`https://youtu.be/${video}`,url:`http://127.0.0.1:${mediaPort}/audio.webm`,ext:"webm",duration:0.4,thumbnail:`http://127.0.0.1:${mediaPort}/cover.webp`}));
  const converted=await run(path.join(runtime,"yt-dlp.exe"),["--ignore-config","--no-colors","--load-info-json",infoFile,"--js-runtimes",`node:${runtimeNode}`,"--ffmpeg-location",runtime,"--write-thumbnail","--convert-thumbnails","jpg","--extract-audio","--audio-format","mp3","--audio-quality","192K","--write-info-json","-o",path.join(fixture,"track.%(ext)s")]);
  assert.equal(converted.code,0,converted.stderr);
  const audio=await fs.readFile(path.join(fixture,"track.mp3")),cover=await fs.readFile(path.join(fixture,"track.jpg"));assert.ok(audio.length>100);assert.equal(cover.readUInt16BE(0),0xffd8);
  const probe=await run(ffprobe,["-v","error","-show_entries","format=duration","-of","json",path.join(fixture,"track.mp3")]);assert.equal(probe.code,0);assert.ok(Number(JSON.parse(probe.stdout).format.duration)>0);
  console.log("PASS Embedded yt-dlp and FFmpeg download a local fixture and produce valid MP3, JPG and metadata entirely offline from YouTube");
  const module=path.join(fixture,"Foundry Data","modules","yet-another-player-widget"),media=path.join(module,"storage","youtube",video);
  await fs.mkdir(media,{recursive:true});await fs.writeFile(path.join(module,"module.json"),JSON.stringify({id:"yet-another-player-widget"}));
  await fs.writeFile(path.join(media,"track.mp3"),audio);await fs.writeFile(path.join(media,"track.jpg"),cover);
  await fs.writeFile(path.join(media,"track.info.json"),JSON.stringify({id:video,title:"Portable cached fixture",duration:0.4}));
  await fs.writeFile(path.join(media,"track.complete.json"),JSON.stringify({id:video,size:audio.length}));
  helper=spawn(exe,["--module-dir",module,"--no-pause"],{env,cwd:fixture,windowsHide:true});let output="";
  helper.stdout.on("data",chunk=>{output=(output+chunk).slice(-16000);});helper.stderr.on("data",()=>{});
  await until(()=>/Адрес: http:\/\/127\.0\.0\.1:(\d+)/.test(output));const port=Number(output.match(/Адрес: http:\/\/127\.0\.0\.1:(\d+)/)[1]);
  const token=(await fs.readFile(path.join(state,"token.txt"),"utf8")).trim();
  assert.equal((await request(port,"/health",{token})).status,200);assert.equal((await request(port,"/health")).status,401);
  assert.equal((await request(port,"/health",{token,origin:"https://invalid.test"})).status,403);
  await request(port,"/jobs",{token,method:"POST",body:{world:"portable",key:"track:cached",kind:"download",url:`https://youtu.be/${video}`}});
  let job;await until(async()=>{job=(await request(port,"/jobs?world=portable",{token})).body.jobs[0];return job?.status==="ready";});
  assert.equal(job.result.path,`modules/yet-another-player-widget/storage/youtube/${video}/track.mp3`);
  await request(port,"/jobs/cancel",{token,method:"POST",body:{world:"portable",tasks:[{key:"track:cancelled"}]}});
  assert.equal((await request(port,"/jobs",{token,method:"POST",body:{world:"portable",key:"track:cancelled",kind:"download",url:"https://youtu.be/abcdefghijk"}})).body.status,"cancelled");
  console.log("PASS Standalone server uses the actual module storage, private key, authenticated API, cached music and cancellation without any source files beside EXE");
  const before=await fs.readFile(path.join(state,"jobs.json"),"utf8");
  const duplicate=await run(exe,["--module-dir",module,"--no-pause"],{env:{...env,YAPW_PORT:String(port)}});assert.equal(duplicate.code,1);assert.equal(await fs.readFile(path.join(state,"jobs.json"),"utf8"),before);
  console.log("PASS A second helper rejects an occupied port before touching the running queue");
  const repairTarget=path.join(runtime,"scripts","model.js");await fs.writeFile(repairTarget,"damaged");assert.equal((await run(exe,["--check","--no-pause"])).code,0);
  const manifest=JSON.parse(await fs.readFile(path.join(moduleRoot,"helper","bundle-info.json"),"utf8")),expected=manifest.files.find(f=>f.path==="scripts/model.js");
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(repairTarget)).digest("hex"),expected.sha256);
  console.log("PASS Damaged extracted assets are verified and restored from EXE without downloading anything");
  console.log(`Standalone helper ${diagnostic.version}: all checks passed.`);
}finally{
  if(helper?.pid&&helper.exitCode===null){await run(path.join(process.env.SystemRoot||"C:\\Windows","System32","taskkill.exe"),["/PID",String(helper.pid),"/T","/F"]);await new Promise(resolve=>helper.exitCode!==null?resolve():helper.once("exit",resolve));}
  if(mediaServer?.listening)await new Promise(resolve=>mediaServer.close(resolve));
  assert.equal(path.dirname(path.resolve(fixture)),path.resolve(os.tmpdir()));assert.ok(path.basename(fixture).startsWith("yapw-standalone-"));
  await fs.rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
