import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessRefusal, parseAccessList } from "./access-list.mjs";

const TRANSACTION_SECONDS = 600;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_COOKIE_VALUE = 3800;
const NOT_CONFIGURED = "WorkOS sign-in is not configured for this deployment. Your local workspace remains available.";

class AuthError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const json = (response, status, value) => response.writeHead(status, {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
}).end(JSON.stringify(value));

function configuration(env) {
  const values = [env.WORKOS_API_KEY, env.WORKOS_CLIENT_ID, env.WORKOS_COOKIE_PASSWORD];
  if (!values.some((value) => value?.trim())) return null;
  if (!values.every((value) => typeof value === "string" && value.trim()) ||
      env.WORKOS_COOKIE_PASSWORD.length < 32 || !env.WORKOS_REDIRECT_URI) {
    throw new AuthError("WorkOS configuration is incomplete. Set the API key, client ID, redirect URI and a cookie password of at least 32 characters.", 503);
  }
  let redirect;
  try { redirect = new URL(env.WORKOS_REDIRECT_URI); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AuthError("WorkOS configuration has an invalid redirect URI.", 503);
  }
  let accessList;
  try { accessList = parseAccessList(env.MAMASE_ACCESS_LIST); } catch (error) {
    throw new AuthError(`WorkOS configuration has an invalid approved-account list. ${error.message}`, 503);
  }
  const secure = redirect.protocol === "https:";
  if ((!secure && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))) ||
      redirect.username || redirect.password || redirect.pathname !== "/api/auth/callback" || redirect.search || redirect.hash) {
    throw new AuthError("WorkOS configuration requires an HTTPS /api/auth/callback URL, or HTTP on loopback for local development.", 503);
  }
  return {
    apiKey: env.WORKOS_API_KEY.trim(), clientId: env.WORKOS_CLIENT_ID.trim(),
    cookiePassword: env.WORKOS_COOKIE_PASSWORD, redirectUri: redirect.href, accessList,
    origin: redirect.origin, host: redirect.host, secure,
    stateCookie: `${secure ? "__Host-" : ""}mamase_auth_state`,
    sessionCookie: `${secure ? "__Host-" : ""}mamase_session`,
    stateKey: createHash("sha256").update(`mamase-oauth-state-v1:${env.WORKOS_COOKIE_PASSWORD}`).digest(),
  };
}

function cookie(request, name) {
  const matches = (request.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0].length > MAX_COOKIE_VALUE + name.length + 1) throw new AuthError("Invalid account cookie. Start sign-in again.", 400);
  try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new AuthError("Invalid account cookie. Start sign-in again.", 400);
  }
}

function setCookie(response, config, name, value, maxAge) {
  const encoded = encodeURIComponent(value);
  if (encoded.length > MAX_COOKIE_VALUE) throw new AuthError("The account session exceeds the supported cookie size.", 502);
  const entry = `${name}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? "; Secure" : ""}`;
  const previous = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", [...(Array.isArray(previous) ? previous : previous ? [previous] : []), entry]);
}

function sessionCookie(request, response, config) {
  try { return cookie(request, config.sessionCookie); } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 400) throw error;
    setCookie(response, config, config.sessionCookie, "", 0);
    return null;
  }
}

function returnPath(value, origin) {
  if (!value) return "/#/settings";
  if (value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value) || !value.startsWith("/#/")) throw new AuthError("Invalid return destination.", 400);
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname !== "/" || url.search) throw new AuthError("Invalid return destination.", 400);
  return `/${url.hash}`;
}

function sealTransaction(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
}

function openTransaction(value, key, now) {
  if (!value || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new AuthError("Invalid sign-in transaction.", 400);
  const [iv, ciphertext, tag] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new AuthError("Invalid sign-in transaction.", 400);
  let result;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    result = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch {
    throw new AuthError("Invalid sign-in transaction.", 400);
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !Number.isFinite(result.issuedAt) || now - result.issuedAt > TRANSACTION_SECONDS * 1000 || result.issuedAt > now + 30000 ||
      typeof result.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.state) ||
      typeof result.codeVerifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.codeVerifier)) {
    throw new AuthError("Expired or invalid sign-in transaction.", 400);
  }
  return result;
}

function safeProviderUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new AuthError("The account provider returned an invalid destination.", 502);
  return url.href;
}

function redirect(response, status, location) {
  response.writeHead(status, { Location: location }).end();
}

function callbackError(response, config, code) {
  redirect(response, 303, `${config.origin}/?auth_error=${code}#/settings`);
}

function publicUser(user) {
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") throw new AuthError("The account provider returned an invalid profile.", 502);
  return {
    id: user.id, email: user.email,
    firstName: typeof user.firstName === "string" ? user.firstName : "",
    lastName: typeof user.lastName === "string" ? user.lastName : "",
  };
}

export function createAuthApi({ env = process.env, provider = null, clock = Date.now, log = (value) => console.error(value) } = {}) {
  let loadedProvider = provider;
  const getProvider = async (config) => {
    if (!loadedProvider) {
      const { createWorkOSProvider } = await import("./workos-provider.mjs");
      loadedProvider = createWorkOSProvider(config);
    }
    return loadedProvider;
  };
  const handler = async (request, response, pathname) => {
    if (!pathname.startsWith("/api/auth/")) return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const action = pathname.slice("/api/auth/".length);
    try {
      if (!["login", "callback", "session", "logout"].includes(action)) throw new AuthError("Account endpoint not found.", 404);
      const method = action === "logout" ? "POST" : "GET";
      if (request.method !== method) {
        response.setHeader("Allow", method);
        throw new AuthError("Account endpoint method not allowed.", 405);
      }
      const config = configuration(env);
      if (!config) {
        if (action === "session") json(response, 200, { configured: false, authenticated: false, approved: false, message: NOT_CONFIGURED });
        else json(response, 503, { error: NOT_CONFIGURED });
        return true;
      }
      if (request.headers.host !== config.host) throw new AuthError("Account sign-in is configured for a different address. Use the configured callback origin.", 403);
      const url = new URL(request.url, config.origin);
      if (url.origin !== config.origin) throw new AuthError("Cross-origin account requests are not allowed.", 403);
      if (["session", "logout"].includes(action) &&
          ((request.headers.origin && request.headers.origin !== config.origin) ||
          (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])))) {
        throw new AuthError("Cross-origin account requests are not allowed.", 403);
      }
      if (action === "logout" && (request.headers.origin !== config.origin || request.headers["x-mamase-auth"] !== "1")) {
        throw new AuthError("Use the account's Sign out button.", 403);
      }
      if (action === "login") {
        if (url.searchParams.getAll("returnTo").length > 1) throw new AuthError("Invalid return destination.", 400);
        const destination = returnPath(url.searchParams.get("returnTo"), config.origin);
        const state = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const provider = await getProvider(config);
        const location = safeProviderUrl(await provider.authorizationUrl({ state, codeChallenge }));
        setCookie(response, config, config.stateCookie, sealTransaction({ state, codeVerifier, returnTo: destination, issuedAt: clock() }, config.stateKey), TRANSACTION_SECONDS);
        redirect(response, 302, location);
      } else if (action === "callback") {
        setCookie(response, config, config.stateCookie, "", 0);
        let transaction;
        try {
          transaction = openTransaction(cookie(request, config.stateCookie), config.stateKey, clock());
          const states = url.searchParams.getAll("state");
          const expected = Buffer.from(transaction.state);
          const supplied = Buffer.from(states[0] || "");
          if (states.length !== 1 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AuthError("Invalid sign-in state.", 400);
          transaction.returnTo = returnPath(transaction.returnTo, config.origin);
          if (url.searchParams.has("error")) { callbackError(response, config, "cancelled"); return true; }
          const codes = url.searchParams.getAll("code");
          if (codes.length !== 1 || !codes[0] || codes[0].length > 2048 || /[\u0000-\u001f\u007f]/.test(codes[0])) throw new AuthError("Invalid sign-in code.", 400);
        } catch (error) {
          if (!(error instanceof AuthError)) throw error;
          callbackError(response, config, "invalid_callback");
          return true;
        }
        try {
          const provider = await getProvider(config);
          const result = await provider.exchange({ code: url.searchParams.get("code"), codeVerifier: transaction.codeVerifier });
          if (typeof result.sealedSession !== "string" || !result.sealedSession) throw new AuthError("No sealed account session was returned.", 502);
          setCookie(response, config, config.sessionCookie, result.sealedSession, SESSION_SECONDS);
          redirect(response, 303, config.origin + transaction.returnTo);
        } catch {
          log({ event: "workos_request_failed", stage: "code_exchange" });
          callbackError(response, config, "exchange_failed");
        }
      } else if (action === "session") {
        const sessionData = sessionCookie(request, response, config);
        if (!sessionData) {
          json(response, 200, { configured: true, authenticated: false, approved: false, user: null, message: accessRefusal(config.accessList, { authenticated: false }) });
          return true;
        }
        const result = await (await getProvider(config)).session(sessionData);
        if (result.authenticated === true) {
          const user = publicUser(result.user);
          const refusal = accessRefusal(config.accessList, { authenticated: true, email: user.email });
          if (result.sealedSession) setCookie(response, config, config.sessionCookie, result.sealedSession, SESSION_SECONDS);
          json(response, 200, { configured: true, authenticated: true, approved: !refusal, user, ...(refusal ? { message: refusal } : {}) });
        } else if (result.authenticated === false) {
          setCookie(response, config, config.sessionCookie, "", 0);
          json(response, 200, { configured: true, authenticated: false, approved: false, user: null, message: "Your account session ended. Sign in again." });
        } else throw new AuthError("Invalid account session response.", 502);
      } else {
        const sessionData = sessionCookie(request, response, config);
        const logoutUrl = sessionData ? await (await getProvider(config)).logout(sessionData) : null;
        const destination = logoutUrl ? safeProviderUrl(logoutUrl) : `${config.origin}/#/settings`;
        setCookie(response, config, config.sessionCookie, "", 0);
        setCookie(response, config, config.stateCookie, "", 0);
        json(response, 200, { logoutUrl: destination });
      }
    } catch (error) {
      if (!(error instanceof AuthError)) log({ event: "workos_request_failed", stage: action });
      if (!response.headersSent && Number.isFinite(error.retryAfter) && error.retryAfter >= 0) {
        response.setHeader("Retry-After", String(Math.min(3600, Math.ceil(error.retryAfter))));
      }
      if (!response.headersSent) json(response, error instanceof AuthError ? error.status : 502, {
        error: error instanceof AuthError ? error.message : "Account service unavailable. Try again.",
      });
      else response.destroy();
    }
    return true;
  };

  /**
   * Decide whether a request carries an approved account. When a response is
   * supplied, persist a rotated session in its HttpOnly cookie. Deployments
   * without WorkOS have no identities to check, so they report `gated: false` and the local-only workspace stays open. Everything
   * else must present a signed-in account on the approved list.
   */
  handler.authorize = async (request, response) => {
    const config = configuration(env);
    if (!config) return { gated: false, authenticated: false, approved: false, refusal: "" };
    let sealed = null;
    try { sealed = cookie(request, config.sessionCookie); } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    let user = null;
    if (sealed) {
      const result = await (await getProvider(config)).session(sealed);
      if (result.authenticated === true) {
        user = publicUser(result.user);
        if (response && result.sealedSession) setCookie(response, config, config.sessionCookie, result.sealedSession, SESSION_SECONDS);
      }
      else if (result.authenticated !== false) throw new AuthError("Invalid account session response.", 502);
    }
    const refusal = accessRefusal(config.accessList, { authenticated: Boolean(user), email: user?.email });
    // `user` rides along so a workspace request can key storage to the account that made it. It is
    // the same profile the session endpoint already returns, never the sealed session itself.
    return { gated: true, authenticated: Boolean(user), approved: !refusal, refusal, user };
  };

  return handler;
}
