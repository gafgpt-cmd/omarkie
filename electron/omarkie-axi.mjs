import { main } from "./tutor-cli.mjs";

process.stdout.on("error", error => {
  if (error.code !== "EPIPE") throw error;
  process.exit(0);
});
await main();
