import { describe, it, expect, vi } from "vitest";
import { LinearClient } from "../src/linear-client.mjs";

function mockFetch(responseData) {
  return vi.fn().mockResolvedValue({
    json: async () => ({ data: responseData }),
  });
}

describe("LinearClient", () => {
  it("throws without an API key", () => {
    expect(() => new LinearClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("sends the API key as the Authorization header, unprefixed", async () => {
    const fetchImpl = mockFetch({ viewer: { id: "u1", name: "Adam", email: "a@example.test" } });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

    await client.viewer();

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("lin_api_abc");
  });

  it("throws on a GraphQL error response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ errors: [{ message: "not authorized" }] }),
    });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

    await expect(client.viewer()).rejects.toThrow(/not authorized/);
  });

  it("derives blockedByIds from inverseRelations.issue, not relations or self (MOV-128)", async () => {
    // Real MOV-125 -> MOV-126 -> MOV-127 shape, verified live: in MOV-126's
    // inverseRelations, a "blocks" entry has `issue` = the blocker (MOV-125)
    // and `relatedIssue` = MOV-126 itself. MOV-126 blocking MOV-127 shows up
    // under MOV-126's own `relations` (a dependent, not a blocker).
    const fetchImpl = mockFetch({
      issues: {
        nodes: [
          {
            id: "id-126",
            identifier: "MOV-126",
            title: "Do the thing",
            description: "Full description text.",
            url: "https://linear.app/moviecal/issue/MOV-126",
            project: { name: "Calendar Feed" },
            labels: { nodes: [{ name: "area:calendar" }, { name: "worker:codex" }] },
            relations: {
              nodes: [
                { type: "blocks", relatedIssue: { id: "id-127", state: { name: "Backlog" } } },
                { type: "related", relatedIssue: { id: "id-9", state: { name: "Backlog" } } },
              ],
            },
            inverseRelations: {
              nodes: [
                { type: "blocks", issue: { id: "id-125", state: { name: "In Review" } }, relatedIssue: { id: "id-126" } },
                { type: "related", issue: { id: "id-9", state: { name: "Backlog" } }, relatedIssue: { id: "id-126" } },
              ],
            },
          },
        ],
      },
    });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

    const issues = await client.issuesInState({ teamKey: "MOV", stateName: "Ready for Agent" });

    expect(issues).toEqual([
      {
        id: "id-126",
        identifier: "MOV-126",
        title: "Do the thing",
        description: "Full description text.",
        url: "https://linear.app/moviecal/issue/MOV-126",
        project: "Calendar Feed",
        labels: ["area:calendar", "worker:codex"],
        blockedByIds: ["id-125"],
        inverseRelations: [
          { type: "blocks", issue: { id: "id-125", state: { name: "In Review" } }, relatedIssue: { id: "id-126" } },
          { type: "related", issue: { id: "id-9", state: { name: "Backlog" } }, relatedIssue: { id: "id-126" } },
        ],
        relations: [
          { type: "blocks", relatedIssue: { id: "id-127", state: { name: "Backlog" } } },
          { type: "related", relatedIssue: { id: "id-9", state: { name: "Backlog" } } },
        ],
      },
    ]);
  });

  it("sends the inverseRelations selection alongside relations", async () => {
    const fetchImpl = mockFetch({ issues: { nodes: [] } });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

    await client.issuesInState({ teamKey: "MOV", stateName: "Ready for Agent" });

    const [, init] = fetchImpl.mock.calls[0];
    const { query } = JSON.parse(init.body);
    expect(query).toMatch(/inverseRelations\s*\{\s*nodes\s*\{/);
  });

  it("handles a null project without throwing", async () => {
    const fetchImpl = mockFetch({
      issues: {
        nodes: [
          {
            id: "id-1",
            identifier: "MOV-1",
            title: "No project",
            url: "https://linear.app/moviecal/issue/MOV-1",
            project: null,
            labels: { nodes: [] },
            relations: { nodes: [] },
          },
        ],
      },
    });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });
    const [issue] = await client.issuesInState({ teamKey: "MOV", stateName: "Ready for Agent" });
    expect(issue.project).toBeNull();
    expect(issue.blockedByIds).toEqual([]);
  });

  it("issuesForPromotion adds stateName + recentComments and filters by a state list (MOV-129)", async () => {
    const fetchImpl = mockFetch({
      issues: {
        nodes: [
          {
            id: "id-900",
            identifier: "MOV-900",
            title: "Ready-ish",
            description: "## Acceptance criteria\n- x\n## Testing Expectations\n- unit",
            url: "https://linear.app/moviecal/issue/MOV-900",
            state: { name: "Blocked" },
            project: null,
            labels: { nodes: [{ name: "type:fix" }] },
            relations: { nodes: [] },
            inverseRelations: {
              nodes: [{ type: "blocks", issue: { id: "id-800", state: { name: "Done" } }, relatedIssue: { id: "id-900" } }],
            },
            comments: { nodes: [{ body: "first" }, { body: "**Dispatcher preflight failed:** blocked by unresolved relation(s): id-800" }] },
          },
        ],
      },
    });
    const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

    const [issue] = await client.issuesForPromotion({ teamKey: "MOV", stateNames: ["Backlog", "Blocked"] });

    expect(issue.stateName).toBe("Blocked");
    expect(issue.blockedByIds).toEqual(["id-800"]);
    expect(issue.recentComments).toEqual([
      "first",
      "**Dispatcher preflight failed:** blocked by unresolved relation(s): id-800",
    ]);

    const [, init] = fetchImpl.mock.calls[0];
    const { query, variables } = JSON.parse(init.body);
    expect(query).toMatch(/state:\s*\{\s*name:\s*\{\s*in:\s*\$stateNames\s*\}\s*\}/);
    expect(variables.stateNames).toEqual(["Backlog", "Blocked"]);
  });

  describe("addBlocksRelation", () => {
    it("maps blockerId -> issueId and blockedId -> relatedIssueId, with type sent as a variable", async () => {
      const fetchImpl = mockFetch({ issueRelationCreate: { success: true } });
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

      await client.addBlocksRelation({ blockerId: "blocker-1", blockedId: "blocked-2" });

      const [, init] = fetchImpl.mock.calls[0];
      const { query, variables } = JSON.parse(init.body);
      // The blocker is the source of the "blocks" relation; the blocked issue
      // is its target. Reversing these is the bug this test exists to catch.
      expect(variables).toEqual({ issueId: "blocker-1", relatedIssueId: "blocked-2", type: "blocks" });
      // `type` must be declared as a typed GraphQL variable, not inlined as a
      // quoted string literal -- Linear's schema rejects `type: "blocks"`
      // because IssueRelationType is an enum, and GraphQL only accepts enum
      // literals or typed variables for enum-typed input fields.
      expect(query).toMatch(/\$type:\s*IssueRelationType!/);
      expect(query).toMatch(/type:\s*\$type/);
      expect(query).not.toMatch(/type:\s*"blocks"/);
    });

    it("declares issueId and relatedIssueId as typed String! variables used in the input object", async () => {
      const fetchImpl = mockFetch({ issueRelationCreate: { success: true } });
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

      await client.addBlocksRelation({ blockerId: "blocker-1", blockedId: "blocked-2" });

      const [, init] = fetchImpl.mock.calls[0];
      const { query } = JSON.parse(init.body);
      expect(query).toMatch(/\$issueId:\s*String!/);
      expect(query).toMatch(/\$relatedIssueId:\s*String!/);
      expect(query).toMatch(/issueId:\s*\$issueId/);
      expect(query).toMatch(/relatedIssueId:\s*\$relatedIssueId/);
    });

    it("rejects missing IDs and self-blocking", async () => {
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl: mockFetch({}) });
      await expect(client.addBlocksRelation({ blockerId: "a" })).rejects.toThrow(/blockedId/);
      await expect(
        client.addBlocksRelation({ blockerId: "a", blockedId: "a" }),
      ).rejects.toThrow(/cannot block itself/);
    });
  });

  describe("linkBlockingChain", () => {
    it("creates each-blocks-the-next relations in order", async () => {
      const fetchImpl = mockFetch({ issueRelationCreate: { success: true } });
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

      const created = await client.linkBlockingChain(["i1", "i2", "i3", "i4"]);

      expect(created).toBe(3);
      const pairs = fetchImpl.mock.calls.map(([, init]) => {
        const { variables } = JSON.parse(init.body);
        return [variables.issueId, variables.relatedIssueId];
      });
      expect(pairs).toEqual([
        ["i1", "i2"],
        ["i2", "i3"],
        ["i3", "i4"],
      ]);
    });

    it("requires at least two IDs", async () => {
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl: mockFetch({}) });
      await expect(client.linkBlockingChain(["only-one"])).rejects.toThrow(/at least two/);
    });
  });

  describe("app-actor auth (Client Credentials, MOV-125)", () => {
    const appAuth = { clientId: "cid", clientSecret: "csecret", scopes: "read,write" };

    function fetchOk(status, responseData) {
      return { status, json: async () => ({ data: responseData }) };
    }

    it("throws without an apiKey or appAuth", () => {
      expect(() => new LinearClient({})).toThrow(/apiKey or appAuth/);
      expect(() => new LinearClient({ appAuth: { clientId: "cid" } })).toThrow(/apiKey or appAuth/);
    });

    it("mints a token lazily on the first request and sends it as Bearer", async () => {
      const getAppTokenFn = vi.fn().mockResolvedValue({ token: "tok1", tokenType: "Bearer", expiresAt: new Date() });
      const fetchImpl = vi.fn().mockResolvedValue(fetchOk(200, { viewer: { id: "app-1" } }));
      const client = new LinearClient({ appAuth, fetchImpl, getAppTokenFn });

      await client.viewer();

      expect(getAppTokenFn).toHaveBeenCalledTimes(1);
      expect(getAppTokenFn).toHaveBeenCalledWith(
        { clientId: "cid", clientSecret: "csecret", scopes: "read,write" },
        { fetchImpl },
      );
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer tok1");
    });

    it("caches the token across subsequent requests", async () => {
      const getAppTokenFn = vi.fn().mockResolvedValue({ token: "tok1", tokenType: "Bearer", expiresAt: new Date() });
      const fetchImpl = vi.fn().mockResolvedValue(fetchOk(200, { viewer: { id: "app-1" } }));
      const client = new LinearClient({ appAuth, fetchImpl, getAppTokenFn });

      await client.viewer();
      await client.viewer();

      expect(getAppTokenFn).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("re-acquires exactly once on a 401 and retries the request", async () => {
      const getAppTokenFn = vi
        .fn()
        .mockResolvedValueOnce({ token: "expired", tokenType: "Bearer", expiresAt: new Date() })
        .mockResolvedValueOnce({ token: "fresh", tokenType: "Bearer", expiresAt: new Date() });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fetchOk(401, {}))
        .mockResolvedValueOnce(fetchOk(200, { viewer: { id: "app-1" } }));
      const client = new LinearClient({ appAuth, fetchImpl, getAppTokenFn });

      const viewer = await client.viewer();

      expect(viewer).toEqual({ id: "app-1" });
      expect(getAppTokenFn).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer expired");
      expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    });

    it("does not retry a second time if the retried request is also a 401", async () => {
      const getAppTokenFn = vi.fn().mockResolvedValue({ token: "tok", tokenType: "Bearer", expiresAt: new Date() });
      const fetchImpl = vi.fn().mockResolvedValue(fetchOk(401, {}));
      const client = new LinearClient({ appAuth, fetchImpl, getAppTokenFn });

      await client.request("query {}");
      expect(getAppTokenFn).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("apiKey wins over appAuth when both are supplied (personal-key path unchanged)", async () => {
      const getAppTokenFn = vi.fn();
      const fetchImpl = mockFetch({ viewer: { id: "u1" } });
      const client = new LinearClient({ apiKey: "lin_api_abc", appAuth, fetchImpl, getAppTokenFn });

      await client.viewer();

      expect(getAppTokenFn).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("lin_api_abc");
    });
  });
});
