import assert from "node:assert/strict";
import { PlaybackReadiness, READY_START_DELAY_MS, READY_RESPONSE_TIMEOUT_MS } from "../scripts/readiness.js";

export async function readinessTests(test) {
  const fixture = (loaded = [0,1,2], discoveryMs = 0) => {
    let now=1000, starts=0, beforePublish=()=>{}, members=[{id:"gm",name:"GM",isGM:true},{id:"fast",name:"Fast"},{id:"slow",name:"Slow"}];
    const clock={id:"start-1",path:"music/a.mp3",offset:0,at:1600,waiting:true};
    const docs=members.map(()=>({id:"track",parent:{id:"playlist"},path:clock.path,playing:true,clock:{...clock},getFlag(_,key){return this[key];}}));
    const clients=[];
    for (let i=0;i<members.length;i++) {
      const user=members[i];
      clients.push(new PlaybackReadiness({now:()=>now,user:()=>user,users:()=>members,leader:()=>"gm",discoveryMs,
        send:message=>clients[0].receive(message),
        publish:async(doc,original,ready)=>{await beforePublish();if(!ready())return;starts++;for(const target of docs)target.clock={...original,waiting:false,at:now+READY_START_DELAY_MS};}
      }));
      clients[i].track(docs[i],docs[i].clock);
    }
    for (const i of loaded) clients[i].activate();
    const report=(i,status="ready",error="")=>clients[i].report(docs[i],docs[i].clock,status,error);
    const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
    return {clients,docs,report,flush,get starts(){return starts;},set now(value){now=value;},set members(value){members=value;},get members(){return members;},set beforePublish(fn){beforePublish=fn;}};
  };
  await test("Shared start waits for the slowest connected client and uses a future server deadline for everyone",async()=>{
    const f=fixture();f.report(0);f.report(1);await f.flush();
    assert.equal(f.starts,0);assert.match(f.clients[0].status.message,/Slow/);assert.equal(f.clients[0].status.label,"Готовы 2/3");
    f.now=19000;f.report(2);await f.flush();assert.equal(f.starts,1);
    assert.ok(f.docs.every(doc=>doc.clock.waiting===false&&doc.clock.at===20200&&doc.clock.offset===0));
    f.clients.forEach(c=>c.tick());assert.ok(f.clients.every(c=>c.status===null));
  });
  await test("Load failure and browser audio lock hold the start until recovery; disconnected listeners stop blocking",async()=>{
    const f=fixture();f.report(0);f.report(1,"locked");f.report(2,"error","File unavailable");await f.flush();
    assert.equal(f.starts,0);assert.match(f.clients[0].status.message,/разрешить звук/);assert.match(f.clients[0].status.message,/File unavailable/);
    f.report(1);const offline=f.members[2];f.members=f.members.slice(0,2);f.clients[0].userConnected(offline);await f.flush();
    assert.equal(f.starts,1);
  });
  await test("Reloaded widgets must acknowledge again and newly loaded listeners join before the final write",async()=>{
    const f=fixture();f.report(0);f.report(1);const fast=f.members[1];f.clients[0].userConnected(fast);
    f.clients[1].announceWidget(true);
    f.report(2);await f.flush();assert.equal(f.starts,0);assert.match(f.clients[0].status.message,/Fast/);
    f.now=2500;f.report(1);await f.flush();assert.equal(f.starts,1);
    const joined=fixture();let release;joined.beforePublish=()=>new Promise(resolve=>release=resolve);
    joined.report(0);joined.report(1);joined.report(2);await joined.flush();
    joined.members=[...joined.members,{id:"new",name:"Joined"}];
    joined.clients[0].receive({type:"widget-ready",userId:"new",widgetId:"joined-widget"});
    release();await joined.flush();assert.equal(joined.starts,0);
  });
  await test("Stale, foreign and non-member acknowledgements cannot release a cancelled or replaced track",async()=>{
    const f=fixture();f.report(0);f.report(1);
    const ack={type:"audio-ready",playlistId:"playlist",trackId:"track",clockId:"old-clock",userId:"slow",status:"ready"};
    f.clients[0].receive(ack);f.clients[0].receive({...ack,clockId:"start-1",userId:"intruder"});await f.flush();assert.equal(f.starts,0);
    f.docs.forEach(doc=>doc.playing=false);f.report(2);f.clients[0].tick();await f.flush();assert.equal(f.starts,0);assert.equal(f.clients[0].status,null);
    const replaced=fixture();replaced.report(0);replaced.report(1);
    replaced.docs[0].clock={...replaced.docs[0].clock,id:"replacement"};replaced.report(2);await replaced.flush();assert.equal(replaced.starts,0);
  });
  await test("A delayed GM queue rechecks cancellation, and duplicate readiness reports publish only once",async()=>{
    const f=fixture();let release;f.beforePublish=()=>new Promise(resolve=>release=resolve);
    f.report(0);f.report(1);f.report(2);f.report(2);await f.flush();f.docs[0].playing=false;release();await f.flush();assert.equal(f.starts,0);
    const repeated=fixture();repeated.report(0);repeated.report(1);repeated.report(2);repeated.report(2);await repeated.flush();assert.equal(repeated.starts,1);
  });
  await test("Each layer waits independently and lost readiness messages are retried",async()=>{
    const f=fixture(),gm=f.clients[0],second={...f.docs[0],id:"rain",clock:{id:"rain-clock",path:"music/a.mp3",offset:0,at:1600,waiting:true}};
    gm.track(second,second.clock);gm.report(second,second.clock,"ready");
    f.report(0);f.report(1);f.report(2);await f.flush();assert.equal(f.starts,1);assert.equal(second.clock.waiting,true);
    const retry=fixture();retry.clients[2].send=()=>{};retry.report(0);retry.report(1);retry.report(2);await retry.flush();assert.equal(retry.starts,0);
    retry.clients[2].send=message=>retry.clients[0].receive(message);retry.now=2500;retry.clients[2].tick();await retry.flush();assert.equal(retry.starts,1);
  });
  await test("A silent client becomes an explicit missing-response error and is never treated as ready",async()=>{
    const f=fixture();f.report(0);f.report(1);f.now=1000+READY_RESPONSE_TIMEOUT_MS;f.clients[0].tick();await f.flush();
    assert.equal(f.starts,0);assert.equal(f.clients[0].status.label,"Готовы 2/3");assert.equal(f.clients[0].status.error,true);
    assert.match(f.clients[0].status.message,/Нет ответа от: Slow/);assert.match(f.clients[0].status.message,/Ctrl\+F5/);
    f.report(2,"loading");assert.equal(f.clients[0].status.error,false);assert.equal(f.starts,0);
    f.report(2);await f.flush();assert.equal(f.starts,1);
  });
  await test("Users listed as active but without a loaded widget do not block or count toward the common start",async()=>{
    const f=fixture([0,1]);f.report(0);f.report(1,"loading");await f.flush();
    assert.equal(f.starts,0);assert.equal(f.clients[0].status.label,"Готовы 1/2");
    assert.match(f.clients[0].status.message,/Fast/);assert.doesNotMatch(f.clients[0].status.message,/Slow/);
    f.report(1);await f.flush();assert.equal(f.starts,1);
    const clock={...f.docs[0].clock};f.clients[2].activate();await f.flush();
    assert.equal(f.starts,1);assert.deepEqual(f.docs[0].clock,clock);
    const alone=fixture([0]);alone.report(0);await alone.flush();assert.equal(alone.starts,1);
  });
  await test("A new GM first discovers loaded widgets, and continues waiting for their audio rather than for unopened clients",async()=>{
    const f=fixture([0],1000);f.report(0);await f.flush();assert.equal(f.starts,0);
    f.now=1500;f.clients[1].activate();f.report(1,"loading");
    f.now=2100;f.clients[0].tick();await f.flush();assert.equal(f.starts,0);
    assert.equal(f.clients[0].status.label,"Готовы 1/2");
    f.report(1);await f.flush();assert.equal(f.starts,1);
  });
  await test("An unloaded widget stops blocking, while a late unload from its previous page cannot evict the replacement",async()=>{
    const f=fixture();f.report(0);f.report(1);f.clients[2].deactivate();await f.flush();assert.equal(f.starts,1);
    const replacement=fixture();replacement.report(0);replacement.report(1);
    const oldId=replacement.clients[2].widgetId,gm=replacement.clients[0];
    gm.receive({type:"widget-ready",userId:"slow",widgetId:"replacement"});
    gm.receive({type:"widget-unloaded",userId:"slow",widgetId:oldId});
    await replacement.flush();assert.equal(replacement.starts,0);
    gm.receive({type:"audio-ready",playlistId:"playlist",trackId:"track",clockId:"start-1",userId:"slow",widgetId:"replacement",status:"ready"});
    await replacement.flush();assert.equal(replacement.starts,1);
  });
}
