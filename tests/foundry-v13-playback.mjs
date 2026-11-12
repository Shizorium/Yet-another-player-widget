// Real Foundry document schemas and native Playlist methods, with an in-memory update adapter.
// Does not open or modify a world. Usage: node tests/foundry-v13-playback.mjs ".../resources/app"
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {Library} from "../scripts/library.js";
import {TrackPreview} from "../scripts/preview.js";
import {PlaybackSync,stampPlayback} from "../scripts/sync.js";
import {ID} from "../scripts/model.js";

const appPath=process.argv[2];
if(!appPath)throw new Error("Укажите папку resources/app Foundry v13.");
await import(pathToFileURL(path.join(appPath,"common/server.mjs")).href);
Object.defineProperty(foundry.documents.BasePlaylistSound,"database",{get:()=>({getFlagScopes:()=>[ID,"core","world"]})});
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
    for(const s of this.sounds) s.sound ||= {currentTime:37,duration:198};
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
  constructor(path,options){super(path,options);this.forceBufferRequested=options?.forceBuffer;}
  async _load(){this.buffer={duration:200};}
  async play(options){this.options=options;this.gainNode={gain:{value:1,cancelScheduledValues(){},setValueAtTime(value){this.value=value;},linearRampToValueAtTime(value){this.value=value;}}};this.volume=options.volume;this._state=NativeSound.STATES.PLAYING;return this;}
  async stop(options){assert.equal(options.fade,0);this.stopped=true;this._state=NativeSound.STATES.STOPPED;return this;}
}
game.audio={music:{currentTime:0},locked:false};foundry.audio={Sound:MemorySound};
const selectionBefore=structuredClone(values.get("selection")),preview=new TrackPreview();
await preview.toggle(a,aid);const audition=preview.active.sound;
assert.ok(audition.options.offset>=60&&audition.options.offset<=100);assert.deepEqual(values.get("selection"),selectionBefore);assert.equal(library.playing,false);
audition.dispatchEvent(new Event("end"));await Promise.resolve();assert.equal(preview.active,null);assert.equal(audition.stopped,true);
console.log("PASS GM audition uses the installed v13 Sound constructor, load, metadata, end events and stop API");

game.users={activeGM:game.user};game.time={serverTime:10000,sync:async()=>{}};
await library.play(a.id,aid);await library.addLayer(b.id,bid);
const primary=a.sounds.get(aid),secondary=b.sounds.get(bid);
assert.equal(primary.getFlag(ID,"clock").offset,0);assert.equal(primary.getFlag(ID,"clock").at,10600);
const synchronization=new PlaybackSync(library,()=>{},{now:()=>12000});
await synchronization.sync(primary);await synchronization.sync(secondary);
assert.ok(Math.abs(primary.sound.options.offset-1.4)<0.001);assert.ok(Math.abs(secondary.sound.options.offset-1.4)<0.001);
assert.equal(secondary.sound.options.volume,0.27);
await library.seek(90);await synchronization.sync(primary);assert.ok(Math.abs(primary.sound.options.offset-91.4)<0.001);
assert.equal(secondary.sound.playing,true);
game.user.isGM=false;
await synchronization.setLocalVolume(1,0.25);
assert.equal(secondary.sound.volume,0.25);assert.equal(secondary.volume,0.27);
secondary.updateSource({volume:0});await synchronization.sync(secondary);assert.equal(secondary.sound.volume,0.25);
await synchronization.resync();assert.equal(secondary.sound.options.volume,0.25);
game.user.isGM=true;
console.log("PASS Player personal volume applies to the installed v13 Sound and survives local resync without changing the shared document volume");
await library.stop();synchronization.tick();
console.log("PASS Shared server-time anchors, seek and two independent local sounds use the installed v13 Sound load/play/stop APIs and document flags");

await a.setFlag(ID,"tracks",[...library.tracks(a),{id:cid,name:"Layer in same playlist",status:"ready",path:"music/layer.mp3"}]);
await library.togglePlaybackOption(0,"repeat");await library.togglePlaybackOption(1,"repeat");
await library.play(a.id,aid);await library.addLayer(b.id,bid);
await synchronization.sync(a.sounds.get(aid));await synchronization.sync(b.sounds.get(bid));
const ended=b.sounds.get(bid),oldPrimary=a.sounds.get(aid);
ended.sound.dispatchEvent(new Event("end"));await library.queue;
assert.equal(ended.playing,false);assert.equal(oldPrimary.playing,true);
oldPrimary.sound.dispatchEvent(new Event("end"));await library.queue;
assert.equal(library.current.id,cid);assert.equal(library.current.playing,true);assert.equal(library.current.repeat,false);
await synchronization.sync(library.current);
const mutedPreview=new TrackPreview(()=>{},value=>synchronization.setPreviewMuted(value));
await mutedPreview.toggle(a,aid);assert.equal(library.current.sound.volume,0);assert.equal(library.current.playing,true);
await mutedPreview.stop();assert.equal(library.current.sound.volume,library.current.volume);
await library.stop();synchronization.tick();
console.log("PASS Natural v13 Sound end events advance only the ending layer, honor preferences and restore GM volume after audition");

