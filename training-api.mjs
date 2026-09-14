import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_BODY = 30 * 1024 * 1024;
const json = (response, status, value) => response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(JSON.stringify(value));
const fail = (message, status) => Object.assign(new Error(message), { status });

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw fail("Use application/json.", 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= MAX_BODY) chunks.push(chunk);
  }
  if (bytes > MAX_BODY) throw fail("Training request exceeds 30 MB.", 413);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw fail("Invalid training request JSON.", 400);
  }
}

export function createTrainingApi(trainer = null) {
  const token = randomBytes(32).toString("hex");
  const clients = new Set();
  const handler = async (request, response, pathname) => {
    if (!pathname.startsWith("/api/training/")) return false;
    try {
      const host = request.headers.host;
      const port = request.socket.localPort;
      if (![ `127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ["127.0.0.1", "localhost"] : []) ].includes(host)) throw fail("Local training requires a loopback host.", 403);
      const expectedOrigin = `http://${host}`;
      if ((request.headers.origin && request.headers.origin !== expectedOrigin) ||
          (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"]))) throw fail("Cross-origin training requests are not allowed.", 403);
      if (!["GET", "POST"].includes(request.method)) throw fail("Training API method not allowed.", 405);
      if (request.method === "POST") {
        const supplied = Buffer.from(request.headers["x-mamase-token"] || "");
        const expected = Buffer.from(token);
        if (request.headers.origin !== expectedOrigin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail("Reload Mamase before issuing local training commands.", 403);
      }
      if (pathname === "/api/training/capabilities" && request.method === "GET") {
        const capability = trainer ? await trainer.availability() : { enabled: false, available: false, backend: "mlx-lm", message: "Local training is disabled for this server. Start Mamase with npm run dev." };
        json(response, 200, { ...capability, token });
      } else if (/^\/api\/training\/runs\/[a-zA-Z0-9_-]{1,80}$/.test(pathname) && request.method === "GET") {
        json(response, 200, { job: trainer ? await trainer.findRun(pathname.split("/").at(-1)) : null });
      } else if (pathname === "/api/training/jobs" && request.method === "POST") {
        if (!trainer) throw fail("Local training is disabled.", 503);
        const job = await trainer.launch(await readJson(request));
        json(response, 201, { job });
      } else {
        const match = pathname.match(/^\/api\/training\/jobs\/(job-[a-f0-9-]{36})(?:\/(events|cancel|report))?$/);
        if (!match || !trainer) throw fail("Local job endpoint not found.", 404);
        const [, id, action] = match;
        const job = await trainer.get(id);
        if (action === "cancel" && request.method === "POST") {
          await readJson(request);
          json(response, 200, { job: await trainer.cancel(id) });
        } else if (request.method !== "GET") throw fail("Training API method not allowed.", 405);
        else if (action === "report") {
          response.setHeader("Content-Disposition", `attachment; filename="${id}-report.json"`);
          json(response, 200, { schema: "mamase.run-report.v1", runId: job.run.id, updates: job.run.history });
        } else if (action === "events") {
          response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Content-Type-Options": "nosniff" });
          clients.add(response);
          const send = (value) => {
            if (response.writableEnded || response.destroyed) return;
            if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); return; }
            response.write(`data: ${JSON.stringify(value)}\n\n`);
          };
          send({ type: "snapshot", job });
          const update = (jobId, event) => { if (jobId === id) send(event); };
          trainer.on("update", update);
          const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 15000);
          response.on("close", () => { clearInterval(heartbeat); clients.delete(response); trainer.off("update", update); });
        } else if (!action) json(response, 200, { job });
        else throw fail("Local job endpoint not found.", 404);
      }
    } catch (error) {
      if (!response.headersSent) json(response, error.status || (error.code ? 500 : 400), { error: error.message });
      else response.destroy(error);
    }
    return true;
  };
  handler.close = () => { for (const response of clients) response.end(); };
  return handler;
}
