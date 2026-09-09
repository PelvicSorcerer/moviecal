// Linear app-actor authentication (OAuth2 Client Credentials grant).
//
// Lets the dispatcher authenticate as its own workspace identity
// (`moviecal-dispatcher`) instead of the repo owner's personal API key, so
// Linear notifications actually fire for the repo owner on dispatcher-driven
// activity. See MOV-122 and
// docs/planning/mov-122-linear-actor-authorization-plan.md.
//
// Client Credentials tokens are valid ~30 days and carry no refresh token; the
// caller re-mints on a 401. Nothing here is persisted — only the client id /
// secret live on disk (~/.config/moviecal/linear-app.env, mode 600).

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/** Scope string confirmed live 2026-09-08 (MOV-123). `read`+`write` are the
 * data-access scopes and are mandatory; the `app:*` entries are agent-capability
 * flags. An app-actor token requested without `read` is rejected outright. */
export const DEFAULT_APP_SCOPES = "read,write,app:assignable,app:mentionable";

/**
 * Mint a Linear app-actor access token via the Client Credentials grant.
 * Returns `{ token, tokenType, expiresAt }` where `expiresAt` is a `Date`.
 * Throws on a non-2xx response or a body without an access token.
 *
 * @param {{clientId: string, clientSecret: string, scopes?: string}} creds
 * @param {{fetchImpl?: typeof fetch, tokenUrl?: string, now?: () => number}} [opts]
 */
export async function getAppToken(
  { clientId, clientSecret, scopes = DEFAULT_APP_SCOPES } = {},
  { fetchImpl = fetch, tokenUrl = LINEAR_TOKEN_URL, now = Date.now } = {},
) {
  if (!clientId || !clientSecret) {
    throw new Error("getAppToken requires clientId and clientSecret");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    actor: "app",
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes || DEFAULT_APP_SCOPES,
  });
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Linear token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok || !parsed.access_token) {
    const detail = parsed.error_description || parsed.error || text.slice(0, 200);
    throw new Error(`Linear token request failed (HTTP ${res.status}): ${detail}`);
  }
  const expiresInMs = Number(parsed.expires_in || 0) * 1000;
  return {
    token: parsed.access_token,
    tokenType: parsed.token_type || "Bearer",
    expiresAt: new Date(now() + expiresInMs),
  };
}