const connected=[{...game.user,name:"GM",active:true},{id:"FAST",name:"Fast listener",active:true},{id:"SLOW",name:"Slow listener",active:true}];
game.users.filter=fn=>connected.filter(fn);
const userSource=await fs.readFile(path.join(appPath,"client/documents/user.mjs"),"utf8");
const broadcastMethod=userSource.match(/  broadcastActivity\([^]*?\n  \}/)?.[0];
assert.ok(broadcastMethod,"Installed Foundry must expose User.broadcastActivity");
const NativeActivity=new Function(`return class {${broadcastMethod}}`)();
const socketListeners=new Map(),sentActivity=[];
game.socket={on:(channel,handler)=>socketListeners.set(channel,handler),emit:(...args)=>sentActivity.push(args)};
game.user.isSelf=true;game.user.broadcastActivity=NativeActivity.prototype.broadcastActivity;
for(const playlist of library.playlists)for(const sound of playlist.sounds)sound.setFlag=async(scope,key,value)=>{sound.updateSource({[`flags.${scope}.${key}`]:value});};
await library.play(a.id,aid);
const shared=a.sounds.get(aid);shared.setFlag=async(scope,key,value)=>{shared.updateSource({[`flags.${scope}.${key}`]:value});};
const barrierSync=new PlaybackSync(library,()=>{},{now:()=>20000});
for(const user of connected.slice(1))socketListeners.get("userActivity")(user.id,{[ID]:{type:"widget-ready",userId:user.id,widgetId:`widget-${user.id}`}});
await barrierSync.sync(shared);
const buffered=shared.sound,waiting=shared.getFlag(ID,"clock");
assert.equal(waiting.waiting,true);assert.equal(buffered.forceBufferRequested,true);assert.equal(buffered.playing,false);assert.equal(barrierSync.position(shared),0);
assert.ok(sentActivity.some(([channel,userId,data])=>channel==="userActivity"&&userId===game.user.id&&data[ID]?.status==="ready"));
const acknowledge=(userId,trackId,clockId)=>socketListeners.get("userActivity")(userId,{[ID]:{type:"audio-ready",playlistId:a.id,trackId,clockId,userId,status:"ready"}});
const ready=userId=>acknowledge(userId,aid,waiting.id);
ready("FAST");await Promise.resolve();assert.equal(shared.getFlag(ID,"clock").waiting,true);assert.equal(buffered.playing,false);
ready("SLOW");await Promise.resolve();await library.queue;
assert.equal(shared.getFlag(ID,"clock").at,21200);assert.equal(shared.getFlag(ID,"clock").waiting,false);
await barrierSync.sync(shared);
assert.equal(shared.sound,buffered);assert.equal(buffered.options.offset,0);assert.equal(buffered.options.delay,1.2);
buffered.dispatchEvent(new Event("end"));await library.queue;
const automatic=library.current;assert.equal(automatic.id,cid);assert.equal(automatic.getFlag(ID,"clock").waiting,true);
await barrierSync.sync(automatic);assert.equal(automatic.sound.playing,false);
const automaticClock=automatic.getFlag(ID,"clock");
for(const userId of ["FAST","SLOW"])acknowledge(userId,cid,automaticClock.id);
await Promise.resolve();await library.queue;await barrierSync.sync(automatic);
assert.equal(automatic.sound.options.offset,0);assert.equal(automatic.sound.options.delay,1.2);
await library.stop();barrierSync.tick();delete game.socket;
console.log("PASS Manual starts and autoplay use native v13 User.broadcastActivity, preload Sound, wait for two listeners and reuse the buffer for a shared scheduled start");

let scheduled,beginPlayback;
const queued=new Promise(resolve=>{scheduled=resolve;});
class ScheduledMemorySound extends MemorySound {
  async play(options){
    this._state=NativeSound.STATES.STARTING;
    const delay=new Promise(resolve=>{beginPlayback=resolve;});scheduled();await delay;
    this.startTime=this.context.currentTime-options.offset;this._state=NativeSound.STATES.PLAYING;return this;
  }
}
foundry.audio.Sound=ScheduledMemorySound;
await library.play(a.id,aid);await library.seek(86.4);
const seeking=a.sounds.get(aid);let seekTime=game.time.serverTime;
const seekSync=new PlaybackSync(library,()=>{},{now:()=>seekTime});
const seekingTask=seekSync.sync(seeking);await queued;
assert.equal(Number.isNaN(seeking.sound.currentTime),true); // Real v13 getter before startTime is initialized.
assert.equal(seekSync.position(seeking),86.4);
seekTime=seeking.getFlag(ID,"clock").at+50;assert.equal(seekSync.position(seeking),86.4);
beginPlayback();await seekingTask;
game.audio.music.currentTime+=0.25;assert.equal(seekSync.position(seeking),86.65);
await library.stop();seekSync.tick();foundry.audio.Sound=MemorySound;
console.log("PASS Seek position stays selected while the real v13 Sound getter returns NaN during STARTING and follows audio after the deadline");
