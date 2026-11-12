// Real Foundry document schemas and native Playlist methods, with an in-memory update adapter.
// Does not open or modify a world. Usage: node tests/foundry-v13-playback.mjs ".../resources/app"
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {Library} from "../scripts/library.js";
import {TrackPreview} from "../scripts/preview.js";
import {ID} from "../scripts/model.js";

const appPath=process.argv[2];
if(!appPath)throw new Error("Укажите папку resources/app Foundry v13.");
await import(pathToFileURL(path.join(appPath,"common/server.mjs")).href);
const values=new Map([["selection",{}]]);
globalThis.game={release:{version:"13.350"},system:{id:"playback-test",version:"1"},user:{id:"AAAAAAAAAAAAAAAA",isGM:true},playlists:new foundry.utils.Collection(),settings:{get:(_,key)=>values.get(key),set:async(_,key,value)=>{values.set(key,value);return value;}}};
const source=await fs.readFile(path.join(appPath,"client/documents/playlist.mjs"),"utf8");
const nativeMethods=["playSound","stopAll","_onSoundEnd"].map(name=>{
  const method=source.match(new RegExp(`  async ${name}\\([^]*?\\n  \\}`));
  if(!method)throw new Error(`Не найден метод ${name} в установленном Foundry.`);
  return method[0];
}).join("\n");
const NativeMethods=new Function("PLAYLIST_MODES",`return class {${nativeMethods}}`)(CONST.PLAYLIST_MODES);
class MemoryPlaylist extends foundry.documents.BasePlaylist {
  static get database(){return {getFlagScopes:()=>[ID,"core","world"]};}
  async setFlag(scope,key,value){this.updateSource({[`flags.${scope}.${key}`]:value});return this;}
  async update(changes){
    const {sounds=[],...parent}=changes;
    const merged=this.sounds.contents.map(s=>({...s.toObject(),...sounds.find(update=>update._id===s.id)}));
    this.updateSource({...parent,sounds:merged});
    for(const s of this.sounds)s.sound={currentTime:37,duration:198};
    return this;
  }
}
MemoryPlaylist.prototype.playSound=NativeMethods.prototype.playSound;
MemoryPlaylist.prototype.stopAll=NativeMethods.prototype.stopAll;
MemoryPlaylist.prototype._onSoundEnd=NativeMethods.prototype._onSoundEnd;
globalThis.CONFIG={Playlist:{documentClass:MemoryPlaylist},PlaylistSound:{documentClass:foundry.documents.BasePlaylistSound}};
function playlist(name){
  const id=foundry.utils.randomID(),track=foundry.utils.randomID();
  const p=new MemoryPlaylist({_id:id,name,mode:CONST.PLAYLIST_MODES.SEQUENTIAL,sounds:[{_id:track,name,path:"music/test.mp3",playing:false,pausedTime:null}],flags:{[ID]:{managed:true,tracks:[{id:track,name,status:"ready",path:"music/test.mp3"}]}}});
  for(const s of p.sounds)s.sound={currentTime:37,duration:198};
  game.playlists.set(id,p);return p;
}
const a=playlist("First"),b=playlist("Second"),aid=a.sounds.contents[0].id,bid=b.sounds.contents[0].id;
await a.update({sounds:[{_id:aid,playing:true,pausedTime:5}]});await a.stopAll();
assert.equal(a.sounds.get(aid).playing,false);assert.equal(a.sounds.get(aid).pausedTime,5);
console.log("PASS Installed native Foundry v13 stopAll preserves the stale paused position");
const library=new Library();
await library.play(b.id,bid);
assert.equal(a.sounds.get(aid).pausedTime,null);assert.equal(b.sounds.get(bid).playing,true);
await library.toggle();
assert.equal(library.current.parent.id,b.id);assert.equal(library.current.id,bid);assert.equal(library.current.pausedTime,37);
assert.deepEqual(library.playlists.flatMap(p=>p.sounds.contents).filter(s=>s.playing||s.pausedTime!=null).map(s=>s.id),[bid]);
await library.toggle();assert.equal(b.sounds.get(bid).playing,true);
await library.stop();assert.equal(library.playlists.flatMap(p=>p.sounds.contents).some(s=>s.playing||s.pausedTime!=null),false);
console.log("PASS Switching, pausing, resuming and stopping work with real Foundry v13 schemas and Playlist methods");

