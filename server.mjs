import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/theme.js", ["theme.js", "text/javascript"]],
  ["/ui.js", ["ui.js", "text/javascript"]],
  ["/workspace.js", ["workspace.js", "text/javascript"]],
  ["/experience.js", ["experience.js", "text/javascript"]],
  ["/validation.js", ["validation.js", "text/javascript"]],
  ["/results.js", ["results.js", "text/javascript"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

export function createAppServer() {
  return createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch (error) {
      if (!(error instanceof URIError || error instanceof TypeError)) throw error;
      response.writeHead(400).end("Invalid URL");
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader("Content-Type", `${file[1]}; charset=utf-8`);
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    try {
      await pipeline(createReadStream(new URL(file[0], import.meta.url)), response);
    } catch (error) {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error(`Unable to serve ${pathname}:`, error.message);
      response.destroy();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const server = createAppServer();
  server.on("error", (error) => {
    console.error(`Unable to start Mamase: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Coven Distillation Lab: http://127.0.0.1:${port}`));
}
