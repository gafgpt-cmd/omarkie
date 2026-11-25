// Child for the no-network row: the whole manual surface must work with no interfaces at all.
import process from "node:process";
import { GlassService } from "../../electron/glass-service.mjs";

const [folder, data] = process.argv.slice(2);
const service = await new GlassService({ root: folder, appData: data, device: "offline-child" }).open();
await service.request({ action: "add", note: "map.md", magnet: "m-offline", text: "offline pin" });
const listed = await service.request({ action: "list", note: "map.md" });
if (listed.magnets.length !== 1) throw new Error("offline glass lost its magnet");
await service.close();
process.stdout.write("offline-ok\n");
