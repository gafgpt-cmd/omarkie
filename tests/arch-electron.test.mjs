import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { archPkgver, describeBuild, electronSeries } from "../scripts/arch-electron.mjs";

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

test("builds past the release tag get a pkgver pacman sorts as newer", t => {
  assert.equal(archPkgver("0.1.0", "v0.1.0-0-gdcb6c9e\n"), "0.1.0");
  assert.equal(archPkgver("0.1.0", "v0.1.0-3-gdcb6c9e\n"), "0.1.0.r3.gdcb6c9e");
  assert.equal(archPkgver("0.1.2", "v0.1.1-2-gabc1234"), "0.1.2.r2.gabc1234");
  assert.equal(archPkgver("0.1.2", "abc1234"), "0.1.2.r0.gabc1234");
  for (const describe of ["", "garbage"]) assert.equal(archPkgver("0.1.0", describe), "0.1.0");
  const vercmp = (a, b) => Number(execFileSync("vercmp", [a, b], { encoding: "utf8" }));
  try { vercmp("1", "1"); } catch { return t.skip("vercmp (pacman) not installed"); }
  assert.equal(vercmp("0.1.0.r3.gdcb6c9e", "0.1.0"), 1);
  assert.equal(vercmp("0.1.0.r10.gaaaaaaa", "0.1.0.r3.gdcb6c9e"), 1);
  assert.equal(vercmp("0.1.1", "0.1.0.r10.gaaaaaaa"), 1);
});

test("an unreleased version still identifies the source commit instead of claiming a plain release", t => {
  let revision;
  try { revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return t.skip("Source archive without Git metadata"); }
  const version = archPkgver("99999.0.0", describeBuild("99999.0.0"));
  assert.ok(version.endsWith(`.g${revision}`), version);
  assert.notEqual(version, "99999.0.0");
});
