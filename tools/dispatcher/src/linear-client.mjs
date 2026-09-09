// Minimal Linear GraphQL client.
//
// Uses Node's built-in fetch (available since Node 18, and this repo
// targets Node 24) — no SDK dependency needed for the calls the dispatcher
// makes. See docs/governance/linear-information-architecture.md for the
// workspace shape this queries against.

const LINEAR_API_URL = "https://api.linear.app/graphql";

export class LinearClient {
  constructor({ apiKey, fetchImpl = fetch, apiUrl = LINEAR_API_URL } = {}) {
    if (!apiKey) throw new Error("LinearClient requires an apiKey");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl;
  }

  async request(query, variables = {}) {
    const res = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data;
  }

  async viewer() {
    const data = await this.request(`query { viewer { id name email } }`);
    return data.viewer;
  }

  /**
   * Issues in a given workflow state name, for a given team, delegated to
   * this dispatcher (by convention: assigned to the account whose API key
   * this is, or carrying a specific "delegate" label — the exact delegation
   * signal depends on which Linear delegation surface is available; see
   * docs/operators/local-execution.md's "assumptions I could not verify").
   */
  async issuesInState({ teamKey, stateName }) {
    const query = `
      query($teamKey: String!, $stateName: String!) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { eq: $stateName } }
        }) {
          nodes {
            id
            identifier
            title
            description
            url
            project { name }
            labels { nodes { name } }
            relations { nodes {
              type
              relatedIssue { id state { name } }
            } }
          }
        }
      }
    `;
    const data = await this.request(query, { teamKey, stateName });
    return data.issues.nodes.map(normalizeIssue);
  }

  async addComment(issueId, body) {
    const mutation = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }
    `;
    const data = await this.request(mutation, { issueId, body });
    return data.commentCreate.success;
  }

  async moveToState(issueId, stateId) {
    const mutation = `
      mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }
    `;
    const data = await this.request(mutation, { issueId, stateId });
    return data.issueUpdate.success;
  }

  /**
   * Create a "blocks" dependency: `blockerId` blocks `blockedId`
   * (i.e. `blockedId` cannot start until `blockerId` is done).
   *
   * Direction matters and is easy to invert. Linear's `issueRelationCreate`
   * treats `input.issueId` as the SOURCE of the named relation and
   * `input.relatedIssueId` as its TARGET, so `type: "blocks"` reads as
   * "issueId blocks relatedIssueId". This helper takes role-named arguments
   * (`blockerId` / `blockedId`) precisely so callers never have to remember
   * which raw field is which — passing a bare `{ issueId, relatedIssueId }`
   * pair by hand has produced a reversed chain more than once.
   */
  async addBlocksRelation({ blockerId, blockedId }) {
    if (!blockerId || !blockedId) {
      throw new Error("addBlocksRelation requires blockerId and blockedId");
    }
    if (blockerId === blockedId) {
      throw new Error("addBlocksRelation: an issue cannot block itself");
    }
    const mutation = `
      mutation($issueId: String!, $relatedIssueId: String!) {
        issueRelationCreate(input: {
          issueId: $issueId
          relatedIssueId: $relatedIssueId
          type: "blocks"
        }) { success }
      }
    `;
    const data = await this.request(mutation, {
      issueId: blockerId,
      relatedIssueId: blockedId,
    });
    return data.issueRelationCreate.success;
  }

  /**
   * Wire an ordered list of issue IDs into a linear dependency chain: each
   * entry blocks the next, so `orderedIssueIds[0]` is the only unblocked
   * issue and the last entry is blocked by everything before it.
   * Returns the number of relations created.
   */
  async linkBlockingChain(orderedIssueIds) {
    if (!Array.isArray(orderedIssueIds) || orderedIssueIds.length < 2) {
      throw new Error("linkBlockingChain requires at least two issue IDs");
    }
    let created = 0;
    for (let i = 0; i < orderedIssueIds.length - 1; i++) {
      await this.addBlocksRelation({
        blockerId: orderedIssueIds[i],
        blockedId: orderedIssueIds[i + 1],
      });
      created++;
    }
    return created;
  }

  async workflowStates(teamKey) {
    const query = `
      query($teamKey: String!) {
        workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
          nodes { id name type }
        }
      }
    `;
    const data = await this.request(query, { teamKey });
    return data.workflowStates.nodes;
  }
}

function normalizeIssue(node) {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description || "",
    url: node.url,
    project: node.project ? node.project.name : null,
    labels: node.labels.nodes.map((l) => l.name),
    blockedByIds: node.relations.nodes
      .filter((r) => r.type === "blocks" && r.relatedIssue)
      .map((r) => r.relatedIssue.id),
    // exposed for isIssueSatisfied() callers that want the related issue's state
    relations: node.relations.nodes,
  };
}
