import test from "node:test";
import assert from "node:assert/strict";
import { electronSeries } from "../scripts/arch-electron.mjs";

test("the Arch package reuses the newest installed Electron series from the minimum up", () => {
  assert.equal(electronSeries({ installed: ["obsidian", "electron43", "gtk3"], recommended: 44 }), "electron43");
  assert.equal(electronSeries({ installed: ["electron43", "electron46"], recommended: 44 }), "electron46");
  assert.equal(electronSeries({ installed: ["electron42", "electron"], recommended: 44 }), "electron44");
  assert.equal(electronSeries({ installed: [], recommended: 44 }), "electron44");
});

test("an explicit runtime choice wins and is validated", () => {
  assert.equal(electronSeries({ override: "electron45", installed: ["electron43"], recommended: 44 }), "electron45");
  for (const bad of ["electron42", "electron", "electron043", "electron44; rm -rf /"])
    assert.throws(() => electronSeries({ override: bad, installed: [], recommended: 44 }), /OMARKIE_ELECTRON/);
});
