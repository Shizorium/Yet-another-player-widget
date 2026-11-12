// Isolated browser-like client for the shared-start test; no world or real audio is used.
import {parentPort, workerData} from "node:worker_threads";
import {Library} from "../scripts/library.js";
import {PlaybackSync} from "../scripts/sync.js";
import {ID} from "../scripts/model.js";

const listeners=new Map(),loads=new Map(),settings={selection:{},layerPlayback:{0:{autoplay:true,repeat:false}}};
let serial=0,sync;
const collection=items=>({contents:items,get:id=>items.find(item=>item.id===id),has:id=>items.some(item=>item.id===id),filter:fn=>items.filter(fn),some:fn=>items.some(fn)});
const flags={managed:true,tracks:["first","second"].map(id=>({id,name:id,status:"ready",path:`music/${id}.mp3`}))};
const playlist={id:"playlist",name:"Shared",mode:0,sounds:collection([]),getFlag:(_,key)=>flags[key],setFlag:async(_,key,value)=>{flags[key]=value;},
  async update(patch){apply(patch);parentPort.postMessage({type:"document",patch});return this;}
};
function apply(patch){
  for(const change of patch.sounds??[]){
    const doc=playlist.sounds.get(change._id),merged={...doc.flags[ID],...change.flags?.[ID]};
    Object.assign(doc,change);doc.flags={[ID]:merged};
  }
  queueMicrotask(()=>sync?.tick());
}
for(const id of ["first","second"])playlist.sounds.contents.push({id,name:id,parent:playlist,path:`music/${id}.mp3`,playing:false,pausedTime:null,repeat:false,volume:0.8,flags:{[ID]:{duration:200}},
  getFlag(_,key){return this.flags[ID][key];},async setFlag(_,key,value){await playlist.update({sounds:[{_id:id,flags:{[ID]:{[key]:value}}}]});},_onStart(){},_onStop(){}
});
class Audio extends EventTarget {
  constructor(path,options){super();this.path=path;this.duration=200;this.loaded=false;this.playing=false;this.generation=0;this.forceBuffer=options.forceBuffer;}
  async load(){
    parentPort.postMessage({type:"loading",path:this.path});
    await new Promise(resolve=>loads.set(this.path,resolve));this.loaded=true;
    parentPort.postMessage({type:"loaded",path:this.path});return this;
  }
  async play(options){
    const generation=this.generation;this.options=options;
    const scheduledAt=Date.now()+options.delay*1000;
    await new Promise(resolve=>setTimeout(resolve,options.delay*1000));
    if(this.generation!==generation)return;
    this.volume=options.volume;this.currentTime=options.offset;this.playing=true;this.dispatchEvent(new Event("play"));
    parentPort.postMessage({type:"play",path:this.path,scheduledAt,startedAt:Date.now(),offset:options.offset,forceBuffer:this.forceBuffer});
  }
  async stop(){this.generation++;this.playing=false;this.dispatchEvent(new Event("stop"));}
}
const users=workerData.users;
globalThis.game={user:users.find(user=>user.id===workerData.id),users:{filter:fn=>users.filter(fn),activeGM:users[0]},time:{get serverTime(){return Date.now();}},
  audio:{locked:false,music:{resume:async()=>{}}},playlists:collection([playlist]),
  settings:{get:(_,key)=>settings[key],set:async(_,key,value)=>{settings[key]=value;}},
  socket:{on:(channel,callback)=>listeners.set(channel,callback),emit:(channel,...args)=>parentPort.postMessage({type:"socket",channel,args})}
};
game.user.broadcastActivity=function(activity,options){
  if(options?.volatile!==false)throw new Error("Readiness must use reliable activity delivery.");
  game.socket.emit("userActivity",this.id,activity);
};
globalThis.foundry={audio:{Sound:Audio},utils:{randomID:()=>`${workerData.id}-${++serial}`}};
globalThis.CONST={PLAYLIST_MODES:{SEQUENTIAL:0,SIMULTANEOUS:2}};
const library=new Library();
sync=new PlaybackSync(library,()=>queueMicrotask(()=>parentPort.postMessage({type:"status",track:library.current?.id,status:sync.status})));
sync.readiness.activate();
parentPort.on("message",async message=>{
  try{
    if(message.type==="document")apply(message.patch);
    if(message.type==="socket")listeners.get(message.channel)?.(...message.args);
    if(message.type==="start")await library.play(playlist.id,"first");
    if(message.type==="release"){loads.get(message.path)?.();loads.delete(message.path);}
    if(message.type==="end"){const doc=playlist.sounds.get(message.track);doc.sound.playing=false;doc.sound.dispatchEvent(new Event("end"));}
    if(message.type==="inspect")parentPort.postMessage({type:"snapshot",request:message.request,docs:playlist.sounds.contents.map(doc=>({id:doc.id,playing:doc.playing,audioPlaying:doc.sound?.playing??false,clock:doc.getFlag(ID,"clock")}))});
  }catch(error){parentPort.postMessage({type:"failure",error:error.stack});}
});
setInterval(()=>sync.tick(),100);
parentPort.postMessage({type:"initialized"});
