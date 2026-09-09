import { describe, it, expect, vi } from "vitest";
import { getAppToken, DEFAULT_APP_SCOPES } from "../src/linear-app-auth.mjs";

function okResponse(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}

describe("getAppToken", () => {
  it("posts the client-credentials grant and returns a token with a computed expiry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        access_token: "lin_oauth_abc",
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "read write app:assignable app:mentionable",
      }),
    );

    const result = await getAppToken(
      { clientId: "cid", clientSecret: "csecret" },
      { fetchImpl, now: () => 1_000_000 },
    );

    expect(result).toEqual({
      token: "lin_oauth_abc",
      tokenType: "Bearer",
      expiresAt: new Date(1_000_000 + 2_592_000 * 1000),
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.linear.app/oauth/token");
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(body).toEqual({
      grant_type: "client_credentials",
      actor: "app",
      client_id: "cid",
      client_secret: "csecret",
      scope: DEFAULT_APP_SCOPES,
    });
  });

  it("passes an explicit scope string through", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ access_token: "t", expires_in: 10 }),
    );
    await getAppToken(
      { clientId: "cid", clientSecret: "csecret", scopes: "read" },
      { fetchImpl },
    );
    const body = Object.fromEntries(new URLSearchParams(fetchImpl.mock.calls[0][1].body));
    expect(body.scope).toBe("read");
  });

  it("throws without client id or secret", async () => {
    await expect(getAppToken({ clientId: "cid" })).rejects.toThrow(/clientId and clientSecret/);
    await expect(getAppToken({ clientSecret: "s" })).rejects.toThrow(/clientId and clientSecret/);
  });

  it("throws with the endpoint's error detail on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "invalid_client", error_description: "bad secret" }),
    });
    await expect(
      getAppToken({ clientId: "cid", clientSecret: "wrong" }, { fetchImpl }),
    ).rejects.toThrow(/HTTP 401.*bad secret/);
  });

  it("throws when the response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>gateway timeout</html>",
    });
    await expect(
      getAppToken({ clientId: "cid", clientSecret: "csecret" }, { fetchImpl }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws on a 200 body that omits access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ token_type: "Bearer" }));
    await expect(
      getAppToken({ clientId: "cid", clientSecret: "csecret" }, { fetchImpl }),
    ).rejects.toThrow(/token request failed/);
  });
});
