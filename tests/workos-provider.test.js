import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { WorkOS } from "@workos-inc/node";
import { createWorkOSProvider } from "../workos-provider.mjs";

async function issuer(context) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
  const state = { expired: false, failure: null, requests: [] };
  const jwt = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: "user_fixture", sid: "session_fixture", exp: Math.floor(Date.now() / 1000) + (state.expired ? -60 : 300),
    })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/sso/jwks/client_fixture") {
      response.end(JSON.stringify({ keys: [key] }));
      return;
    }
    if (request.url !== "/user_management/authenticate") {
      response.writeHead(404).end("{}");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    state.requests.push(body);
    const refresh = body.grant_type === "refresh_token";
    if (refresh && state.failure) {
      response.writeHead(state.failure.status, { "Retry-After": "2" }).end(JSON.stringify({
        error: state.failure.code, error_description: "Synthetic provider failure.", message: "Synthetic provider failure.",
      }));
      return;
    }
    if (refresh) state.expired = false;
    response.end(JSON.stringify({
      access_token: jwt(), refresh_token: refresh ? "rotated-refresh-fixture" : "original-refresh-fixture",
      authentication_method: "OAuth",
      user: {
        object: "user", id: "user_fixture", email: "coven@example.test", email_verified: true,
        first_name: refresh ? "Updated" : "Coven", last_name: "Member", profile_picture_url: null,
        created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", metadata: {},
      },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    apiKey: "sk_test_synthetic_fixture", clientId: "client_fixture",
    cookiePassword: "synthetic-cookie-password-for-tests-only",
    origin: "https://mamase.example", redirectUri: "https://mamase.example/api/auth/callback",
  };
  const sdk = new WorkOS(config.apiKey, {
    clientId: config.clientId, apiHostname: "127.0.0.1", https: false, port: server.address().port, maxRetries: 0, timeout: 1000,
  });
  return { config, state, provider: createWorkOSProvider(config, sdk) };
}

test("real SDK exchange sends PKCE, seals tokens and verifies the returned JWT against JWKS", async (context) => {
  const { provider, state, config } = await issuer(context);
  const { sealedSession } = await provider.exchange({ code: "synthetic-code", codeVerifier: "synthetic-verifier" });
  assert.equal(state.requests[0].code, "synthetic-code");
  assert.equal(state.requests[0].code_verifier, "synthetic-verifier");
  assert.equal(state.requests[0].client_id, config.clientId);
  assert.equal(state.requests[0].client_secret, config.apiKey);
  assert.ok(!sealedSession.includes("original-refresh-fixture"));
  const session = await provider.session(sealedSession);
  assert.equal(session.authenticated, true);
  assert.equal(session.user.email, "coven@example.test");
  assert.equal(session.accessToken, undefined);
  assert.equal(session.refreshToken, undefined);
  const logout = new URL(await provider.logout(sealedSession));
  assert.equal(logout.searchParams.get("session_id"), "session_fixture");
  assert.equal(logout.searchParams.get("return_to"), config.origin + "/");
  assert.deepEqual(await provider.session("corrupt-cookie"), { authenticated: false });
  assert.equal(await provider.logout("corrupt-cookie"), null);
});

test("expired SDK access tokens refresh into a new seal and the latest user profile", async (context) => {
  const { provider, state } = await issuer(context);
  state.expired = true;
  const { sealedSession } = await provider.exchange({ code: "expired-token-fixture", codeVerifier: "fixture" });
  const result = await provider.session(sealedSession);
  assert.equal(result.authenticated, true);
  assert.equal(result.user.firstName, "Updated");
  assert.ok(result.sealedSession);
  assert.notEqual(result.sealedSession, sealedSession);
  assert.equal(state.requests[1].grant_type, "refresh_token");
  assert.equal(state.requests[1].refresh_token, "original-refresh-fixture");
});

test("real SDK terminal refresh failures differ from temporary provider outages", async (context) => {
  const { provider, state } = await issuer(context);
  state.expired = true;
  const { sealedSession } = await provider.exchange({ code: "expired-token-fixture", codeVerifier: "fixture" });
  for (const failure of [{ status: 429, code: "rate_limit_exceeded" }, { status: 503, code: "server_error" }]) {
    state.failure = failure;
    await assert.rejects(provider.session(sealedSession), /temporarily unavailable/);
    await assert.rejects(provider.logout(sealedSession), /temporarily unavailable/);
  }
  state.failure = { status: 400, code: "invalid_grant" };
  assert.deepEqual(await provider.session(sealedSession), { authenticated: false });
  assert.equal(await provider.logout(sealedSession), null);
});
