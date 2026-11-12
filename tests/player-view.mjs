import assert from "node:assert/strict";
import { ID } from "../scripts/model.js";
import { PlaybackSync, localLayerVolume, soundDuration } from "../scripts/sync.js";
import { miniView, fullView, currentPlaylistView, volumeView } from "../scripts/view.js";
import { TrackPreview } from "../scripts/preview.js";

export async function playerViewTests(test) {
  const saved={game:globalThis.game,foundry:globalThis.foundry,Hooks:globalThis.Hooks};
  const preferences=new Map();let writes=[],now=10000;
  class Sound extends EventTarget {
    constructor(){super();this.duration=200;this.playing=false;this.loaded=false;}
    async load(){this.loaded=true;return this;}
    async play(options){this.options=options;this.volume=options.volume;this.currentTime=options.offset;this.playing=true;this.dispatchEvent(new Event("play"));}
    async stop(){this.playing=false;}
    async fade(value){this.volume=value;}
  }
  const doc=(id,volume)=>{const flags={duration:200,clock:{id,at:9000,offset:0,path:`music/${id}.mp3`}};const d={id,name:id,path:flags.clock.path,volume,playing:true,getFlag:(_,key)=>flags[key],sound:{duration:NaN},parent:{id:`p-${id}`}};d.parent.sounds={contents:[d]};d._onStart=()=>{d.sound.volume=d.volume;};return d;};
  try{
    globalThis.game={user:{id:"player",isGM:false},users:{activeGM:{id:"gm"}},time:{serverTime:now,sync:async()=>{}},audio:{locked:false,music:{resume:async()=>{}}},settings:{get:(scope,key)=>key==="localLayerVolumes"?preferences.get(game.user.id)??{}:key==="globalPlaylistVolume"?0.7:{},set:async(scope,key,value)=>{writes.push({scope,key,value,userId:game.user.id});if(key!=="localLayerVolumes")throw new Error("Shared setting changed by listener");preferences.set(game.user.id,value);}}};
    globalThis.foundry={audio:{Sound}};
    const main=doc("main",0.8),second=doc("secondary",0.5);
    const library={current:main,layerEntries:[{slot:1,sound:second}],playlists:[main.parent,second.parent],volumeFor:()=>0.8,tracks:()=>[]};
    const view={library,currentPlaylist:main.parent,downloads:{},query:"",tab:"library"};
    await test("Listener UI shows two read-only progress bars and active personal faders, with no playlist or library entry points",()=>{
      assert.equal(soundDuration(main),200);assert.equal(localLayerVolume(1),1);
      const markup=miniView(library,view);
      assert.equal((markup.match(/role="progressbar"/g)??[]).length,2);
      assert.match(markup,/data-duration>3:20/);assert.match(markup,/is-listener/);
      assert.match(volumeView(library),/data-local-layer-volume="1"[^>]*value="1"/);
      assert.doesNotMatch(markup,/data-seek|data-layer-volume=|data-action="(?:current-playlist|library|mini-all-playlists)"/);
      assert.doesNotMatch(markup,/data-local-layer-volume="1"[^>]*disabled/);
      assert.match(volumeView(library),/data-local-layer-volume="0"/);
      assert.equal(fullView(view),"");assert.equal(currentPlaylistView(view),"");
      game.user={id:"gm",isGM:true};library.playbackOptions=()=>({autoplay:true,repeat:true});const gm=miniView(library,view);assert.match(gm,/data-seek/);assert.match(gm,/data-action="current-playlist"/);assert.doesNotMatch(gm,/data-layer-volume=/);assert.match(volumeView(library),/data-local-layer-volume="1"/);assert.doesNotMatch(volumeView(library),/data-layer-volume=/);game.user={id:"player",isGM:false};
    });
    await test("Player layer faders change only local audio, survive polling and resync, and apply to replacement tracks without changing GM volume",async()=>{
      const sync=new PlaybackSync(library,()=>{},{now:()=>now});
      await sync.sync(main);await sync.sync(second);
      await Promise.all([sync.setLocalVolume(0,0.4),sync.setLocalVolume(1,0.2)]);
      assert.equal(main.sound.volume,0.4);assert.equal(second.sound.volume,0.2);
      assert.equal(main.volume,0.8);assert.equal(second.volume,0.5);assert.ok(writes.every(w=>w.key==="localLayerVolumes"));
      await sync.sync(second);assert.equal(second.sound.volume,0.2);
      await sync.resync();assert.equal(second.sound.volume,0.2);assert.equal(main.sound.volume,0.4);
      await sync.setLocalVolume(1,0);await sync.sync(second);assert.equal(second.sound.volume,0);assert.ok(main.sound.volume>0);
      const replacement=doc("replacement",0.6);library.layerEntries=[{slot:1,sound:replacement}];library.playlists=[main.parent,replacement.parent];sync.tick();await sync.sync(replacement);assert.equal(replacement.sound.volume,0);
      await sync.setLocalVolume(1,0.5);assert.equal(replacement.sound.volume,0.5);
      const restored=new PlaybackSync(library,()=>{},{now:()=>now});assert.equal(restored.effectiveVolume(replacement),0.5);
      game.user={id:"gm",isGM:true};sync.applyVolumes();assert.equal(replacement.sound.volume,0.8);assert.equal(main.sound.volume,0.8);game.user={id:"player",isGM:false};
      main.playing=replacement.playing=false;sync.tick();
    });
    await test("GM and two players independently control both local layers, including legacy tracks with shared volume zero",async()=>{
      const actors=[{id:"gm-volume",isGM:true},{id:"player-one",isGM:false},{id:"player-two",isGM:false}];
      const clients=[];
      for(const actor of actors){
        game.user=actor;const primary=doc("volume-main",0),secondary=doc("volume-rain",0);
        const ownLibrary={current:primary,layerEntries:[{slot:1,sound:secondary}],playlists:[primary.parent,secondary.parent]};
        const sync=new PlaybackSync(ownLibrary,()=>{},{now:()=>now});
        await sync.sync(primary);await sync.sync(secondary);clients.push({actor,primary,secondary,sync});
      }
      const [gm,one,two]=clients;game.user=gm.actor;
      await gm.sync.setLocalVolume(0,0);await gm.sync.setLocalVolume(1,0.3);
      assert.equal(gm.primary.sound.volume,0);assert.equal(gm.secondary.sound.volume,0.3);
      assert.equal(one.primary.sound.volume,1);assert.equal(one.secondary.sound.volume,1);
      game.user=one.actor;await one.sync.setLocalVolume(0,0.65);await one.sync.setLocalVolume(1,0.2);
      assert.equal(one.primary.sound.volume,0.65);assert.equal(one.secondary.sound.volume,0.2);
      assert.equal(gm.primary.sound.volume,0);assert.equal(gm.secondary.sound.volume,0.3);
      assert.equal(two.primary.sound.volume,1);assert.equal(two.secondary.sound.volume,1);
      for(const client of clients){
        game.user=client.actor;assert.equal(client.primary.volume,0);assert.equal(client.secondary.volume,0);
        client.sync.tick();await client.sync.resync();
        const expected=client===gm?[0,0.3]:client===one?[0.65,0.2]:[1,1];
        assert.deepEqual([client.primary.sound.volume,client.secondary.sound.volume],expected);
        client.primary.playing=client.secondary.playing=false;client.sync.tick();
      }
      assert.ok(writes.every(write=>write.key==="localLayerVolumes"));game.user={id:"player",isGM:false};
    });
    await test("Player library access is blocked through the API and stale popup refresh as well as hidden controls",async()=>{
      globalThis.Hooks={once:()=>{},on:()=>{}};
      const {PlayerWidget}=await import("../scripts/main.js");
      let closed=0;
      const widget={library,closeMiniPlaylist:()=>++closed};
      assert.equal(PlayerWidget.prototype.openFull.call(widget),undefined);
      PlayerWidget.prototype.refreshMiniPlaylist.call(widget);assert.equal(closed,1);
      const element={closest:()=>null};widget.closePlaylistMenu=()=>{};widget.selected=null;
      await PlayerWidget.prototype.action.call(widget,"current-playlist",element);assert.equal(widget.miniPlaylistOpen,undefined);
    });
    await test("GM audition mutes both layers through polling and resync, restores their latest levels on stop, end and failure, and never mutes players",async()=>{
      game.user={id:"gm",isGM:true};main.playing=second.playing=true;
      main.parent.sounds.get=id=>id===main.id?main:undefined;
      library.layerEntries=[{slot:1,sound:second}];library.playlists=[main.parent,second.parent];
      const sync=new PlaybackSync(library,()=>{},{now:()=>now});await sync.sync(main);await sync.sync(second);
      await sync.setLocalVolume(0,0.8);await sync.setLocalVolume(1,0.5);
      const preview=new TrackPreview(()=>{},muted=>sync.setPreviewMuted(muted)),before=writes.length;
      await preview.toggle(main.parent,main.id);
      assert.equal(main.sound.volume,0);assert.equal(second.sound.volume,0);assert.ok(preview.active.sound.volume>0);
      await sync.setLocalVolume(1,0.23);await sync.sync(second);await sync.resync();
      assert.equal(main.sound.volume,0);assert.equal(second.sound.volume,0);assert.equal(second.playing,true);
      game.user.isGM=false;assert.ok(sync.effectiveVolume(main)>0);game.user.isGM=true;
      await preview.stop();assert.equal(main.sound.volume,0.8);assert.equal(second.sound.volume,0.23);
      await preview.toggle(main.parent,main.id);preview.active.sound.dispatchEvent(new Event("end"));await Promise.resolve();await Promise.resolve();
      assert.equal(sync.previewMuted,false);assert.equal(second.sound.volume,0.23);
      const load=Sound.prototype.load;Sound.prototype.load=async function(){this.failed=true;};
      await assert.rejects(()=>preview.toggle(main.parent,main.id),/Не удалось/);Sound.prototype.load=load;
      assert.equal(main.sound.volume,0.8);assert.equal(second.sound.volume,0.23);assert.equal(preview.active,null);assert.equal(writes.length,before+1);
      main.playing=second.playing=false;sync.tick();game.user.isGM=false;
    });
  } finally {Object.assign(globalThis,saved);}
}
