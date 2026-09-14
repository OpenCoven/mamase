import { WorkOS } from "@workos-inc/node";

export function createWorkOSProvider(config, client = new WorkOS(config.apiKey, {
  clientId: config.clientId, timeout: 10000, maxRetries: 0,
})) {
  const management = client.userManagement;
  const resolveSession = async (sessionData) => {
    if (!sessionData) return { authenticated: false };
    const session = management.loadSealedSession({ sessionData, cookiePassword: config.cookiePassword });
    const result = await session.authenticate();
    if (result.authenticated === true) return result;
    if (["no_session_cookie_provided", "invalid_session_cookie"].includes(result.reason)) return { authenticated: false };
    if (result.reason !== "invalid_jwt") throw new Error("Unexpected WorkOS authentication result.");
    const refreshed = await session.refresh();
    if (refreshed.authenticated === true) {
      if (!refreshed.sealedSession) throw new Error("WorkOS did not return a refreshed sealed session.");
      const authenticated = await session.authenticate();
      if (!authenticated.authenticated) throw new Error("The refreshed WorkOS session could not be authenticated.");
      return { ...authenticated, sealedSession: refreshed.sealedSession };
    }
    if (refreshed.retryable === true) {
      const error = new Error("WorkOS is temporarily unavailable.");
      if (Number.isFinite(refreshed.retryAfter)) error.retryAfter = refreshed.retryAfter;
      throw error;
    }
    if (refreshed.retryable === false && ["no_session_cookie_provided", "invalid_session_cookie", "invalid_grant", "mfa_enrollment", "sso_required"].includes(refreshed.reason)) {
      return { authenticated: false };
    }
    throw new Error("Unexpected WorkOS refresh result.");
  };
  return {
    authorizationUrl: ({ state, codeChallenge }) => management.getAuthorizationUrl({
      provider: "authkit", clientId: config.clientId, redirectUri: config.redirectUri,
      state, codeChallenge, codeChallengeMethod: "S256",
    }),
    exchange: async ({ code, codeVerifier }) => {
      const result = await management.authenticateWithCode({
        clientId: config.clientId, code, codeVerifier,
        session: { sealSession: true, cookiePassword: config.cookiePassword },
      });
      if (!result.sealedSession) throw new Error("WorkOS did not return a sealed session.");
      return { sealedSession: result.sealedSession };
    },
    session: async (sessionData) => {
      const result = await resolveSession(sessionData);
      return result.authenticated
        ? { authenticated: true, user: result.user, ...(result.sealedSession ? { sealedSession: result.sealedSession } : {}) }
        : { authenticated: false };
    },
    logout: async (sessionData) => {
      const result = await resolveSession(sessionData);
      if (!result.authenticated) return null;
      if (!result.sessionId) throw new Error("WorkOS did not return a session ID.");
      return management.getLogoutUrl({ sessionId: result.sessionId, returnTo: `${config.origin}/` });
    },
  };
}
