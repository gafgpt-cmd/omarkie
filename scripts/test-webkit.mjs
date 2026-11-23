import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-webkit-"));
const uploads = [];
const payloadRequests = [];
const payloadBoundaryRequests = [];
const readerMediaRequests = [];
const projectMediaRequests = [];
const grammarRequests = [];
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/reader-media-")) {
    readerMediaRequests.push(request.url);
    response.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=", "base64"));
    return;
  }
  if (request.url?.startsWith("/project-export-media")) {
    projectMediaRequests.push(request.url);
    response.writeHead(404).end();
    return;
  }
  if (request.url?.endsWith("/v2/check")) {
    let body = ""; for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    grammarRequests.push([request.method, request.url, form.get("text"), form.get("language")]);
    if (request.url.startsWith("/redirect/")) response.writeHead(307, { location: "/v2/check" }).end();
    else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ matches: [{ offset: 0, length: 1, message: "Synthetic finding" }] }));
    return;
  }
  if (request.url === "/payload/v1/chat/completions") {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const boundary = { "fixture-under": [63_999, 200], "fixture-over": [64_001, 200], "fixture-status": [63_999, 400] }[payload.model];
    if (boundary) {
      payloadBoundaryRequests.push(payload.model);
      const [size, status] = boundary;
      const wrap = content => JSON.stringify({ choices: [{ message: { content } }] });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.write(wrap("x".repeat(size - Buffer.byteLength(wrap("")))));
      response.end();
      return;
    }
    payloadRequests.push(payload);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: payload.messages.length === 3 ? "Synthetic follow-up answer." : "Synthetic summary." } }] }));
    return;
  }
  try { let body = ""; for await (const chunk of request) body += chunk; const value = JSON.parse(body); assert.equal(request.method, "POST"); assert.equal(value.list.length, 1); const file = value.list[0]; assert.match(file, /fixture-[A-Fa-f0-9-]+\.png$/); const bytes = await readFile(file); assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]); uploads.push({ bytes: bytes.length }); response.writeHead(200, {"Content-Type":"application/json"}); response.end(JSON.stringify({success:true,result:["https://images.example.invalid/owned-fixture.png"]})); }
  catch (error) { response.writeHead(400); response.end(JSON.stringify({error:error.message})); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const uploaderURL = `http://127.0.0.1:${server.address().port}/upload`;
const payloadBaseURL = `http://127.0.0.1:${server.address().port}/payload/v1`;

try {
  const contents = path.join(directory, "WebKitTests.app/Contents"),
    resources = path.join(contents, "Resources"),
    executable = path.join(contents, "MacOS/WebKitTests");
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(resources, { recursive: true });
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
      "-D",
      "WEBTEST",
      "-swift-version",
      "5",
      "native/DocumentStore.swift",
    "native/Workspace.swift",
    "native/Interchange.swift",
    "native/ImageActions.swift",
      "native/App.swift",
      "native/PDFExporter.swift",
      "tests/WebKitTests.swift",
      "native/LearningTools.swift",
      "native/ReadingStore.swift",
      "native/Bibliography.swift",
      "native/Speech.swift",
      "-framework",
      "JavaScriptCore",
      "-o",
      executable,
      "-framework",
      "AppKit",
      "-framework",
      "WebKit",
    ],
    { stdio: "inherit" },
  );
  await cp("dist", path.join(resources, "dist"), { recursive: true });
  await cp("native/bridge.js", path.join(resources, "bridge.js"));
  await cp("third-party/csl", path.join(resources, "csl"), { recursive: true });
  await cp("docs/showcase", path.join(resources, "showcase"), { recursive: true });
  await cp("shared/commands.json", path.join(resources, "commands.json"));
  await cp("shared/plugin-loader.js", path.join(resources, "plugin-loader.js"));
  await cp("shared/reading-core.cjs", path.join(resources, "reading-core.cjs"));
  await cp("shared/locales", path.join(resources, "locales"), { recursive: true });
  await cp("shared/payload-recipe.json", path.join(resources, "payload-recipe.json"));
  await cp("shared/tts-limit.json", path.join(resources, "tts-limit.json"));
  await cp("tests/fixtures/plugin-package", path.join(resources, "Plugin-package-fixture"), {recursive:true});
  await cp("tests/webkit.js", path.join(resources, "web-tests.js"));
  await writeFile(
    path.join(contents, "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.omarkie.webkittests</string><key>CFBundleExecutable</key><string>WebKitTests</string><key>NSAppTransportSecurity</key><dict><key>NSExceptionDomains</key><dict><key>127.0.0.1</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict></dict></dict></plist>',
  );
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      path.join(directory, "WebKitTests.app"),
    ],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    const child = spawn(executable, {
      env: {
        ...process.env,
        OMARKIE_TEST_LANGUAGE: "en",
        OMARKIE_DATA_DIR: path.join(directory, "data"),
        OMARKIE_TEST_UPLOADER: uploaderURL,
        OMARKIE_TEST_PAYLOAD: payloadBaseURL,
        OMARKIE_TEST_GRAMMAR: `http://127.0.0.1:${server.address().port}`,
        OMARKIE_TTS: JSON.stringify([process.execPath, "-e", 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], fs.readFileSync(0));', path.join(directory, "spoken.txt")]),
        OMARKIE_CLEAN_SCRIPT: JSON.stringify([process.execPath, path.resolve("tests/fixtures/clean-script.cjs"), "complete"]),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`WebKit tests exited ${code}`)),
    );
  });
  assert.equal(uploads.length, 1, "native PicGo request reaches the owned HTTP fixture once");
  assert.ok(readerMediaRequests.includes("/reader-media-control"), "editing loads the owned media fixture");
  assert.ok(readerMediaRequests.every(route => ["/reader-media-control", "/reader-media-poster"].includes(route)), "only editing media routes are requested");
  assert.deepEqual(payloadBoundaryRequests, ["fixture-under", "fixture-over", "fixture-status"]);
  assert.deepEqual(projectMediaRequests, ["/project-export-media-control"], "only the unrestricted native PDF renderer loads the fixture");
  console.log("PASS: native PicGo integration sends owned PNG bytes and accepts the returned URL");
  assert.deepEqual(payloadRequests.map(body => [body.model, body.max_tokens, body.max_completion_tokens, body.messages.slice(1).map(message => message.content)]), [
    ["native-fixture", 768, undefined, ["Synthetic source paragraph."]],
    ["native-fixture", undefined, 384, ["Synthetic source paragraph.", "What is this?"]],
  ]);
  console.log("PASS: native Payload only sends approved bounded requests to the owned endpoint");
  assert.deepEqual(grammarRequests, [
    ["POST", "/v2/check", "A😀 + &?", "auto"],
    ["POST", "/redirect/v2/check", "A😀 + &?", "auto"],
  ]);
  assert.equal(await readFile(path.join(directory, "spoken.txt"), "utf8"), "Native café $(literal) speech.😀".padEnd(256_000, "x"));
  console.log("PASS: native grammar loopback and redirect refusal; synthetic speech receives literal UTF-8 stdin");
  if (process.env.OMARKIE_QA_DIR) {
    await mkdir(process.env.OMARKIE_QA_DIR, { recursive: true });
    await cp(path.join(directory, "data/native-test-long.pdf"), path.join(process.env.OMARKIE_QA_DIR, "native-pagination.pdf"));
    for (const name of await readdir(path.join(directory, "data"))) if ((name.startsWith("native-converted.") || name === "native-complex.pdf")) await cp(path.join(directory, "data", name), path.join(process.env.OMARKIE_QA_DIR, name), { recursive: true });
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  if (process.env.OMARKIE_QA_DIR) { try { for (const name of await readdir(path.join(directory, "data"))) if ((name.startsWith("native-converted.") || name === "native-complex.pdf")) await cp(path.join(directory, "data", name), path.join(process.env.OMARKIE_QA_DIR, name), { recursive: true }); } catch {} await mkdir(process.env.OMARKIE_QA_DIR, { recursive: true }); try { await cp(path.join(directory, "data/native-test-long.pdf"), path.join(process.env.OMARKIE_QA_DIR, "native-pagination.pdf")); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
