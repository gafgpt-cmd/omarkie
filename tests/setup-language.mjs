import { fileURLToPath } from "node:url";

// Assertions use the Chinese UI text; pin it unless a test run chooses otherwise.
process.env.OMARKIE_LANGUAGE ??= "zh";
process.env.SWC_NATIVE_BINDING_CACHE ??= fileURLToPath(new URL("../node_modules/.cache/swc", import.meta.url));
