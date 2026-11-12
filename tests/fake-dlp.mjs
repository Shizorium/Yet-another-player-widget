// Deterministic child process used to test the real worker without downloading media.
import fs from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
const args = process.argv.slice(2), url = args.at(-1);
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({ title:"Test playlist", entries:[{id:"abcdefghijk",title:"First",duration:123},{id:"lmnopqrstuv",title:"Second",duration:42},null] }));
} else {
  const target = args[args.indexOf("-o")+1], dir = path.dirname(target);
  await fs.mkdir(dir,{recursive:true});
  if (url.includes("errorerror1")) { console.error("ERROR: This test video is unavailable"); process.exit(1); }
  console.log("YAPW: 25.0%");
  if (url.includes("slowvideo01")) {
    const descendant = spawn(process.execPath, ["-e", `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(path.join(dir,"descendant-finished"))},'finished'),1500)`], {windowsHide:true,stdio:"ignore"});
    await fs.writeFile(path.join(dir,"descendant.pid"),String(descendant.pid));
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  await new Promise(resolve=>setTimeout(resolve,60));
  console.log("YAPW: 100.0%");
  console.log("[ExtractAudio] Destination: track.mp3");
  await fs.writeFile(path.join(dir,"track.mp3"),"fixture");
  await fs.writeFile(path.join(dir,"track.jpg"),"fixture");
  await fs.writeFile(path.join(dir,"track.info.json"),JSON.stringify({title:"Downloaded track",duration:123}));
}
