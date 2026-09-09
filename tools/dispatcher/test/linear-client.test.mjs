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

  it("normalizes issuesInState results, including blocking relations", async () => {
    const fetchImpl = mockFetch({
      issues: {
        nodes: [
          {
            id: "id-1",
            identifier: "MOV-1",
            title: "Do the thing",
            description: "Full description text.",
            url: "https://linear.app/moviecal/issue/MOV-1",
            project: { name: "Calendar Feed" },
            labels: { nodes: [{ name: "area:calendar" }, { name: "worker:codex" }] },
            relations: {
              nodes: [
                { type: "blocks", relatedIssue: { id: "id-0", state: { name: "Done" } } },
                { type: "related", relatedIssue: { id: "id-9", state: { name: "Backlog" } } },
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
        id: "id-1",
        identifier: "MOV-1",
        title: "Do the thing",
        description: "Full description text.",
        url: "https://linear.app/moviecal/issue/MOV-1",
        project: "Calendar Feed",
        labels: ["area:calendar", "worker:codex"],
        blockedByIds: ["id-0"],
        relations: [
          { type: "blocks", relatedIssue: { id: "id-0", state: { name: "Done" } } },
          { type: "related", relatedIssue: { id: "id-9", state: { name: "Backlog" } } },
        ],
      },
    ]);
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

  describe("addBlocksRelation", () => {
    it("maps blockerId -> issueId and blockedId -> relatedIssueId", async () => {
      const fetchImpl = mockFetch({ issueRelationCreate: { success: true } });
      const client = new LinearClient({ apiKey: "lin_api_abc", fetchImpl });

      await client.addBlocksRelation({ blockerId: "blocker-1", blockedId: "blocked-2" });

      const [, init] = fetchImpl.mock.calls[0];
      const { query, variables } = JSON.parse(init.body);
      // The blocker is the source of the "blocks" relation; the blocked issue
      // is its target. Reversing these is the bug this test exists to catch.
      expect(variables).toEqual({ issueId: "blocker-1", relatedIssueId: "blocked-2" });
      expect(query).toMatch(/type:\s*"blocks"/);
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
});