const cid=foundry.utils.randomID();
await a.update({sounds:[]});
a.updateSource({sounds:[...a.sounds.contents.map(s=>s.toObject()),{_id:cid,name:"Layer in same playlist",path:"music/layer.mp3",playing:false,pausedTime:null}]});
await library.play(a.id,aid);await library.addLayer(a.id,cid);
assert.equal(a.mode,CONST.PLAYLIST_MODES.SIMULTANEOUS);assert.equal(a.getFlag(ID,"mixMode"),CONST.PLAYLIST_MODES.SEQUENTIAL);
assert.equal(a.sounds.get(aid).playing,true);assert.equal(a.sounds.get(cid).playing,true);
await library.toggle();assert.equal(library.current.id,aid);assert.equal(a.sounds.get(cid).playing,true);
await library.toggle();await a._onSoundEnd(a.sounds.get(cid));await library.normalizePlayback();
assert.equal(a.sounds.get(aid).playing,true);assert.equal(a.sounds.get(cid).playing,false);assert.equal(a.sounds.get(cid).pausedTime,null);assert.equal(a.mode,CONST.PLAYLIST_MODES.SEQUENTIAL);
await library.addLayer(b.id,bid);await library.stopTrack(a.id,aid);
assert.equal(a.sounds.get(aid).pausedTime,null);assert.equal(b.sounds.get(bid).playing,true);assert.equal(library.current.id,aid);assert.equal(library.soundAt(1).id,bid);
await library.setVolume(1,0.27);assert.equal(b.sounds.get(bid).volume,0.27);
await library.play(a.id,cid);assert.equal(a.sounds.get(cid).playing,true);assert.equal(b.sounds.get(bid).playing,true);assert.equal(b.sounds.get(bid).volume,0.27);
await library.play(a.id,aid);assert.equal(a.sounds.get(aid).playing,true);assert.equal(b.sounds.get(bid).playing,true);
await library.seek(92,1);assert.equal(b.sounds.get(bid).pausedTime,92);assert.equal(a.sounds.get(aid).playing,true);
await library.toggle(1);assert.equal(b.sounds.get(bid).playing,false);assert.equal(a.sounds.get(aid).playing,true);
await library.toggle(1);assert.equal(b.sounds.get(bid).playing,true);assert.equal(a.sounds.get(aid).playing,true);
await library.stopLayer(0);assert.equal(a.sounds.get(aid).pausedTime,null);assert.equal(b.sounds.get(bid).playing,true);
await library.stopLayer(1);await library.addLayer(a.id,cid);assert.equal(a.sounds.get(cid).volume,0.27);assert.equal(library.soundAt(1).id,cid);
await library.stop();assert.equal(library.playing,false);
console.log("PASS Explicit mixing, native end callbacks, independent stop and mode restoration on real v13 documents");

const {default:NativeSound}=await import(pathToFileURL(path.join(appPath,"client/audio/sound.mjs")).href);
// Native constructor, metadata loading and event API, with audio hardware replaced in memory.
class MemorySound extends NativeSound {
  async _load(){this.buffer={duration:200};}
  async play(options){this.options=options;this._state=NativeSound.STATES.PLAYING;return this;}
  async stop(options){assert.equal(options.fade,0);this.stopped=true;this._state=NativeSound.STATES.STOPPED;return this;}
}
game.audio={music:{},locked:false};foundry.audio={Sound:MemorySound};
const selectionBefore=structuredClone(values.get("selection")),preview=new TrackPreview();
await preview.toggle(a,aid);const audition=preview.active.sound;
assert.ok(audition.options.offset>=60&&audition.options.offset<=100);assert.deepEqual(values.get("selection"),selectionBefore);assert.equal(library.playing,false);
audition.dispatchEvent(new Event("end"));await Promise.resolve();assert.equal(preview.active,null);assert.equal(audition.stopped,true);
console.log("PASS GM audition uses the installed v13 Sound constructor, load, metadata, end events and stop API");
