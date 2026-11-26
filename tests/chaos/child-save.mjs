// Child writer for the kill -9 row: real GlassService, one fsync per journal line, killed from the parent.
import process from "node:process";
import { GlassService } from "../../electron/glass-service.mjs";

const [folder, data, note, count] = process.argv.slice(2);
const service = await new GlassService({ root: folder, appData: data, device: "chaos-child" }).open();
process.stdout.write("ready\n");
for (let index = 0; index < Number(count); index += 1) {
  const result = await service.request({ action: "add", note, magnet: `m-${index}`, text: `op ${index}` });
  if (result.saved) process.stdout.write(`saved ${index}\n`);
}
await service.close();
process.stdout.write("done\n");
