import assert from "node:assert/strict";
import {promises as fs,existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import http from "node:http";
import { ID, youtubeSource, youtubeTrack, importPlan, audioPath, time, escapeHTML, isInDownloadQueue, isDownloadFinished } from "../scripts/model.js";
import {Library} from "../scripts/library.js";
import {TrackPreview} from "../scripts/preview.js";
import {miniView, fullView, currentPlaylistView, volumeView} from "../scripts/view.js";
import {Downloads} from "../scripts/downloads.js";
import {Downloader,createHelper} from "../helper/server.mjs";

let passed=0;
async function test(name,callback) { await callback(); console.log(`PASS ${name}`); passed++; }
async function until(check) { const deadline=Date.now()+10000; while(!check()) { if(Date.now()>deadline) throw new Error("Timed out"); await new Promise(r=>setTimeout(r,20)); } }

await test("YouTube links canonicalize and reject unsafe hosts",()=>{
  assert.equal(youtubeSource("https://youtu.be/abcdefghijk?t=12").videoId,"abcdefghijk");
  assert.equal(youtubeSource("https://www.youtube.com/shorts/abcdefghijk").key,"abcdefghijk");
  assert.equal(youtubeSource("https://music.youtube.com/watch?v=abcdefghijk&list=PLabcdefghijklmnop").playlist,true);
  for(const source of ["https://youtube.com.evil.test/watch?v=abcdefghijk","file:///etc/passwd","http://localhost:30000","https://youtube.com:444/watch?v=abcdefghijk","--exec anything"]) assert.throws(()=>youtubeSource(source));
  assert.throws(()=>audioPath("javascript:alert(1)"));
  assert.throws(()=>audioPath("file:///C:/music.mp3"));
  assert.equal(time(3661),"1:01:01"); assert.equal(time(null),"—:——");
  assert.equal(escapeHTML('<img src="x">'),"&lt;img src=&quot;x&quot;&gt;");
});
await test("Installed YouTube Player Widget format imports without duplicates",()=>{
  let id=0;
  const old=[{id:"old",name:"Old library",tracks:[{url:"abcdefghijk",title:"One"},{url:"https://youtu.be/abcdefghijk",title:"Duplicate"},{url:"https://www.youtube.com/watch?v=lmnopqrstuv",title:"Two"}]}];
  const plan=importPlan(old,[],()=>String(++id)); assert.equal(plan[0].tracks.length,2);
  const existing={getFlag:(_,key)=>key==="importKey"?"old":plan[0].tracks};
  assert.equal(importPlan(old,[existing],()=>String(++id))[0].tracks.length,0);
});

function collection(items=[]) {
  return {contents:items,filter:cb=>items.filter(cb),find:cb=>items.find(cb),some:cb=>items.some(cb),get:id=>items.find(i=>i.id===id),has:id=>items.some(i=>i.id===id)};
}
let nextId=0,documents=[],selection={},layerVolumes={},layerPlayback={};
function updateMockSound(sound, changes) {
  const flags = {...sound.flags?.[ID], ...changes.flags?.[ID]};
  Object.assign(sound,changes);
  sound.flags = {...sound.flags,[ID]:flags};
}
function mockPlaylist(data={}) {
  const flags=data.flags?.[ID]??{managed:true,tracks:[]};
  const p={id:`playlist${++nextId}`,name:data.name??"Test",mode:0,playing:false,sounds:collection(),getFlag:(_,key)=>flags[key],setFlag:async(_,key,value)=>{ flags[key]=structuredClone(value); },
    async createEmbeddedDocuments(type,entries) { for(const entry of entries) { p.sounds.contents.push({...entry,id:entry._id,parent:p,playing:false,pausedTime:null,sound:{currentTime:37,duration:123},getFlag:(_,key)=>p.sounds.get(entry._id).flags?.[ID]?.[key],update:async changes=>updateMockSound(p.sounds.get(entry._id),changes)}); } },
    async updateEmbeddedDocuments(type,entries) { for(const entry of entries) updateMockSound(p.sounds.get(entry._id),entry); },
    async deleteEmbeddedDocuments(type,ids) { p.sounds.contents.splice(0,p.sounds.contents.length,...p.sounds.contents.filter(s=>!ids.includes(s.id))); },
    async update(changes) { const {sounds=[],...parent}=changes; Object.assign(p,parent); for(const s of sounds) updateMockSound(p.sounds.get(s._id),s); },
    async stopAll() { p.playing=false; p.sounds.contents.forEach(s=>Object.assign(s,{playing:false})); },
    async playSound(s) { p.sounds.contents.forEach(item=>{ item.playing=item===s; if(item!==s)item.pausedTime=null; }); p.playing=true; },
    async playNext(id,{direction}) { const items=p.sounds.contents; const i=items.findIndex(s=>s.id===id); await p.playSound(items[(i+direction+items.length)%items.length]); },
    async delete() { await p.stopAll(); documents.splice(documents.indexOf(p),1); return p; }
  }; documents.push(p); return p;
}
globalThis.game={user:{id:"gm",isGM:true},users:{activeGM:{id:"gm"}},world:{id:"test-world"},playlists:collection(documents),settings:{get:(_,key)=>key==="selection"?selection:key==="layerVolumes"?layerVolumes:key==="layerPlayback"?layerPlayback:{url:"http://localhost",token:"test"},set:async(_,key,value)=>{if(key==="selection")selection=value;if(key==="layerVolumes")layerVolumes=structuredClone(value);if(key==="layerPlayback")layerPlayback=structuredClone(value);}}};
globalThis.CONFIG={Playlist:{documentClass:{create:async data=>mockPlaylist(data)}}};
globalThis.CONST={PLAYLIST_MODES:{SEQUENTIAL:0,SIMULTANEOUS:2}};
globalThis.foundry={utils:{randomID:()=>`track${++nextId}`}};

await test("Native playback supports pause, synchronized seek, next and GM restriction",async()=>{
  const lib=new Library(); const p=await lib.create("Session");
  await lib.addFile(p.id,"music/first.mp3","First",123); await lib.addFile(p.id,"music/second.mp3","Second",123);
  assert.equal(p.sounds.contents.length,2);
  const first=p.sounds.contents[0],second=p.sounds.contents[1];
  await lib.play(p.id,first.id); assert.equal(first.playing,true);
  await lib.seek(75); assert.equal(first.pausedTime,75); assert.equal(first.playing,true);
  await lib.toggle(); assert.equal(first.playing,false); assert.equal(first.pausedTime,37);
  await lib.toggle(); assert.equal(first.playing,true);
  await lib.step(1); assert.equal(second.playing,true);
  await lib.toggle(); assert.equal(lib.current.id,second.id);
  game.user.isGM=false; await assert.rejects(()=>lib.play(p.id,first.id),/ведущий/); game.user.isGM=true;
  await lib.stop(); assert.equal(p.sounds.contents.some(s=>s.playing),false);
});

await test("Layer repeat defaults on, overrides autoplay, and toggles persist independently across replacement tracks",async()=>{
  const lib=new Library(),p=await lib.create("Playback preferences");
  for(const name of ["main","layer","next"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  const [main,layer,next]=p.sounds.contents;
  assert.deepEqual(lib.playbackOptions(0),{autoplay:true,repeat:true});
  await lib.play(p.id,main.id);await lib.addLayer(p.id,layer.id);
  assert.equal(main.repeat,true);assert.equal(layer.repeat,true);
  await lib.onSoundEnd(main,main.getFlag(ID,"clock").id);
  assert.equal(lib.current,main);assert.equal(main.playing,true);assert.equal(layer.playing,true);
  await lib.togglePlaybackOption(0,"repeat");
  assert.equal(main.repeat,false);assert.equal(layer.repeat,true);assert.equal(lib.playbackOptions(1).repeat,true);
  assert.equal(main.getFlag(ID,"clock").offset,37);
  await lib.onSoundEnd(main,main.getFlag(ID,"clock").id);
  assert.equal(lib.current,next);assert.equal(next.repeat,false);assert.equal(layer.playing,true);
  assert.deepEqual(new Library().playbackOptions(0),{autoplay:true,repeat:false});
  await lib.stop();layerPlayback={};
});

await test("Natural endings advance only the ending layer, skip occupied tracks, wrap the playlist and stop when autoplay is disabled",async()=>{
  const lib=new Library(),p=await lib.create("Independent autoplay");
  for(const name of ["a","b","c","d"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  const [a,b,c,d]=p.sounds.contents;
  await lib.togglePlaybackOption(0,"repeat");await lib.togglePlaybackOption(1,"repeat");
  await lib.play(p.id,a.id);await lib.addLayer(p.id,b.id);
  await lib.onSoundEnd(b,b.getFlag(ID,"clock").id);
  assert.equal(lib.soundAt(1),c);assert.equal(a.playing,true);assert.equal(b.playing,false);
  await lib.onSoundEnd(a,a.getFlag(ID,"clock").id);
  assert.equal(lib.current,b);assert.equal(c.playing,true);
  await lib.onSoundEnd(c,c.getFlag(ID,"clock").id);assert.equal(lib.soundAt(1),d);
  await lib.onSoundEnd(d,d.getFlag(ID,"clock").id);assert.equal(lib.soundAt(1),a);
  await lib.togglePlaybackOption(1,"autoplay");await lib.onSoundEnd(a,a.getFlag(ID,"clock").id);
  assert.equal(a.playing,false);assert.equal(a.pausedTime,null);assert.equal(lib.soundAt(1),undefined);assert.equal(b.playing,true);
  await lib.stop();layerPlayback={};
});

await test("Duplicate or obsolete end callbacks and a non-active GM cannot advance playback",async()=>{
  const lib=new Library(),p=await lib.create("End race");
  for(const name of ["a","b","c"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  const [a,b]=p.sounds.contents;
  await lib.togglePlaybackOption(0,"repeat");await lib.play(p.id,a.id);
  const old=a.getFlag(ID,"clock").id;await lib.seek(50);
  await lib.onSoundEnd(a,old);assert.equal(lib.current,a);assert.equal(a.playing,true);
  const current=a.getFlag(ID,"clock").id;
  game.users.activeGM.id="other";await lib.onSoundEnd(a,current);assert.equal(lib.current,a);game.users.activeGM.id="gm";
  await Promise.all([lib.onSoundEnd(a,current),lib.onSoundEnd(a,current)]);
  assert.equal(lib.current,b);assert.equal(p.sounds.contents.filter(s=>s.playing).length,1);
  await lib.stop();layerPlayback={};
});

await test("Batch YouTube additions validate atomically, deduplicate links and preserve the entered name",async()=>{
  const lib=new Library(),p=await lib.create("Batch");
  await assert.rejects(()=>lib.addYoutubeBatch(p.id,["abcdefghijk","invalid-link"]));assert.equal(lib.tracks(p).length,0);
  const added=await lib.addYoutubeBatch(p.id,["abcdefghijk","https://youtu.be/abcdefghijk","lmnopqrstuv"],"Custom");
  assert.equal(added.length,2);assert.ok(added.every(t=>t.customName&&t.name==="Custom"));
  assert.equal((await lib.addYoutubeBatch(p.id,["abcdefghijk","slowvideo01"])).length,1);
  assert.equal(lib.tracks(p).length,3);
});

await test("Foundry import copies chosen native playlists in order, retains originals and adds only newly discovered sounds",async()=>{
  const lib=new Library(),source=mockPlaylist({name:"Native music",flags:{[ID]:{managed:false}}});
  await source.createEmbeddedDocuments("PlaylistSound",[{_id:"native-b",name:"Rain",path:"music/rain.ogg",sort:2},{_id:"native-a",name:"Wind",path:"music/wind.ogg",sort:1}]);
  source.sounds.get("native-a").playing=true;
  const original=source.sounds.contents.map(s=>({id:s.id,playing:s.playing,path:s.path}));
  assert.ok(lib.foundryPlaylists.includes(source));
  assert.deepEqual(await lib.importFoundry([source.id]),{playlists:1,tracks:2});
  const target=lib.playlists.find(p=>p.getFlag(ID,"foundryImportId")===source.id);
  assert.deepEqual(lib.tracks(target).map(t=>t.name),["Wind","Rain"]);assert.equal(target.sounds.contents.length,2);
  assert.deepEqual(source.sounds.contents.map(s=>({id:s.id,playing:s.playing,path:s.path})),original);
  assert.deepEqual(await lib.importFoundry([source.id]),{playlists:0,tracks:0});
  await source.createEmbeddedDocuments("PlaylistSound",[{_id:"native-c",name:"Fire",path:"music/fire.ogg",sort:3}]);
  assert.deepEqual(await lib.importFoundry([source.id]),{playlists:1,tracks:1});assert.equal(target.sounds.contents.length,3);
  assert.equal(lib.foundryPlaylists.includes(target),false);
});

await test("Switching playlists clears old pause positions and pausing keeps the newly selected track",async()=>{
  const lib=new Library(),a=await lib.create("First playlist"),b=await lib.create("Second playlist");
  await lib.addFile(a.id,"music/first-playlist.mp3","First",123);await lib.addFile(b.id,"music/second-playlist.mp3","Second",123);
  const first=a.sounds.contents[0],second=b.sounds.contents[0];
  await lib.play(a.id,first.id);await lib.seek(50);await lib.toggle();
  assert.equal(first.pausedTime,37);
  await lib.play(b.id,second.id);
  assert.equal(first.playing,false);assert.equal(first.pausedTime,null);
  await lib.toggle();assert.equal(lib.current.id,second.id);assert.equal(lib.current.parent.id,b.id);assert.equal(second.playing,false);assert.equal(second.pausedTime,37);
  assert.deepEqual(lib.playlists.flatMap(p=>p.sounds.contents).filter(s=>s.playing||s.pausedTime!=null).map(s=>s.id),[second.id]);
  await lib.toggle();assert.equal(second.playing,true);assert.equal(first.playing,false);
  await lib.stop();assert.equal(lib.playlists.flatMap(p=>p.sounds.contents).some(s=>s.playing||s.pausedTime!=null),false);
});
await test("Existing stale playback is repaired on load while the selected paused track and unrelated audio stay intact",async()=>{
  const lib=new Library(),a=await lib.create("Stale first"),b=await lib.create("Selected pause");
  await lib.addFile(a.id,"music/stale.mp3","Stale",123);await lib.addFile(b.id,"music/selected.mp3","Selected",123);
  const first=a.sounds.contents[0],second=b.sounds.contents[0];
  first.playing=true;first.pausedTime=0;second.playing=false;second.pausedTime=151;
  await game.settings.set(ID,"selection",{playlistId:b.id,trackId:second.id});
  const foreign=mockPlaylist({flags:{[ID]:{managed:false,tracks:[]}}});foreign.sounds.contents.push({id:"ambient",playing:true,pausedTime:null});
  await lib.normalizePlayback();
  assert.equal(first.playing,false);assert.equal(first.pausedTime,null);assert.equal(second.pausedTime,151);assert.equal(lib.current,second);assert.equal(foreign.sounds.contents[0].playing,true);
  // Even if old paused rows reappear, the explicit selection wins over their order.
  first.pausedTime=5;assert.equal(lib.current,second);await lib.stop();
});
await test("The widget starts only one sound even when a native playlist uses simultaneous mode",async()=>{
  const lib=new Library(),p=await lib.create("Simultaneous native playlist");
  await lib.addFile(p.id,"music/mode-first.mp3","First",123);await lib.addFile(p.id,"music/mode-second.mp3","Second",123);
  p.mode=2;p.playSound=async sound=>{p.playing=true;sound.playing=true;};
  const [a,b]=p.sounds.contents;await lib.play(p.id,a.id);a.pausedTime=12;await lib.play(p.id,b.id);
  assert.equal(a.playing,false);assert.equal(a.pausedTime,null);assert.equal(b.playing,true);assert.equal(p.mode,2);
  await lib.stop();
});
await test("A pause queued immediately after switching playlists applies to the new track",async()=>{
  const lib=new Library(),a=await lib.create("Rapid first"),b=await lib.create("Rapid second");
  await lib.addFile(a.id,"music/rapid-first.mp3","First",123);await lib.addFile(b.id,"music/rapid-second.mp3","Second",123);
  const first=a.sounds.contents[0],second=b.sounds.contents[0];await lib.play(a.id,first.id);
  await Promise.all([lib.play(b.id,second.id),lib.toggle()]);
  assert.equal(first.playing,false);assert.equal(first.pausedTime,null);assert.equal(second.playing,false);assert.equal(second.pausedTime,37);assert.equal(lib.current,second);await lib.stop();
});
await test("Explicit layers play together, keep a paused primary selected and stop independently",async()=>{
  const lib=new Library(),a=await lib.create("Mix primary"),b=await lib.create("Mix layer");
  await lib.addFile(a.id,"music/main.mp3","Main",123);await lib.addFile(a.id,"music/sibling.mp3","Sibling",123);await lib.addFile(b.id,"music/rain.mp3","Rain",123);
  const [first,sibling]=a.sounds.contents,layer=b.sounds.contents[0];
  await lib.play(a.id,first.id);first.sound.currentTime=64;
  await lib.addLayer(b.id,layer.id);assert.equal(first.playing,true);assert.equal(layer.playing,true);assert.equal(first.sound.currentTime,64);assert.equal(lib.current,first);assert.equal(b.mode,2);
  await lib.addLayer(b.id,layer.id);assert.equal(lib.layers.length,1);
  await lib.seek(80);assert.equal(first.pausedTime,80);assert.equal(layer.playing,true);
  await lib.toggle();assert.equal(first.playing,false);assert.equal(layer.playing,true);assert.equal(lib.current,first);assert.equal(lib.playing,true);
  await lib.normalizePlayback();assert.equal(layer.playing,true);assert.equal(lib.current,first);
  await lib.toggle();assert.equal(first.playing,true);
  await lib.step(1);assert.equal(lib.current,sibling);assert.equal(first.playing,false);assert.equal(first.pausedTime,null);assert.equal(layer.playing,true);
  await lib.stopTrack(b.id,layer.id);assert.equal(layer.playing,false);assert.equal(layer.pausedTime,null);assert.equal(b.mode,0);assert.equal(b.getFlag(ID,"mixMode"),null);assert.equal(sibling.playing,true);
  await lib.play(b.id,layer.id);assert.equal(sibling.playing,false);assert.equal(sibling.pausedTime,null);assert.equal(lib.layers.length,0);
  await lib.stopTrack(b.id,layer.id);assert.equal(layer.pausedTime,null);assert.equal(lib.playing,false);
  await lib.play(b.id,layer.id);assert.equal(layer.pausedTime,null);await lib.stop();
});
await test("Same-playlist layers preserve mode, survive reload and move without interrupting the other sound",async()=>{
  const lib=new Library(),p=await lib.create("Same-playlist mix"),to=await lib.create("Move mix");
  await lib.addFile(p.id,"music/a.mp3","A",123);await lib.addFile(p.id,"music/b.mp3","B",123);
  const [a,b]=p.sounds.contents;await lib.play(p.id,a.id);await lib.addLayer(p.id,b.id);
  assert.equal(a.playing,true);assert.equal(b.playing,true);assert.equal(p.mode,2);assert.equal(p.getFlag(ID,"mixMode"),0);
  const restored=new Library();await restored.normalizePlayback();assert.equal(restored.current,a);assert.equal(restored.layers[0],b);assert.equal(a.playing,true);assert.equal(b.playing,true);
  await restored.transferTrack(p.id,b.id,to.id);const moved=to.sounds.get(b.id);assert.equal(a.playing,true);assert.equal(moved.playing,true);assert.equal(moved.pausedTime,37);assert.equal(restored.current,a);assert.equal(restored.layers[0],moved);assert.equal(to.mode,2);assert.equal(p.mode,0);
  await restored.transferTrack(p.id,a.id,to.id);const primary=to.sounds.get(a.id);assert.equal(restored.current,primary);assert.equal(moved.playing,true);assert.equal(primary.playing,true);
  await restored.stopTrack(to.id,a.id);assert.equal(primary.pausedTime,null);assert.equal(primary.playing,false);assert.equal(restored.current,primary);assert.equal(restored.soundAt(1),moved);assert.equal(moved.playing,true);assert.equal(to.mode,2);
  await restored.stop();assert.equal(moved.pausedTime,null);assert.equal(restored.playing,false);
});
await test("A finished or deleted layer is pruned and sequential mode is restored",async()=>{
  const lib=new Library(),p=await lib.create("Layer lifecycle");
  for(const name of ["One","Two","Three"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  const [a,b,c]=p.sounds.contents;await lib.play(p.id,a.id);await lib.addLayer(p.id,b.id);
  b.playing=false;b.pausedTime=null;await lib.normalizePlayback();assert.equal(a.playing,true);assert.equal(p.mode,0);assert.equal(lib.layers.length,0);
  await lib.addLayer(p.id,b.id);a.playing=false;a.pausedTime=null;await lib.normalizePlayback();assert.equal(lib.current,a);assert.equal(lib.soundAt(1),b);assert.equal(b.playing,true);assert.equal(p.mode,2);
  await lib.addLayer(p.id,c.id);assert.equal(b.playing,false);await lib.removeTrack(p.id,c.id);assert.equal(p.mode,0);assert.equal(lib.layers.length,0);
  const extra=await lib.create("Deleted primary");await lib.addFile(extra.id,"music/extra.mp3","Extra",123);await lib.play(extra.id,extra.sounds.contents[0].id);await lib.addLayer(p.id,b.id);
  await lib.removePlaylists([extra.id]);assert.equal(lib.current,undefined);assert.equal(lib.soundAt(1),b);assert.equal(b.playing,true);assert.equal(p.mode,2);await lib.stop();
});

await test("Starting any main track preserves the exact secondary sound and its timeline, including in the same playlist",async()=>{
  const lib=new Library(),p=await lib.create("Main and secondary"),q=await lib.create("Other main");
  for(const name of ["Main A","Main B","Secondary"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  await lib.addFile(q.id,"music/other.mp3","Other main",123);
  const [a,b,secondary]=p.sounds.contents,other=q.sounds.contents[0];
  await lib.play(p.id,a.id);await lib.addLayer(p.id,secondary.id);secondary.sound.currentTime=82;secondary.pausedTime=12;
  const assertSecondary=()=>{assert.equal(lib.soundAt(1),secondary);assert.equal(secondary.playing,true);assert.equal(secondary.sound.currentTime,82);assert.equal(secondary.pausedTime,12);};
  await lib.play(p.id,b.id);assertSecondary();assert.equal(a.playing,false);assert.equal(a.pausedTime,null);assert.equal(lib.current,b);assert.equal(p.mode,2);
  await lib.play(q.id,other.id);assertSecondary();assert.equal(b.playing,false);assert.equal(lib.current,other);
  await lib.normalizePlayback();assertSecondary();
  await lib.toggle();assertSecondary();assert.equal(other.playing,false);await lib.toggle();assertSecondary();
  await lib.stopLayer(0);assertSecondary();assert.equal(other.pausedTime,null);assert.equal(lib.current,other);
  await lib.play(p.id,a.id);await lib.step(1);assert.equal(lib.current,b);assertSecondary();await lib.stop();
});
await test("Secondary transport, seek and replacement are independent and its saved volume follows subsequent tracks",async()=>{
  const lib=new Library(),p=await lib.create("Independent mixer"),q=await lib.create("New secondary");
  for(const name of ["Primary","Layer A","Layer B"])await lib.addFile(p.id,`music/${name}.mp3`,name,123);
  await lib.addFile(q.id,"music/rain.mp3","Rain",123);const [primary,a,b]=p.sounds.contents,rain=q.sounds.contents[0];
  await lib.play(p.id,primary.id);await lib.addLayer(p.id,a.id);primary.sound.currentTime=67;
  const assertPrimary=()=>{assert.equal(lib.current,primary);assert.equal(primary.playing,true);assert.equal(primary.sound.currentTime,67);assert.equal(primary.pausedTime,null);};
  await lib.setVolume(1,0.23);assert.equal(a.volume,0.23);assert.equal(primary.volume,0.8);assertPrimary();
  await lib.seek(91,1);assert.equal(a.pausedTime,91);assertPrimary();
  await lib.toggle(1);assert.equal(a.playing,false);assert.equal(a.pausedTime,37);assertPrimary();await lib.toggle(1);assert.equal(a.playing,true);assertPrimary();
  await lib.step(1,1);assert.equal(a.playing,false);assert.equal(a.pausedTime,null);assert.equal(lib.soundAt(1),b);assert.equal(b.volume,0.23);assertPrimary();
  await lib.step(-1,1);assert.equal(lib.soundAt(1),a);assert.equal(a.volume,0.23);assertPrimary();
  await lib.addLayer(q.id,rain.id);assert.equal(a.playing,false);assert.equal(a.pausedTime,null);assert.equal(lib.soundAt(1),rain);assert.equal(rain.volume,0.23);assert.equal(lib.layers.length,1);assertPrimary();
  await lib.stopLayer(1);assert.equal(rain.playing,false);assert.equal(rain.pausedTime,null);assert.equal(lib.layers.length,0);assertPrimary();
  const restored=new Library();assert.equal(restored.volumeFor(1),0.23);await restored.addLayer(p.id,b.id);assert.equal(b.volume,0.23);assertPrimary();
  await restored.setVolume(0,0.61);assert.equal(primary.volume,0.61);assert.equal(b.volume,0.23);await restored.stop();await restored.play(q.id,rain.id);assert.equal(rain.volume,0.61);
  game.user.isGM=false;await assert.rejects(()=>restored.setVolume(1,0.1),/ведущий/);game.user.isGM=true;assert.equal(restored.volumeFor(1),0.23);await restored.stop();layerVolumes={};
});
await test("The secondary remains on its slot after main deletion and movement, including a muted saved volume",async()=>{
  const lib=new Library(),main=await lib.create("Remove main"),p=await lib.create("Keep secondary"),to=await lib.create("Moved secondary");
  await lib.addFile(main.id,"music/main.mp3","Main",123);await lib.addFile(p.id,"music/layer.mp3","Layer",123);
  await lib.play(main.id,main.sounds.contents[0].id);await lib.setVolume(1,0);await lib.addLayer(p.id,p.sounds.contents[0].id);
  const secondary=lib.soundAt(1);assert.equal(secondary.volume,0);await lib.removePlaylists([main.id]);assert.equal(lib.current,undefined);assert.equal(lib.soundAt(1),secondary);
  await lib.transferTrack(p.id,secondary.id,to.id);assert.equal(lib.current,undefined);assert.equal(lib.soundAt(1).parent,to);assert.equal(lib.soundAt(1).volume,0);
  await lib.normalizePlayback();assert.equal(lib.soundAt(1).playing,true);await lib.stop();assert.equal(lib.volumeFor(1),0);layerVolumes={};
});
await test("Both player views keep secondary controls below the primary and consolidate faders in the volume popup",async()=>{
  const lib=new Library(),p=await lib.create("Visible layers");await lib.addFile(p.id,"music/primary.mp3","Visible primary",123);await lib.addFile(p.id,"music/secondary.mp3","Visible secondary",123);
  const [primary,secondary]=p.sounds.contents;await lib.play(p.id,primary.id);await lib.addLayer(p.id,secondary.id);await lib.setVolume(1,0.34);
  const ui={library:lib,selected:p.id,tab:"library",query:"",downloads:{online:true,message:"Test"},currentPlaylist:p};
  for(const markup of [miniView(lib,ui),fullView(ui)]){
    assert.ok(markup.indexOf('data-playback-layer="0"')<markup.indexOf('data-playback-layer="1"'));assert.match(markup,/aria-label="Второй слой"/);assert.match(markup,/Пауза второго слоя/);assert.match(markup,/Следующий трек второго слоя/);assert.match(markup,/Остановить второй слой/);assert.doesNotMatch(markup,/data-layer-volume=/);assert.match(volumeView(lib),/data-local-layer-volume="1"[^>]*value="0.34"/);assert.match(markup,/Позиция: Второй слой/);
  }
  game.user.isGM=false;const playerView=miniView(lib,ui);assert.doesNotMatch(playerView,/Пауза второго слоя/);assert.match(volumeView(lib),/data-local-layer-volume="1"/);assert.doesNotMatch(playerView,/data-layer-volume="1"/);game.user.isGM=true;await lib.stop();layerVolumes={};
});

const auditionSounds=[];
class AuditionSound extends EventTarget {
  constructor(path){super();this.path=path;this.duration=200;this.playing=false;auditionSounds.push(this);}
  async load(){if(this.pending)await this.pending;return this;}
  async play(options){this.options=options;this.currentTime=options.offset;this.playing=true;}
  async stop(options){assert.equal(options.fade,0);this.playing=false;this.disposed=true;}
}
foundry.audio={Sound:AuditionSound};game.audio={music:{}};
await test("Audition is local, GM-only, begins at 30–50%, toggles and cleans up on end",async()=>{
  const lib=new Library(),p=await lib.create("Local audition");await lib.addFile(p.id,"music/preview.mp3","Preview",200);const track=p.sounds.contents[0];
  await lib.play(p.id,track.id);const before=structuredClone(selection),flags=lib.tracks(p);let changes=0;
  const preview=new TrackPreview(()=>changes++);game.user.isGM=false;await assert.rejects(()=>preview.toggle(p,track.id),/ведущему/);game.user.isGM=true;
  await preview.toggle(p,track.id);const sound=preview.active.sound;assert.equal(sound.path,track.path);assert.equal(sound.playing,true);assert.ok(sound.options.offset>=60&&sound.options.offset<=100);assert.equal(sound.options.volume,0.8);assert.equal(sound.options.loop,false);
  assert.equal(track.playing,true);assert.deepEqual(selection,before);assert.deepEqual(lib.tracks(p),flags);assert.equal(track.pausedTime,null);assert.ok(changes>0);
  await preview.toggle(p,track.id);assert.equal(preview.active,null);assert.equal(sound.disposed,true);
  await preview.toggle(p,track.id);const ended=preview.active.sound;ended.dispatchEvent(new Event("end"));await Promise.resolve();assert.equal(preview.active,null);assert.equal(ended.disposed,true);
  await lib.stop();
});
await test("Cancelled or replaced audition loads cannot start later, and load failure clears state",async()=>{
  const lib=new Library(),p=await lib.create("Audition race");await lib.addFile(p.id,"music/a.mp3","A",200);await lib.addFile(p.id,"music/b.mp3","B",200);const [a,b]=p.sounds.contents;
  let release;const pending=new Promise(resolve=>release=resolve),oldLoad=AuditionSound.prototype.load;
  AuditionSound.prototype.load=async function(){if(this.path===a.path)await pending;return this;};
  const preview=new TrackPreview(),slow=preview.toggle(p,a.id);await until(()=>preview.active?.trackId===a.id);const obsolete=preview.active.sound;
  await preview.toggle(p,b.id);assert.equal(preview.active.trackId,b.id);release();await slow;assert.equal(obsolete.playing,false);assert.equal(obsolete.disposed,true);assert.equal(preview.active.trackId,b.id);
  await preview.stop();
  const first=preview.toggle(p,a.id),second=preview.toggle(p,b.id);await Promise.all([first,second]);assert.equal(preview.active.trackId,b.id);assert.equal(auditionSounds.filter(s=>s.playing).length,1);await preview.stop();
  AuditionSound.prototype.load=async function(){this.failed=true;return this;};await assert.rejects(()=>preview.toggle(p,a.id),/Не удалось/);assert.equal(preview.active,null);
  AuditionSound.prototype.load=oldLoad;
});
await test("Track controls expose audition, layer and complete stop without order arrows, including the mini list",async()=>{
  const lib=new Library(),p=await lib.create("Controls");await lib.addFile(p.id,"music/control.mp3","Control",123);const sound=p.sounds.contents[0];await lib.play(p.id,sound.id);
  const ui={library:lib,selected:p.id,tab:"library",query:"",downloads:{online:true,message:"Test"},currentPlaylist:p,preview:new TrackPreview()};
  for(const markup of [fullView(ui),currentPlaylistView(ui)]){assert.match(markup,/data-action="preview"/);assert.match(markup,/data-action="add-layer"/);assert.match(markup,/data-action="stop-track"/);assert.doesNotMatch(markup,/data-action="(?:up|down)"/);}
  game.user.isGM=false;assert.doesNotMatch(currentPlaylistView(ui),/data-action="(?:preview|add-layer)"/);game.user.isGM=true;await lib.stop();
});

await test("Queue application expands playlists, preserves custom names and creates native sounds",async()=>{
  const lib=new Library(),p=await lib.create("YouTube");
  await lib.addYoutube(p.id,"https://www.youtube.com/playlist?list=PLabcdefghijklmnop");
  const queue=new Downloads(lib,()=>{}); let serial=0;
  queue.request=async(endpoint,body)=>{
    if(!body)return {jobs:[]};
    return {id:`job${++serial}`,status:"ready",progress:100,result:body.kind==="resolve"?{entries:[{name:"One",source:"https://youtu.be/abcdefghijk",sourceKey:"abcdefghijk",duration:50},{name:"Dup",source:"https://youtu.be/abcdefghijk",sourceKey:"abcdefghijk",duration:50}]}:{name:"Resolved",duration:50,path:"modules/test/song.mp3",cover:"modules/test/cover.jpg"}};
  };
  await queue.tick(); assert.equal(lib.tracks(p).length,1); assert.equal(lib.tracks(p)[0].kind,"track");
  await lib.edit(p.id,tracks=>Object.assign(tracks[0],{name:"Custom",customName:true}));
  await queue.tick(); assert.equal(lib.tracks(p)[0].status,"ready"); assert.equal(lib.tracks(p)[0].name,"Custom"); assert.equal(p.sounds.contents.length,1);
});

await test("Drag ordering updates native sound order without restarting the current track",async()=>{
  const lib=new Library(),p=await lib.create("Reorder");
  for(const name of ["First","Second","Third"])await lib.addFile(p.id,`music/${name}.mp3`,name,90);
  const [a,b,c]=lib.tracks(p); await lib.play(p.id,a.id);
  const sound=p.sounds.get(a.id);
  await lib.transferTrack(p.id,a.id,p.id,null);
  assert.deepEqual(lib.tracks(p).map(t=>t.id),[b.id,c.id,a.id]);
  assert.equal(p.sounds.get(a.id),sound); assert.equal(sound.playing,true);
  assert.deepEqual([b,c,a].map(t=>p.sounds.get(t.id).sort),[0,1000,2000]);
  await lib.transferTrack(p.id,a.id,p.id,b.id);
  assert.deepEqual(lib.tracks(p).map(t=>t.id),[a.id,b.id,c.id]);
  await lib.transferTrack(p.id,a.id,p.id,a.id);
  assert.deepEqual(lib.tracks(p).map(t=>t.id),[a.id,b.id,c.id]);
});
await test("Moving a playing or paused track preserves playback position and destination order",async()=>{
  const lib=new Library(),from=await lib.create("From"),to=await lib.create("To");
  await lib.addFile(from.id,"music/current.mp3","Current",123);await lib.addFile(to.id,"music/last.mp3","Last",123);
  const track=lib.tracks(from)[0],last=lib.tracks(to)[0];
  await lib.play(from.id,track.id);await lib.transferTrack(from.id,track.id,to.id,last.id);
  assert.equal(lib.tracks(from).length,0);assert.equal(from.sounds.has(track.id),false);
  assert.deepEqual(lib.tracks(to).map(t=>t.id),[track.id,last.id]);
  assert.equal(lib.current.parent.id,to.id);assert.equal(to.sounds.get(track.id).pausedTime,37);assert.equal(to.sounds.get(track.id).playing,true);
  await lib.toggle(); to.sounds.get(track.id).pausedTime=61;
  await lib.transferTrack(to.id,track.id,from.id);
  assert.equal(from.sounds.get(track.id).playing,false);assert.equal(from.sounds.get(track.id).pausedTime,61);
  assert.equal(lib.current.parent.id,from.id);
});
await test("Pending downloads and file uploads follow their track after moving playlists",async()=>{
  const lib=new Library(),from=await lib.create("Pending source"),to=await lib.create("Pending destination");
  const youtube=await lib.addYoutube(from.id,"https://youtu.be/abcdefghijk");
  await lib.edit(from.id,tracks=>Object.assign(tracks[0],{status:"downloading",progress:42,jobId:"existing-job"}));
  await lib.transferTrack(from.id,youtube.id,to.id);
  assert.equal(lib.tracks(to)[0].jobId,"existing-job");assert.equal(lib.tracks(to)[0].progress,42);
  const uploadId=foundry.utils.randomID();
  await lib.edit(from.id,tracks=>tracks.push({id:uploadId,name:"Uploading",type:"upload",status:"uploading"}));
  await lib.transferTrack(from.id,uploadId,to.id);
  await lib.updateTrack(uploadId,t=>Object.assign(t,{status:"ready",path:"music/upload.mp3",duration:99}));
  assert.equal(lib.tracks(from).length,0);assert.equal(lib.tracks(to).find(t=>t.id===uploadId).status,"ready");assert.equal(to.sounds.has(uploadId),true);
});
await test("A failed cross-playlist move restores both playlists without losing or duplicating a track",async()=>{
  const lib=new Library(),from=await lib.create("Rollback source"),to=await lib.create("Rollback destination");
  await lib.addFile(from.id,"music/rollback.mp3","Rollback",100);
  const track=lib.tracks(from)[0],save=from.setFlag;let fail=true;
  from.setFlag=async(...args)=>{if(fail){fail=false;throw new Error("Simulated save failure");}return save(...args);};
  await assert.rejects(()=>lib.transferTrack(from.id,track.id,to.id),/Simulated/);
  assert.equal(lib.tracks(from)[0].id,track.id);assert.equal(lib.tracks(to).length,0);assert.equal(to.sounds.has(track.id),false);
  game.user.isGM=false;await assert.rejects(()=>lib.transferTrack(from.id,track.id,to.id),/ведущий/);game.user.isGM=true;
  await assert.rejects(()=>lib.transferTrack(from.id,track.id,to.id,"missing-track"),/Порядок/);
  await lib.transferTrack(from.id,track.id,to.id);assert.equal(lib.tracks(from).length,0);assert.equal(lib.tracks(to)[0].id,track.id);
});
await test("YouTube job submission stays idempotent when its track moves during polling",async()=>{
  const lib=new Library(),from=await lib.create("Race source"),to=await lib.create("Race destination");
  const track=await lib.addYoutube(from.id,"https://youtu.be/lmnopqrstuv"),queue=new Downloads(lib,()=>{}),keys=[];
  let moved=false;
  queue.request=async(endpoint,body)=>{
    if(!body)return {jobs:[]};
    if(body.url===track.source){keys.push(body.key);if(!moved){moved=true;await lib.transferTrack(from.id,track.id,to.id);}}
    return {id:"same-job",status:"ready",progress:100,result:{name:"Resolved",path:"music/resolved.mp3",duration:60,cover:""}};
  };
  await queue.tick();
  assert.equal(new Set(keys).size,1);assert.equal(keys[0],`track:${track.id}`);
  assert.equal(lib.tracks(from).length,0);assert.equal(lib.tracks(to)[0].status,"ready");assert.equal(to.sounds.has(track.id),true);
});

await test("Playlist deletion enforces GM and managed scope, detects cancellation and deletes only confirmed IDs",async()=>{
  const lib=new Library(),first=await lib.create("Delete me"),last=await lib.create("Also delete");
  const foreign=mockPlaylist({name:"Other Foundry playlist",flags:{[ID]:{managed:false,tracks:[]}}});
  await lib.addFile(first.id,"music/delete.mp3","Current",123); await lib.play(first.id,lib.tracks(first)[0].id);
  game.user.isGM=false; await assert.rejects(()=>lib.removePlaylists([first.id]),/ведущий/); game.user.isGM=true;
  await assert.rejects(()=>lib.removePlaylists([first.id,foreign.id]),/только плейлисты/);
  assert.equal(game.playlists.has(first.id),true);
  const remove=first.delete; first.delete=async()=>undefined;
  await assert.rejects(()=>lib.removePlaylists([first.id]),/отменил удаление/);
  assert.equal(game.settings.get(ID,"selection").playlistId,first.id);
  first.delete=remove;
  assert.equal(await lib.removePlaylists([last.id,last.id,"already-removed"]),1);
  const confirmed=lib.playlists.map(p=>p.id),createdLater=await lib.create("Created after confirmation");
  assert.equal(await lib.removePlaylists(confirmed),confirmed.length);
  assert.deepEqual(lib.playlists.map(p=>p.id),[createdLater.id]);
  assert.equal(game.playlists.has(foreign.id),true); assert.equal(first.playing,false);
  assert.deepEqual(game.settings.get(ID,"selection"),{}); assert.equal(lib.current,undefined);
});

await test("Cancelling one track, a playlist or all preserves scope, files and intent across reconnects",async()=>{
  const lib=new Library(),from=await lib.create("Cancel source"),to=await lib.create("Cancel destination");
  const one=await lib.addYoutube(from.id,"https://youtu.be/abcdefghijk"),two=await lib.addYoutube(from.id,"https://youtu.be/lmnopqrstuv"),other=await lib.addYoutube(to.id,"https://youtu.be/slowvideo01");
  await lib.addFile(from.id,"music/keep.mp3","Keep",100);
  await lib.edit(from.id,tracks=>tracks.push({id:"cancel-upload",type:"upload",status:"queued",name:"Local"}));
  game.user.isGM=false;await assert.rejects(()=>lib.cancelDownloads(),/ведущий/);game.user.isGM=true;
  assert.equal((await lib.cancelDownloads(from.id,one.id)).length,1);
  await lib.transferTrack(from.id,one.id,to.id);
  const queue=new Downloads(lib,()=>{}),sent=[];
  queue.request=async(endpoint,body)=>{sent.push(body);return {cancelled:body.tasks.length};};
  await queue.flushCancellations();
  assert.equal(lib.tracks(to).find(t=>t.id===one.id).status,"cancelled");assert.equal(sent[0].tasks[0].key,`track:${one.id}`);
  assert.equal((await lib.cancelDownloads(from.id)).length,2);
  queue.request=async()=>{throw new Error("offline")};await queue.flushCancellations();
  assert.equal(lib.tracks(from).find(t=>t.id===two.id).cancelRequested,true);
  assert.equal(lib.tracks(from).find(t=>t.id==="cancel-upload").status,"cancelled");
  assert.equal(lib.tracks(from).find(t=>t.type==="file").status,"ready");assert.equal(from.sounds.contents.length,1);
  assert.equal(lib.tracks(to).find(t=>t.id===other.id).status,"queued");
  const reconnected=new Downloads(lib,()=>{});reconnected.request=async()=>({cancelled:1});await reconnected.flushCancellations();
  assert.equal(lib.tracks(from).find(t=>t.id===two.id).status,"cancelled");
  assert.equal((await lib.cancelDownloads()).length,1);await reconnected.flushCancellations();
  await lib.retry(from.id);assert.equal(lib.tracks(from).find(t=>t.id===two.id).status,"cancelled");
  await lib.retry(to.id,one.id);assert.equal(lib.tracks(to).find(t=>t.id===one.id).status,"queued");
  assert.equal(lib.tracks(to).find(t=>t.id===one.id).cancelRequested,false);
  await lib.cancelDownloads();await reconnected.flushCancellations();
});
await test("Late playlist resolution cannot revive cancelled tracks or expand them into new downloads",async()=>{
  const lib=new Library(),p=await lib.create("Cancel race");
  const track=await lib.addYoutube(p.id,"https://www.youtube.com/playlist?list=PLabcdefghijklmnop"),queue=new Downloads(lib,()=>{});
  let submissions=0;
  queue.request=async(endpoint,body)=>{
    if(endpoint==="/jobs/cancel")return {cancelled:1};
    if(!body)return {jobs:[]};
    submissions++;
    await lib.cancelDownloads(p.id,track.id);await queue.flushCancellations();
    return {id:"late-job",status:"ready",result:{entries:[{name:"Late",source:"https://youtu.be/abcdefghijk",sourceKey:"abcdefghijk"}]}};
  };
  await queue.tick();await queue.tick();
  assert.equal(submissions,1);assert.equal(lib.tracks(p).length,1);assert.equal(lib.tracks(p)[0].status,"cancelled");assert.equal(p.sounds.contents.length,0);
});
await test("Cancelling a local file aborts the upload request and never creates a playable sound",async()=>{
  globalThis.Hooks={once:()=>{},on:()=>{}};
  const {PlayerWidget}=await import("../scripts/main.js");
  const lib=new Library(),p=await lib.create("Upload cancellation"),id="abort-local";
  await lib.edit(p.id,tracks=>tracks.push({id,type:"upload",status:"queued",name:"Local"}));
  const originalFetch=globalThis.fetch;let started=false,signal;
  foundry.applications={apps:{FilePicker:{uploadURL:"/upload"}}};
  globalThis.fetch=async(url,options)=>{started=true;signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));};
  const widget={library:lib,uploadFiles:new Map([[id,new File(["sample"],"test.mp3")]]),uploadControllers:new Map(),schedule:()=>{},downloads:{flushCancellations:async()=>{}}};
  try {
    const upload=PlayerWidget.prototype.upload.call(widget,p.id,id);await until(()=>started);
    await PlayerWidget.prototype.cancelDownloads.call(widget,p.id,id);await upload;
    assert.equal(signal.aborted,true);assert.equal(lib.tracks(p)[0].status,"cancelled");assert.equal(p.sounds.contents.length,0);
    assert.equal(widget.uploadFiles.has(id),true);
    const remoteId="remote-cancel-upload";started=false;
    await lib.edit(p.id,tracks=>tracks.push({id:remoteId,type:"upload",status:"queued",name:"Remote cancellation"}));
    widget.uploadFiles.set(remoteId,new File(["remote"],"remote.mp3"));widget.trackDrag={active:true};
    const remoteUpload=PlayerWidget.prototype.upload.call(widget,p.id,remoteId);await until(()=>started);
    await lib.cancelDownloads(p.id,remoteId);PlayerWidget.prototype.refresh.call(widget);await remoteUpload;
    assert.equal(signal.aborted,true);assert.equal(lib.tracks(p).find(t=>t.id===remoteId).status,"cancelled");
  }finally{globalThis.fetch=originalFetch;delete foundry.applications;}
});

await test("Clearing download history preserves playlists, playback and active jobs, and explicit retry reopens an entry",async()=>{
  const lib=new Library(),p=await lib.create("Queue history");
  const complete=await lib.addYoutube(p.id,"https://youtu.be/abcdefghijk"),cancelled=await lib.addYoutube(p.id,"https://youtu.be/lmnopqrstuv"),failed=await lib.addYoutube(p.id,"https://youtu.be/slowvideo01");
  await lib.edit(p.id,tracks=>{
    Object.assign(tracks.find(t=>t.id===complete.id),{status:"ready",path:"music/complete.mp3",progress:100});
    Object.assign(tracks.find(t=>t.id===cancelled.id),{status:"cancelled"});
    Object.assign(tracks.find(t=>t.id===failed.id),{status:"error",error:"Test error"});
    tracks.push({id:"history-upload",type:"upload",name:"Uploaded",status:"ready",path:"music/uploaded.mp3",progress:100});
    tracks.push({id:"history-pending",type:"youtube",name:"Pending",status:"queued",progress:0});
    tracks.push({id:"history-cancelling",type:"youtube",name:"Cancelling",status:"cancelling",cancelRequested:true,progress:47});
  });
  await lib.addFile(p.id,"music/ordinary.mp3","Existing file",50);
  await lib.play(p.id,complete.id);
  const sound=p.sounds.get(complete.id),count=p.sounds.contents.length,playlistIds=lib.playlists.map(p=>p.id);
  const beforeActive=lib.tracks(p).filter(t=>t.id.startsWith("history-p")||t.id==="history-cancelling");
  const expected=lib.playlists.flatMap(p=>lib.tracks(p)).filter(t=>isInDownloadQueue(t)&&isDownloadFinished(t)).length;
  game.user.isGM=false;await assert.rejects(()=>lib.clearDownloadQueue(),/ведущий/);game.user.isGM=true;
  assert.equal(lib.tracks(p).find(t=>t.id===complete.id).queueDismissed,undefined);
  assert.equal(await lib.clearDownloadQueue(),expected);
  assert.deepEqual(lib.playlists.map(p=>p.id),playlistIds);assert.equal(p.sounds.contents.length,count);assert.equal(p.sounds.get(complete.id),sound);assert.equal(sound.playing,true);
  const tracks=new Library().tracks(p);
  for(const id of [complete.id,cancelled.id,failed.id,"history-upload"])assert.equal(isInDownloadQueue(tracks.find(t=>t.id===id)),false);
  assert.deepEqual(tracks.filter(t=>t.id.startsWith("history-p")||t.id==="history-cancelling"),beforeActive);
  assert.equal(tracks.find(t=>t.name==="Existing file").queueDismissed,undefined);assert.equal(await lib.clearDownloadQueue(),0);
  await lib.retry(p.id);assert.equal(lib.tracks(p).find(t=>t.id===failed.id).status,"error");
  await lib.retry(p.id,failed.id);assert.equal(isInDownloadQueue(lib.tracks(p).find(t=>t.id===failed.id)),true);
  await lib.updateTrack(failed.id,t=>Object.assign(t,{status:"ready",path:"music/retried.mp3",progress:100}));
  assert.equal(isInDownloadQueue(lib.tracks(p).find(t=>t.id===failed.id)),true);
  assert.equal(await lib.clearDownloadQueue(),1);assert.equal(sound.playing,true);
});

await test("Queue reconciliation removes only orphaned jobs and preserves moved tracks and other worlds",async()=>{
  const lib=new Library(),from=await lib.create("Sync source"),to=await lib.create("Sync destination");
  const track=await lib.addYoutube(from.id,"https://youtu.be/abcdefghijk");
  await lib.edit(from.id,tracks=>Object.assign(tracks[0],{jobId:"keep-moved-job"}));await lib.transferTrack(from.id,track.id,to.id);
  const jobs=[
    {id:"legacy-orphan",world:game.world.id,key:"AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB",status:"downloading"},
    {id:"canonical-orphan",world:game.world.id,key:"track:deleted-track",status:"queued"},
    {id:"keep-moved-job",world:game.world.id,key:"CCCCCCCCCCCCCCCC:DDDDDDDDDDDDDDDD",status:"queued"},
    {id:"other-world",world:"another-world",key:"track:foreign",status:"queued"},
    {id:"unknown-owner",world:game.world.id,key:"manual-task",status:"queued"},
    {id:"finished-job",world:game.world.id,key:"track:already-ready",status:"ready"}
  ];
  const queue=new Downloads(lib,()=>{}),cancelled=[];
  queue.request=async(endpoint,body)=>{assert.equal(endpoint,"/jobs/cancel");assert.equal(body.world,game.world.id);cancelled.push(...body.tasks.map(t=>t.jobId));return {cancelled:body.tasks.length}};
  game.user.isGM=false;assert.equal(await queue.reconcileJobs(jobs),0);game.user.isGM=true;
  assert.equal(await queue.reconcileJobs(jobs),2);assert.deepEqual(cancelled,["legacy-orphan","canonical-orphan"]);
  assert.equal(lib.tracks(to)[0].id,track.id);assert.equal(lib.tracks(to)[0].status,"queued");
});
await test("An existing queued job is recovered by its stable key without duplicate submission",async()=>{
  const lib=new Library(),p=await lib.create("Recover submission"),track=await lib.addYoutube(p.id,"https://youtu.be/lmnopqrstuv"),queue=new Downloads(lib,()=>{});
  Object.defineProperty(lib,"playlists",{get:()=>[p]});
  const job={id:"recovered-stable-job",world:game.world.id,key:`track:${track.id}`,status:"downloading",progress:23};
  queue.request=async(endpoint,body)=>{assert.equal(body,undefined);return {jobs:[job]}};
  await queue.tick();assert.equal(lib.tracks(p)[0].jobId,job.id);assert.equal(lib.tracks(p)[0].status,"downloading");assert.equal(lib.tracks(p)[0].progress,23);
});

await test("A failed track recovers automatically when the helper restores its completed cached result",async()=>{
  const lib=new Library(),p=await lib.create("Cached error recovery"),track=await lib.addYoutube(p.id,"https://youtu.be/abcdefghijk"),queue=new Downloads(lib,()=>{});
  Object.defineProperty(lib,"playlists",{get:()=>[p]});
  await lib.edit(p.id,tracks=>Object.assign(tracks[0],{status:"error",error:"429",jobId:"cached-job"}));
  queue.request=async(endpoint,body)=>{assert.equal(body,undefined);return {jobs:[{id:"cached-job",key:`track:${track.id}`,status:"ready",progress:100,result:{name:"Cached",duration:198,path:"music/cached.mp3",cover:"music/cached.jpg"}}]}};
  await queue.tick();assert.equal(lib.tracks(p)[0].status,"ready");assert.equal(lib.tracks(p)[0].error,"");assert.equal(p.sounds.has(track.id),true);
});

const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),"yapw-tests-"));
const options={stateDir:path.join(sandbox,"state"),mediaDir:path.join(sandbox,"media"),command:process.execPath,commandPrefix:[fileURLToPath(new URL("fake-dlp.mjs",import.meta.url))]};
await test("Real worker processes playlist, audio and thumbnail, persists errors and retries",async()=>{
  const queue=new Downloader(options); await queue.init();
  const playlist=await queue.enqueue({world:"test",key:"playlist",kind:"resolve",url:"https://www.youtube.com/playlist?list=PLabcdefghijklmnop"});
  const success=await queue.enqueue({world:"test",key:"track",kind:"download",url:"https://youtu.be/abcdefghijk"});
  const failure=await queue.enqueue({world:"test",key:"error",kind:"download",url:"https://youtu.be/errorerror1"});
  await until(()=>!queue.running);
  assert.equal(playlist.result.entries.length,2); assert.equal(success.status,"ready"); assert.match(success.result.cover,/track.jpg$/); assert.equal(failure.status,"error");
  assert.match(failure.error,/unavailable/);
  assert.equal((await queue.enqueue({world:"test",key:"track",kind:"download",url:"https://youtu.be/abcdefghijk"})).id,success.id);
  await queue.enqueue({world:"test",key:"error",kind:"download",url:"https://youtu.be/errorerror1",retry:true}); await until(()=>!queue.running); assert.equal(failure.status,"error");
  await queue.close();
  const restored=new Downloader(options); await restored.init(); assert.equal(restored.jobs.length,3); assert.equal(restored.jobs.find(j=>j.key==="error").status,"error"); await restored.close();
});
await test("Worker restart recovers an interrupted download",async()=>{
  const stateDir=path.join(sandbox,"restart"); await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir,"jobs.json"),JSON.stringify([{id:"recovered",world:"test",key:"recover",kind:"download",url:"https://youtu.be/lmnopqrstuv",status:"downloading"}]));
  const queue=new Downloader({...options,stateDir}); await queue.init(); await until(()=>!queue.running); assert.equal(queue.jobs[0].status,"ready"); await queue.close();
});
await test("Completed audio is reused offline, legacy cached failures recover on startup, and partial files stay unusable",async()=>{
  const stateDir=path.join(sandbox,"cache-state"),queue=new Downloader({...options,stateDir,command:path.join(sandbox,"missing-downloader.exe"),commandPrefix:[]});
  await queue.init();
  const reused=await queue.enqueue({world:"cache",key:"reuse",kind:"download",url:"https://youtu.be/abcdefghijk"});
  await until(()=>!queue.running);assert.equal(reused.status,"ready");assert.match(reused.result.path,/abcdefghijk\/track.mp3$/);await queue.close();
  const legacyId="legacyvid01",dir=path.join(options.mediaDir,legacyId);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"track.mp3"),"old-completed-audio");await fs.writeFile(path.join(dir,"track.info.json"),JSON.stringify({id:legacyId,title:"Legacy",duration:55}));
  const source=`https://youtu.be/${legacyId}`,audioPath=`modules/${ID}/storage/youtube/${legacyId}/track.mp3`;
  await fs.writeFile(path.join(stateDir,"jobs.json"),JSON.stringify([
    {id:"old-success",world:"cache",key:"old",kind:"download",url:source,status:"ready",result:{path:audioPath}},
    {id:"cached-failure",world:"cache",key:"failed",kind:"download",url:source,status:"error",error:"429"},
    {id:"keep-cancelled",world:"cache",key:"cancelled",kind:"download",url:source,status:"cancelled"}
  ]));
  const recovered=new Downloader({...options,stateDir,command:path.join(sandbox,"missing-downloader.exe"),commandPrefix:[]});await recovered.init();
  assert.equal(recovered.jobs.find(j=>j.id==="cached-failure").status,"ready");assert.equal(recovered.jobs.find(j=>j.id==="cached-failure").result.duration,55);
  assert.equal(recovered.jobs.find(j=>j.id==="keep-cancelled").status,"cancelled");
  const partialDir=path.join(options.mediaDir,"partialvid1");await fs.mkdir(partialDir,{recursive:true});
  await fs.writeFile(path.join(partialDir,"track.mp3"),"partial");await fs.writeFile(path.join(partialDir,"track.info.json"),JSON.stringify({id:"partialvid1",title:"Partial"}));
  assert.equal(await recovered.cachedResult({kind:"download",url:"https://youtu.be/partialvid1"}),null);await recovered.close();
});
await test("Cancellation stops the worker process tree, skips queued jobs, survives restart and permits explicit retry",async()=>{
  const cancelOptions={...options,stateDir:path.join(sandbox,"cancel-state"),mediaDir:path.join(sandbox,"cancel-media")};
  const queue=new Downloader(cancelOptions);await queue.init();
  const current=await queue.enqueue({world:"cancel",key:"legacy-track",kind:"download",url:"https://youtu.be/slowvideo01"});
  const pending=await queue.enqueue({world:"cancel",key:"pending",kind:"download",url:"https://youtu.be/lmnopqrstuv"});
  const foreign=await queue.enqueue({world:"other",key:"pending",kind:"download",url:"https://youtu.be/abcdefghijk"});
  const pidFile=path.join(cancelOptions.mediaDir,"slowvideo01","descendant.pid");
  await until(()=>queue.child && current.progress>0);await until(()=>existsSync(pidFile));
  const rootPid=queue.child.pid,descendantPid=Number(await fs.readFile(pidFile,"utf8"));
  await queue.cancel({world:"cancel",tasks:[{key:"track:new-key",jobId:current.id},{key:"pending"}]});
  await until(()=>!queue.running);
  assert.equal(current.status,"cancelled");assert.equal(pending.status,"cancelled");assert.equal(foreign.status,"ready");
  const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
  await until(()=>!alive(rootPid)&&!alive(descendantPid));
  assert.equal(existsSync(path.join(cancelOptions.mediaDir,"lmnopqrstuv","track.mp3")),false);
  const blocked=await queue.enqueue({world:"cancel",key:"track:new-key",kind:"download",url:"https://youtu.be/abcdefghijk"});
  assert.equal(blocked.status,"cancelled");await queue.close();
  const restored=new Downloader(cancelOptions);await restored.init();await until(()=>!restored.running);
  assert.equal(restored.jobs.find(j=>j.id===current.id).status,"cancelled");
  const retry=await restored.enqueue({world:"cancel",key:"track:new-key",kind:"download",url:"https://youtu.be/abcdefghijk",retry:true});
  await until(()=>!restored.running);assert.equal(retry.status,"ready");await restored.close();
});

function request(port,endpoint,{token="secret",origin,method="GET",body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:"127.0.0.1",port,path:endpoint,method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(origin?{Origin:origin}:{}),...(body?{"Content-Type":"application/json"}:{})}},res=>{let text="";res.on("data",chunk=>text+=chunk);res.on("end",()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));});req.on("error",reject);req.end(body?JSON.stringify(body):undefined);
  });
}
await test("HTTP helper requires its key, rejects unknown origins and isolates worlds",async()=>{
  const helper=await createHelper({...options,stateDir:path.join(sandbox,"http"),token:"secret"});
  await new Promise(resolve=>helper.server.listen(0,"127.0.0.1",resolve)); const port=helper.server.address().port;
  try {
    assert.equal((await request(port,"/health")).status,200);
    assert.equal((await request(port,"/health",{token:""})).status,401);
    assert.equal((await request(port,"/health",{origin:"https://evil.test"})).status,403);
    assert.equal((await request(port,"/jobs",{method:"POST",body:{world:"test",key:"safe",kind:"download",url:"http://localhost/private"}})).status,400);
    assert.equal((await request(port,"/jobs",{method:"POST",body:{world:"test",key:"safe",kind:"download",url:"https://youtu.be/abcdefghijk"}})).status,200);
    await until(()=>!helper.downloader.running);
    assert.equal((await request(port,"/jobs?world=test")).body.jobs.length,1);
    assert.equal((await request(port,"/jobs?world=other")).body.jobs.length,0);
    const cancelBody={world:"test",tasks:[{key:"before-enqueue"}]};
    assert.equal((await request(port,"/jobs/cancel",{token:"",method:"POST",body:cancelBody})).status,401);
    assert.equal((await request(port,"/jobs/cancel",{origin:"https://evil.test",method:"POST",body:cancelBody})).status,403);
    assert.equal((await request(port,"/jobs/cancel",{method:"POST",body:{world:"test",tasks:[]}})).status,400);
    assert.equal((await request(port,"/jobs/cancel",{method:"POST",body:cancelBody})).status,200);
    const blocked=await request(port,"/jobs",{method:"POST",body:{world:"test",key:"before-enqueue",kind:"download",url:"https://youtu.be/lmnopqrstuv"}});
    assert.equal(blocked.body.status,"cancelled");
    const target=helper.downloader.jobs.find(j=>j.key==="safe");
    await request(port,"/jobs/cancel",{method:"POST",body:{world:"other",tasks:[{key:"safe",jobId:target.id}]}});
    assert.equal(target.status,"ready");
  } finally { await helper.close(); }
});
await (await import("./sync.mjs")).syncTests(test);
await (await import("./readiness.mjs")).readinessTests(test);
await (await import("./shared-start.mjs")).sharedStartTests(test);
await (await import("./player-view.mjs")).playerViewTests(test);
console.log(`\n${passed} tests passed.`);
