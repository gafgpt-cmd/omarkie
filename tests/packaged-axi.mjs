import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { decode } from "@toon-format/toon";

const output = execFileSync(process.argv[2], ["--help"], { encoding: "utf8", timeout: 10_000 });
console.log(output.trim());
const help = decode(output);
assert.ok(help.commands.some(command => command.startsWith("omarkie-axi poll ")));
assert.ok(help.commands.some(command => command.startsWith("omarkie-axi reply ")));
