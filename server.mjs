import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createTrainingApi } from "./training-api.mjs";
import { LocalTrainer } from "./local-training.mjs";
import { publicAssets as files } from "./public-assets.mjs";
import { createAuthApi } from "./auth-api.mjs";
import { apiAccessRefusal, sendApiRefusal } from "./api-access.mjs";

/** Workspace APIs stay closed until the signed-in account is on the approved list. */
async function allowApiRequest(request, response, auth) {
  const refusal = await apiAccessRefusal(auth, request);
  if (!refusal) return true;
  if (refusal.unexpected) console.error("Unable to check workspace access against the account service.");
  sendApiRefusal(response, refusal);
  return false;
}

export function createAppServer({ training = null, inference, auth = createAuthApi() } = {}) {
  const trainingApi = createTrainingApi(training, inference);
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch (error) {
      if (!(error instanceof URIError || error instanceof TypeError)) throw error;
      response.writeHead(400).end("Invalid URL");
      return;
    }
    if (await auth(request, response, pathname)) return;
    if (pathname.startsWith("/api/") && !(await allowApiRequest(request, response, auth))) return;
    if (await trainingApi(request, response, pathname)) return;
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
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
  server.closeTrainingConnections = trainingApi.close;
  server.closeLocalRuntime = async () => {
    await trainingApi.close();
    await training?.close();
  };
  server.on("close", () => { void trainingApi.close(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const training = new LocalTrainer({ ...(process.env.MAMASE_TRAINING_DIR ? { root: process.env.MAMASE_TRAINING_DIR } : {}) });
  const server = createAppServer({ training });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closing = server.closeLocalRuntime();
    server.close();
    try { await closing; } catch (error) { console.error(`Unable to close local training cleanly: ${error.message}`); process.exitCode = 1; }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("error", (error) => {
    console.error(`Unable to start Mamase: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Coven Distillation Lab: http://127.0.0.1:${port}`));
}
