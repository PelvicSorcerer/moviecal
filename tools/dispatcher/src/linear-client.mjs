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
