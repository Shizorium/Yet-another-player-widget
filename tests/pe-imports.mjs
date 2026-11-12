import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function peImports(file) {
  const data = await fs.readFile(file), pe = data.readUInt32LE(60), optional = pe + 24;
  const count = data.readUInt16LE(pe + 6), size = data.readUInt16LE(pe + 20);
  const directories = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const sections = Array.from({ length: count }, (_, i) => {
    const offset = optional + size + 40 * i;
    return { rva: data.readUInt32LE(offset + 12), raw: data.readUInt32LE(offset + 20), size: Math.max(data.readUInt32LE(offset + 8),data.readUInt32LE(offset + 16)) };
  });
  const at = rva => { const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size); return section ? section.raw + rva - section.rva : rva; };
  const names = [], imports = at(data.readUInt32LE(directories + 8));
  for (let i = 0; i < 100; i++) {
    const rva = data.readUInt32LE(imports + i * 20 + 12); if (!rva) break;
    const start = at(rva), end = data.indexOf(0,start); names.push(data.toString("ascii",start,end));
  }
  return names;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await peImports(process.argv[2])));
