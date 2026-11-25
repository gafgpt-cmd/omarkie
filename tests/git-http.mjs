// Minimal smart-HTTP bridge to a bare repository for offline sync tests. Each request runs
// `git http-backend` with CGI variables, so the real Git protocol is exercised without a network.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

function backend(projectRoot, request, body) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: request.url.split("?")[0],
      QUERY_STRING: request.url.split("?")[1] ?? "",
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: "test",
      REMOTE_ADDR: "127.0.0.1",
    } });
    const chunks = [], errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`git http-backend failed: ${Buffer.concat(errors)}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(body);
  });
}

export async function gitHttpServer(projectRoot) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const output = await backend(projectRoot, request, Buffer.concat(chunks));
      const split = output.indexOf("\r\n\r\n");
      const head = output.subarray(0, split).toString("utf8").split("\r\n");
      const body = output.subarray(split + 4);
      let status = 200;
      const headers = {};
      for (const line of head) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        const name = line.slice(0, at).toLowerCase(), value = line.slice(at + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      response.writeHead(status, { ...headers, "content-length": String(body.length) });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
