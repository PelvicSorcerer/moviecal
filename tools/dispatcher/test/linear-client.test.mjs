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
});
