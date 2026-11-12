import assert from "node:assert/strict";
import { ID } from "../scripts/model.js";
import { PlaybackSync, stampPlayback, playbackTarget, installPlaybackSync } from "../scripts/sync.js";
import { miniView, fullView } from "../scripts/view.js";

export async function syncTests(test) {
  const saved = { game:globalThis.game,foundry:globalThis.foundry,CONFIG:globalThis.CONFIG };
  let now=10000,serial=0,created=[],loadMode="ok",pending=[],writes=0,resumes=0,clockSyncs=0;
  class Audio extends EventTarget {
    constructor(path){super();this.src=path;this.duration=200;this.loaded=false;this.playing=false;this.volume=0.8;created.push(this);}
    async load(){if(loadMode==="pending")await new Promise(resolve=>pending.push(resolve));if(loadMode==="error"){this.failed=true;return this;}if(loadMode==="blocked")this.element={currentTime:0,readyState:4,play:()=>Promise.reject(new Error("Browser blocked audio")),pause(){}};this.loaded=true;return this;}
    async play(options){this.options=options;this.volume=options.volume;this.loop=options.loop;this.currentTime=options.offset;this.playing=true;this.dispatchEvent(new Event("play"));if(this.element)this.element.play();}
    async stop(){this.playing=false;this.dispatchEvent(new Event("stop"));}
  }
  const makeDoc=(id="one",at=9000,offset=20)=>{
    const flags={clock:{id:`clock-${id}`,at,offset,path:`music/${id}.mp3`}};
    const parent={id:`p-${id}`,getFlag:(_,key)=>key==="managed",sounds:{contents:[]}};
    const doc={id,parent,path:flags.clock.path,playing:true,pausedTime:null,repeat:false,volume:0.35,getFlag:(_,key)=>flags[key],setFlag:async(_,key,value)=>{++writes;flags[key]=value;},_onStart:()=>{},_onStop:()=>{}};
    parent.sounds.contents.push(doc);return doc;
  };
  const lib=(...docs)=>({playlists:docs.map(d=>d.parent),playbackOptions:()=>({autoplay:true,repeat:true})});
  try {
    globalThis.foundry={utils:{randomID:()=>`clock-${++serial}`},audio:{Sound:Audio}};
    globalThis.game={time:{get serverTime(){return now;},sync:async()=>{++clockSyncs;}},user:{id:"player",isGM:false},users:{activeGM:{id:"gm"}},audio:{locked:false,music:{resume:async()=>{++resumes;}}},settings:{get:()=>0.7}};
    await test("Playback stamps share a server start time, preserve resume/seek offsets and ignore volume-only or foreign changes",()=>{
      const doc=makeDoc();doc.playing=false;doc.pausedTime=52;
      const changes={playing:true};stampPlayback(doc,changes,10000);
      assert.equal(changes.flags[ID].clock.at,10600);assert.equal(changes.flags[ID].clock.offset,52);
      const copy=structuredClone(changes);stampPlayback(doc,changes,20000);assert.deepEqual(changes,copy);
      doc.playing=true;const volume={playing:true,volume:0.2};stampPlayback(doc,volume);assert.equal(volume.flags,undefined);
      const seek={playing:true,pausedTime:0};stampPlayback(doc,seek);assert.equal(seek.flags[ID].clock.offset,0);
      doc.parent.getFlag=()=>false;const foreign={playing:true};stampPlayback(doc,foreign);assert.equal(foreign.flags,undefined);
      assert.deepEqual(playbackTarget({at:9000,offset:198},14000,200,true),{offset:3,delay:0,ended:false});
    });
    await test("A delayed client catches up after loading; both layers retain independent offsets and volumes, without needless restarts",async()=>{
      now=10000;const main=makeDoc("main"),layer=makeDoc("rain",8000,60);layer.volume=0.12;
      const sync=new PlaybackSync(lib(main,layer),()=>{},{now:()=>now});
      loadMode="pending";const task=sync.sync(main);await Promise.resolve();now=16000;pending.shift()();await task;
      assert.equal(main.sound.options.offset,27);
      loadMode="ok";await sync.sync(layer);assert.equal(layer.sound.options.offset,68);assert.equal(layer.sound.volume,0.12);
      const untouched=layer.sound,oldMain=main.sound;oldMain.currentTime=20;
      await sync.sync(main);assert.equal(main.sound.options.offset,27);assert.equal(layer.sound,untouched);assert.equal(layer.sound.options.offset,68);
      const plays=main.sound.options;await sync.sync(main);assert.equal(main.sound.options,plays);
      main.playing=false;sync.tick();assert.equal(oldMain.playing,false);assert.equal(layer.sound.playing,true);
      layer.playing=false;sync.tick();
      now=10000;const gm=makeDoc("together"),player=makeDoc("together");
      const gmSync=new PlaybackSync(lib(gm),()=>{},{now:()=>now}),playerSync=new PlaybackSync(lib(player),()=>{},{now:()=>now});
      await gmSync.sync(gm);const gmOffset=gm.sound.options.offset;
      loadMode="pending";const delayed=playerSync.sync(player);await Promise.resolve();now+=4500;pending.shift()();await delayed;
      assert.equal(player.sound.options.offset,gmOffset+4.5);
      gm.playing=player.playing=false;gmSync.tick();playerSync.tick();loadMode="ok";
    });
    await test("Scheduled start uses the same deadline and late/stopped loads cannot play or advance a replacement",async()=>{
      now=10000;loadMode="ok";const doc=makeDoc("scheduled",10600,12),sync=new PlaybackSync(lib(doc),()=>{},{now:()=>now});
      await sync.sync(doc);assert.equal(doc.sound.options.delay,0.6);assert.equal(doc.sound.options.offset,12);
      doc.playing=false;sync.tick();
      const slow=makeDoc("slow"),slowSync=new PlaybackSync(lib(slow),()=>{},{now:()=>now});loadMode="pending";
      const loading=slowSync.sync(slow);await Promise.resolve();const old=slow.sound;let ends=0;slow._onEnd=()=>++ends;
      slow.playing=false;slowSync.tick();await loading;pending.shift()();await Promise.resolve();await Promise.resolve();
      assert.equal(old.playing,false);old.dispatchEvent(new Event("end"));assert.equal(ends,0);
      loadMode="ok";
    });
    await test("Seek positions stay selected through loading and the scheduled start, then follow actual audio independently for each layer",async()=>{
      now=10000;const main=makeDoc("seek-position",11200,83.4),layer=makeDoc("seek-layer",11200,51.2);
      const sync=new PlaybackSync(lib(main,layer),()=>{},{now:()=>now});
      loadMode="pending";const loading=sync.sync(main);await Promise.resolve();
      try { assert.equal(sync.position(main),83.4); }
      finally { pending.shift()();await loading;loadMode="ok"; }
      await sync.sync(layer);
      // Foundry reports NaN while STARTING, before Sound.startTime exists.
      main.sound.currentTime=NaN;layer.sound.currentTime=undefined;
      assert.equal(sync.position(main),83.4);assert.equal(sync.position(layer),51.2);
      // A stream can still report its initial zero before the common deadline.
      main.sound.element={currentTime:0};assert.equal(sync.position(main),83.4);delete main.sound.element;
      now=11300;assert.equal(sync.position(main),83.4);assert.equal(sync.position(layer),51.2);
      main.sound.currentTime=83.5;layer.sound.currentTime=51.3;
      assert.equal(sync.position(main),83.5);assert.equal(sync.position(layer),51.3);
      main.playing=layer.playing=false;sync.tick();
    });
    await test("Hung loads time out, retry at most three times, and player manual sync rebuilds both local layers without world writes",async()=>{
      const a=makeDoc("stuck"),b=makeDoc("second"),sync=new PlaybackSync(lib(a,b),()=>{},{now:()=>now,timeout:15});
      loadMode="pending";const before=created.length;
      for(let i=0;i<3;i++){await sync.sync(a);assert.equal(sync.status.error,true);now+=11000;}
      await sync.sync(a);assert.equal(created.length-before,3);assert.equal(sync.status.busy,false);
      const writeCount=writes;loadMode="ok";await sync.resync();
      assert.equal(a.sound.playing,true);assert.equal(b.sound.playing,true);assert.equal(writes,writeCount);
      assert.equal(resumes,1);assert.equal(clockSyncs,1);assert.equal(sync.status.error,false);
      for(const finish of pending.splice(0))finish();await Promise.resolve();await Promise.resolve();
      assert.equal(created.filter(s=>s.playing&&[a.path,b.path].includes(s.src)).length,2);
      a.playing=b.playing=false;sync.tick();
    });
    await test("Autoplay rejection, failed reads and legacy missing clocks recover locally while players never write timestamps",async()=>{
      const doc=makeDoc("failed"),sync=new PlaybackSync(lib(doc),()=>{},{now:()=>now,timeout:30});loadMode="error";await sync.sync(doc);assert.equal(sync.status.error,true);
      loadMode="ok";await sync.resync();assert.equal(doc.sound.playing,true);
      loadMode="blocked";await assert.rejects(()=>sync.resync(),/Browser blocked audio/);assert.equal(sync.status.error,true);
      loadMode="ok";await sync.resync();assert.equal(doc.sound.playing,true);
      const legacy=makeDoc("legacy");await legacy.setFlag(ID,"clock",null);const legacySync=new PlaybackSync(lib(legacy),()=>{},{now:()=>now});
      const before=writes;await legacySync.sync(legacy);assert.equal(writes,before);
      legacy.pausedTime=57;legacy.sound={playing:false,element:{currentTime:0,pause(){}}};
      game.user={id:"gm",isGM:true};await legacySync.sync(legacy);await Promise.resolve();await Promise.resolve();
      assert.equal(writes,before+1);assert.equal(legacy.getFlag(ID,"clock").at,now);assert.equal(legacy.getFlag(ID,"clock").offset,57);
      await legacySync.sync(legacy);doc.playing=legacy.playing=false;sync.tick();legacySync.tick();game.user={id:"player",isGM:false};
    });
    await test("Native sync interception handles only widget playlists and delegates all unrelated audio",async()=>{
      let native=0,local=0;class PlaylistSound{sync(){++native;}}
      globalThis.CONFIG={PlaylistSound:{documentClass:PlaylistSound}};
      installPlaybackSync(()=>({sync:async()=>{++local;}}));
      const managed=new PlaylistSound();managed.parent={getFlag:()=>true};managed.sync();
      const foreign=new PlaylistSound();foreign.parent={getFlag:()=>false};foreign.sync();
      assert.equal(local,1);assert.equal(native,1);
    });
    await test("Missing clocks and locked audio report a manual recovery error; failed GM timestamp writes back off",async()=>{
      const doc=makeDoc("offline-clock");await doc.setFlag(ID,"clock",null);
      const sync=new PlaybackSync(lib(doc),()=>{},{now:()=>now});
      await assert.rejects(()=>sync.resync(),/Ожидается момент/);
      game.audio.locked=true;await assert.rejects(()=>sync.resync(),/Браузер ещё не разрешил/);game.audio.locked=false;
      game.user={id:"gm",isGM:true};let calls=0;doc.setFlag=async()=>{++calls;throw new Error("disconnected");};
      const warn=console.warn;console.warn=()=>{};
      try{await sync.sync(doc);await new Promise(r=>setImmediate(r));await sync.sync(doc);assert.equal(calls,1);now+=11000;await sync.sync(doc);await new Promise(r=>setImmediate(r));assert.equal(calls,2);}
      finally{console.warn=warn;game.user={id:"player",isGM:false};}
    });
    await test("Players have a local sync button; download title counts ready/total across statuses and ignores search",()=>{
      const tracks=[{id:"one",name:"Done",status:"ready",type:"youtube"},{id:"two",name:"Error",status:"error",type:"youtube"},{id:"three",name:"Cancelled",status:"cancelled",type:"youtube"},{id:"four",name:"Pending",status:"queued",type:"youtube"}];
      const p={id:"p",name:"Playlist",sounds:{get:()=>null}},library={current:null,playlists:[p],layerEntries:[],tracks:()=>tracks,volumeFor:()=>0.8,playbackOptions:()=>({autoplay:true,repeat:true})};
      let ui={library,currentPlaylist:p,downloads:{online:true,message:"ok"},query:"not found",tab:"queue"};
      assert.match(miniView(library,ui),/data-action="sync-audio"/);assert.doesNotMatch(miniView(library,ui),/data-action="stop"/);
      game.user.isGM=true;assert.match(fullView(ui),/Загрузки <b[^>]*>1\/4<\/b>/);
      tracks[3].status="ready";assert.match(fullView(ui),/>2\/4<\/b>/);
      for(const t of tracks)t.queueDismissed=true;assert.match(fullView(ui),/>0\/0<\/b>/);
      game.user.isGM=false;
    });
  } finally {Object.assign(globalThis,saved);}
}
