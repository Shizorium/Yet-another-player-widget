// Optional real network check; keeps the downloaded sample outside the Foundry library.
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Downloader} from '../helper/server.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'yapw-youtube-smoke-'));
const queue=new Downloader({stateDir:path.join(root,'state'),mediaDir:path.join(root,'media')});
await queue.init();
const job=await queue.enqueue({world:'smoke',key:'sample',kind:'download',url:process.argv[2]||'https://www.youtube.com/watch?v=Z4C82eyhwgU'});
let last='';
const timer=setTimeout(()=>{queue.stopped=true;queue.child?.kill();},120000);
while(queue.running){const status=`${job.status} ${Math.round(job.progress||0)}%`;if(status!==last){console.log(status);last=status;}await new Promise(resolve=>setTimeout(resolve,1000));}
clearTimeout(timer);await queue.close();
console.log(JSON.stringify({status:job.status,result:job.result,error:job.error,savedTo:root}));
if(job.status!=='ready')process.exitCode=1;
