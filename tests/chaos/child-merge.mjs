// Child merger for the power-cut row: real GlassService, killed from the parent mid Merge down.
import process from "node:process";
import { GlassService } from "../../electron/glass-service.mjs";

const [folder, data, note, magnet] = process.argv.slice(2);
const service = await new GlassService({ root: folder, appData: data, device: "chaos-merge" }).open();
process.stdout.write("ready\n");
const result = await service.request({ action: "merge-accept", note, magnet, approved: true });
process.stdout.write(`merged ${result.merge?.id ?? "none"}\n`);
await service.close();
