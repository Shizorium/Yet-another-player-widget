import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";

export async function sharedStartTests(test){
  await test("Three loaded widgets start manual and automatic tracks together, ignoring an active user whose widget has not loaded",async()=>{
    const users=[{id:"gm",name:"GM",active:true,isGM:true},{id:"fast",name:"Fast",active:true,isGM:false},{id:"slow",name:"Slow",active:true,isGM:false},{id:"unloaded",name:"Not in the game yet",active:true,isGM:false}];
    const loaded=users.slice(0,3);
    const events=[],workers=new Map(),waiters=new Set();let serial=0;
    const waitFor=predicate=>{
      const found=events.find(predicate);if(found)return Promise.resolve(found);
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{waiters.delete(check);reject(new Error("Shared-start test timed out."));},10000);
        const check=event=>{if(event.type==="failure"||predicate(event)){clearTimeout(timer);waiters.delete(check);event.type==="failure"?reject(new Error(event.error)):resolve(event);}};
        waiters.add(check);
      });
    };
    try{
      for(const user of loaded){
        const worker=new Worker(new URL("shared-start-client.mjs",import.meta.url),{execArgv:[],workerData:{id:user.id,users}});workers.set(user.id,worker);
        worker.on("error",error=>{for(const check of [...waiters])check({type:"failure",error:error.stack});});
        worker.on("message",message=>{
          // Foundry was launched before module.json enabled its socket. Its stock
          // activity channel still works, but all module packets are dropped.
          if(message.type==="document" || (message.type==="socket"&&message.channel==="userActivity"))for(const [id,target]of workers)if(id!==user.id)target.postMessage(message);
          const event={...message,user:user.id};events.push(event);for(const check of [...waiters])check(event);
        });
      }
      await Promise.all(loaded.map(user=>waitFor(event=>event.type==="initialized"&&event.user===user.id)));
      workers.get("gm").postMessage({type:"start"});
      for(const track of ["first","second"]){
        const path=`music/${track}.mp3`;
        await Promise.all(loaded.map(user=>waitFor(event=>event.type==="loading"&&event.user===user.id&&event.path===path)));
        for(const id of ["gm","fast"])workers.get(id).postMessage({type:"release",path});
        await waitFor(event=>event.type==="status"&&event.user==="gm"&&event.track===track&&event.status.label==="Готовы 2/3");
        assert.equal(events.some(event=>event.type==="play"&&event.path===path),false);
        for(const user of loaded){
          const request=++serial;workers.get(user.id).postMessage({type:"inspect",request});
          const snapshot=await waitFor(event=>event.type==="snapshot"&&event.request===request);
          const doc=snapshot.docs.find(doc=>doc.id===track);assert.equal(doc.audioPlaying,false);assert.equal(doc.clock.waiting,true);
        }
        workers.get("slow").postMessage({type:"release",path});
        const plays=await Promise.all(loaded.map(user=>waitFor(event=>event.type==="play"&&event.user===user.id&&event.path===path)));
        assert.ok(plays.every(play=>play.offset===0&&play.forceBuffer));
        const scheduled=plays.map(play=>play.scheduledAt);assert.ok(Math.max(...scheduled)-Math.min(...scheduled)<50);
        const actual=plays.map(play=>play.startedAt);assert.ok(Math.max(...actual)-Math.min(...actual)<250);
        assert.ok(loaded.every(user=>events.some(event=>event.type==="socket"&&event.channel==="userActivity"&&event.user===user.id&&event.args[1]["yet-another-player-widget"]?.status==="ready")));
        if(track==="first")workers.get("gm").postMessage({type:"end",track});
      }
    }finally{await Promise.all([...workers.values()].map(worker=>worker.terminate()));}
  });
}
