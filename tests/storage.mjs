import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaStorage } from "../helper/storage.mjs";
import { createHelper } from "../helper/server.mjs";
import { Storage } from "../scripts/storage.js";
import { Downloads } from "../scripts/downloads.js";
import { ID } from "../scripts/model.js";

export async function storageTests(test) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "yapw-storage-"));
  const dataDir = path.join(fixture, "Foundry Data"), moduleDir = path.join(dataDir, "modules", ID), stateDir = path.join(fixture, "private");
  const diskA = path.join(fixture, "Другой диск с пробелами"), diskB = path.join(fixture, "Отдельная музыка");
  const storage = new MediaStorage({ moduleDir, stateDir }); let helper;
  const put = async (url, text) => { const file = path.join(dataDir, url); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; };
  const track = (id, playlist = "p1", extra = {}) => ({ id, playlist, name: id, path: `modules/${ID}/storage/uploads/${id}.mp3`, cover: "", ...extra });
  const move = async (playlist, root, tracks) => { await storage.start({ world: "world", playlist, root, tracks }); await storage.task; return storage.status("world", playlist); };
  const finish = async references => storage.finish({ world: "world", id: storage.config.job.id, references });
  let t1 = track("t1"), t2 = track("t2", "p2"), imported = track("imported", "p2", { path: "music/original.ogg" });
  try {
    await storage.init();
    await test("Whole-library migration verifies audio/covers, serves external folders through per-track junctions and retains imported originals", async () => {
      t1.cover = `modules/${ID}/storage/youtube/abcdefghijk/track.jpg`;
      await put(t1.path, "AUDIO_ONE"); await put(t1.cover, "COVER_ONE"); await put(t2.path, "AUDIO_TWO"); await put(imported.path, "ORIGINAL_MUSIC");
      const result = await move(null, diskA, [t1, t2, imported, track("remote", "p1", { path: "https://example.test/music.mp3" })]);
      assert.equal(result.job.status, "ready"); assert.equal(result.job.results.length, 3); assert.equal(result.job.skipped, 1);
      assert.equal(await fs.readFile(path.join(dataDir, "yapw-media/world/t1/audio.mp3"), "utf8"), "AUDIO_ONE");
      assert.equal(await fs.readFile(path.join(diskA, "YetAnotherPlayerWidget/world/t1/cover.jpg"), "utf8"), "COVER_ONE");
      assert.ok((await fs.lstat(path.join(dataDir, "yapw-media/world/t1"))).isSymbolicLink());
      assert.equal(await fs.readFile(path.join(dataDir, t1.path), "utf8"), "AUDIO_ONE", "source survives until Foundry acknowledges new paths");
      const old1 = t1.path; for (const t of [t1,t2,imported]) Object.assign(t, result.job.results.find(r => r.id === t.id));
      await finish([t1.path,t1.cover,t2.path,imported.path]);
      await assert.rejects(fs.stat(path.join(dataDir, old1)), { code: "ENOENT" });
      assert.equal(await fs.readFile(path.join(dataDir, "music/original.ogg"), "utf8"), "ORIGINAL_MUSIC");
    });
    await test("Playlist override moves only its files, new uploads inherit the override and subsequent global moves clear all overrides while keeping URLs", async () => {
      const originalPath = t1.path, otherDirectory = await fs.realpath(path.join(dataDir, "yapw-media/world/t2"));
      let result = await move("p1", diskB, [t1]); assert.equal(result.job.status, "ready");
      await finish([t1.path,t2.path,imported.path]);
      assert.equal(result.job.results[0].path, originalPath);
      assert.equal(await fs.realpath(path.join(dataDir, "yapw-media/world/t2")), otherDirectory);
      const prepared = await storage.prepare("world", "p1", "newUpload"); assert.ok(prepared.directory.startsWith(diskB));
      assert.ok((await storage.prepare("world", "p2", "newOther")).directory.startsWith(diskA));
      result = await move(null, null, [t1,t2,imported]); assert.equal(result.job.status, "ready"); await finish([t1.path,t2.path,imported.path]);
      assert.equal(storage.status("world", "p1").override, false); assert.equal(storage.status("world", "p1").root, null);
      assert.equal((await fs.lstat(path.join(dataDir, "yapw-media/world/t1"))).isSymbolicLink(), false);
      assert.equal(await fs.readFile(path.join(dataDir, originalPath), "utf8"), "AUDIO_ONE");
      await assert.rejects(fs.stat(path.join(diskB, "YetAnotherPlayerWidget/world/t1")), { code: "ENOENT" });
    });
    await test("A missing source or copy failure preserves originals and applies successful tracks independently; shared legacy references prevent deletion", async () => {
      const good = track("shared"), missing = track("missing"); await put(good.path, "SHARED_AUDIO");
      const result = await move("p2", diskB, [{...good,playlist:"p2"},{...missing,playlist:"p2"}]);
      assert.equal(result.job.status, "error"); assert.equal(result.job.results.length, 1); assert.equal(result.job.errors.length, 1);
      await finish([good.path]); assert.equal(await fs.readFile(path.join(dataDir, good.path), "utf8"), "SHARED_AUDIO");
      const originalCopy = storage.copy; storage.copy = async () => { throw new Error("Synthetic disk full"); };
      const before = await fs.realpath(path.join(dataDir, "yapw-media/world/t1"));
      const failure = await move("p1", diskB, [t1]); assert.match(failure.job.errors[0].message, /Synthetic disk full/); await finish([t1.path]);
      assert.equal(await fs.realpath(path.join(dataDir, "yapw-media/world/t1")), before); storage.copy = originalCopy;
      const retry = await move("p1", diskB, [t1]); assert.equal(retry.job.status, "ready"); await finish([t1.path]);
    });
    await test("Foreign destination files are never overwritten, invalid paths are rejected and storage choices survive helper restart", async () => {
      const foreign = path.join(diskA, "YetAnotherPlayerWidget/world/t1"); await fs.mkdir(foreign, { recursive: true }); await fs.writeFile(path.join(foreign, "mine.txt"), "KEEP");
      const result = await move("p1", diskA, [t1]); assert.equal(result.job.status, "error"); await finish([t1.path]);
      assert.equal(await fs.readFile(path.join(foreign, "mine.txt"), "utf8"), "KEEP");
      for (const url of ["../private/cookies.mp3", "C:\\private\\track.mp3", "/etc/track.mp3", "%2e%2e/private.mp3", "music/cookies.txt"]) await assert.rejects(storage.start({world:"world",root:diskA,tracks:[track("unsafe","p1",{path:url})]}));
      const restored = new MediaStorage({ moduleDir, stateDir }); await restored.init(); assert.equal(restored.status("world","p1").playlistRoot, diskA);
      assert.equal(restored.status("another-world").enabled, false);
    });
    await test("Legacy YouTube URLs remain playable for other worlds after moving files and keep working on subsequent disk changes", async () => {
      const old = track("youtube", "p3", { path:`modules/${ID}/storage/youtube/lmnopqrstuv/track.mp3`, cover:`modules/${ID}/storage/youtube/lmnopqrstuv/track.jpg` });
      await put(old.path,"YOUTUBE_AUDIO");await put(old.cover,"YOUTUBE_COVER");
      await put(`modules/${ID}/storage/youtube/lmnopqrstuv/track.info.json`,JSON.stringify({title:"YouTube",duration:123,cookies:"SECRET_NOT_FOR_PUBLIC_METADATA"}));
      const result=await move("p3",diskB,[old]);assert.equal(result.job.status,"ready");
      const updated={...old,...result.job.results[0]};await finish([updated.path,updated.cover]);
      assert.equal(await fs.readFile(path.join(dataDir,old.path),"utf8"),"YOUTUBE_AUDIO");assert.ok((await fs.lstat(path.dirname(path.join(dataDir,old.path)))).isSymbolicLink());
      const info=await fs.readFile(path.join(dataDir,"yapw-media/world/youtube/track.info.json"),"utf8");assert.doesNotMatch(info,/SECRET_NOT_FOR_PUBLIC_METADATA|cookies/);
      await move("p3",diskA,[updated]);await finish([updated.path]);assert.equal(await fs.readFile(path.join(dataDir,old.path),"utf8"),"YOUTUBE_AUDIO");
    });
    await test("A helper restart during the directory switch restores the original pointer without losing media", async () => {
      const world="recovery", id="track", anchor=path.join(dataDir,"yapw-media",world,id), directory=path.join(diskB,"YetAnotherPlayerWidget",world,id);
      await fs.mkdir(anchor,{recursive:true});await storage.mark(anchor,world,id);await fs.writeFile(path.join(anchor,"audio.mp3"),"ORIGINAL");
      const backup=`${anchor}.previous-fixture`,stage=`${directory}.moving-fixture`;
      await fs.mkdir(directory,{recursive:true});await storage.mark(directory,world,id);await fs.writeFile(path.join(directory,"audio.mp3"),"COPIED");
      storage.config.switch={world,track:id,anchor,directory,backup,stage,hadAnchor:true};await storage.save();
      await fs.rename(anchor,backup);await fs.symlink(directory,anchor,process.platform==="win32"?"junction":"dir");
      const restored=new MediaStorage({moduleDir,stateDir});await restored.init();
      assert.equal(await fs.readFile(path.join(anchor,"audio.mp3"),"utf8"),"ORIGINAL");assert.equal((await fs.lstat(anchor)).isSymbolicLink(),false);
      await assert.rejects(fs.stat(directory),{code:"ENOENT"});delete storage.config.switch;
    });
    await test("Storage API authenticates requests, isolates world operations and directs future YouTube downloads to the chosen playlist disk", async () => {
      const serverState=path.join(fixture,"api-state");
      helper=await createHelper({moduleDir,stateDir:serverState,mediaDir:path.join(moduleDir,"storage","youtube"),port:0,token:"storage-fixture",command:process.execPath,commandPrefix:[fileURLToPath(new URL("./fake-dlp.mjs",import.meta.url))]});
      const base=`http://127.0.0.1:${helper.server.address().port}`;
      const request=async(endpoint,body,token="storage-fixture")=>{const response=await fetch(base+endpoint,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return {code:response.status,body:await response.json()};};
      assert.equal((await request("/storage?world=api",null,"")).code,401);
      assert.equal((await request("/storage/move",{world:"api",playlist:"playlist",root:diskB,tracks:[]})).code,200);await helper.downloader.storage.task;
      const status=(await request("/storage?world=api&playlist=playlist")).body;
      assert.equal((await request("/storage/finish",{world:"other",id:status.job.id,references:[]})).code,400);
      assert.equal((await request("/storage/finish",{world:"api",id:status.job.id,references:[]})).code,200);
      let result=await request("/jobs",{world:"api",playlist:"playlist",key:"track:future",kind:"download",url:"https://youtu.be/abcdefghijk"});assert.equal(result.code,200);
      const deadline=Date.now()+10000;while(helper.downloader.running){if(Date.now()>deadline)throw Error("Download fixture timed out");await new Promise(resolve=>setTimeout(resolve,20));}
      const job=helper.downloader.jobs.find(j=>j.key==="track:future");assert.equal(job.status,"ready",job.error);assert.equal(job.result.path,"yapw-media/api/future/track.mp3");
      assert.ok((await fs.stat(path.join(diskB,"YetAnotherPlayerWidget/api/future/track.mp3"))).size>0);
      assert.equal((await request("/storage?world=other")).body.enabled,false);
    });
    await test("Storage client requires the active GM, applies document changes before cleanup and keeps pending operations resumable", async () => {
      const previousGame=globalThis.game;const calls=[];
      try {
        globalThis.game={user:{id:"gm",isGM:true},users:{activeGM:{id:"gm"}},world:{id:"fixture"},playlists:{contents:[]},settings:{set:async()=>{},get:()=>true}};
        const library={playlists:[],tracks:()=>[],applyStorage:async()=>calls.push("apply")};
        let state={job:{id:"job",world:"fixture",status:"ready",finished:false,results:[],errors:[],total:0,done:0}};
        const downloads={busy:false,changed:()=>{},request:async(endpoint,body)=>{calls.push(endpoint);if(endpoint==="/storage/finish"){state.job.finished=true;return state;}if(endpoint==="/storage/prepare"){assert.deepEqual(body,{world:"fixture",playlist:"p",track:"t"});return {prefix:"yapw-media/fixture/t"};}return state;}};
        const client=new Storage(library,downloads);await client.change(null,null,null,true);
        assert.ok(calls.indexOf("apply")<calls.indexOf("/storage/finish"));assert.equal(downloads.storageBusy,false);
        assert.equal(await client.uploadTarget("p","t"),"yapw-media/fixture/t");
        state={job:{id:"failed",status:"error",finished:false,persistError:true,results:[],errors:[],total:0,done:0}};
        const beforeApply=calls.filter(value=>value==="apply").length;
        await assert.rejects(client.change(null,null,null,true),/сохранить состояние/);assert.equal(calls.filter(value=>value==="apply").length,beforeApply);
        game.user.isGM=false;await assert.rejects(client.change(null,null),/ведущий/);
        game.user.isGM=true;game.users.activeGM.id="another";await assert.rejects(client.uploadTarget("p","t"),/ведущий/);
      } finally { globalThis.game=previousGame; }
    });
    await test("A pending YouTube track moved between playlists adopts its destination storage after download polling releases its lock", async () => {
      const previousGame=globalThis.game;
      try {
        let tracks=[{id:"pending",type:"youtube",kind:"track",status:"queued",source:"https://youtu.be/abcdefghijk",name:"Pending"}];
        const playlist={id:"destination",getFlag:()=>tracks};
        const library={playlists:[playlist],tracks:()=>structuredClone(tracks),edit:async(_,callback)=>callback(tracks)};
        game={user:{id:"gm",isGM:true},users:{activeGM:{id:"gm"}},world:{id:"fixture"},settings:{get:()=>({token:"test"})}};
        const downloads=new Downloads(library,()=>{});let placed=false;
        downloads.request=async()=>({jobs:[{id:"job",key:"track:pending",playlist:"source",status:"ready",result:{path:"yapw-media/fixture/pending/track.mp3",name:"Downloaded"}}]});
        downloads.storage={place:async(playlist,id)=>{assert.equal(downloads.busy,false);assert.equal(tracks[0].status,"ready");assert.equal(playlist,"destination");assert.equal(id,"pending");placed=true;}};
        await downloads.tick();assert.equal(placed,true);
      } finally { globalThis.game=previousGame; }
    });
  } finally {
    await helper?.close(); await storage.close();
    assert.equal(path.dirname(path.resolve(fixture)),path.resolve(os.tmpdir()));assert.ok(path.basename(fixture).startsWith("yapw-storage-"));
    await fs.rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
