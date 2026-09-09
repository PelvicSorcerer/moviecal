// Minimal Linear GraphQL client.
//
// Uses Node's built-in fetch (available since Node 18, and this repo
// targets Node 24) — no SDK dependency needed for the calls the dispatcher
// makes. See docs/governance/linear-information-architecture.md for the
// workspace shape this queries against.

import { getAppToken } from "./linear-app-auth.mjs";

const LINEAR_API_URL = "https://api.linear.app/graphql";

export class LinearClient {
  /**
   * Either a personal `apiKey` (sent as-is, unprefixed — current/default
   * behaviour) or `appAuth: {clientId, clientSecret, scopes}` (Client
   * Credentials, MOV-122/125): a token is minted lazily on the first
   * `request()`, cached in memory for the life of this client, and re-minted
   * exactly once and the request retried if a request comes back `401`.
   * `apiKey` wins if both are supplied. `getAppTokenFn` is injectable for
   * tests; defaults to the real token-minting call.
   */
  constructor({ apiKey, appAuth, fetchImpl = fetch, apiUrl = LINEAR_API_URL, getAppTokenFn = getAppToken } = {}) {
    const hasAppAuth = Boolean(appAuth && appAuth.clientId && appAuth.clientSecret);
    if (!apiKey && !hasAppAuth) {
      throw new Error("LinearClient requires an apiKey or appAuth {clientId, clientSecret}");
    }
    this.apiKey = apiKey || null;
    this.appAuth = this.apiKey ? null : appAuth;
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl;
    this.getAppTokenFn = getAppTokenFn;
    this._appToken = null;
  }

  async _acquireAppToken() {
    const { token, tokenType } = await this.getAppTokenFn(
      {
        clientId: this.appAuth.clientId,
        clientSecret: this.appAuth.clientSecret,
        scopes: this.appAuth.scopes,
      },
      { fetchImpl: this.fetchImpl },
    );
    this._appToken = `${tokenType} ${token}`;
    return this._appToken;
  }

  async _authHeader() {
    if (this.apiKey) return this.apiKey;
    return this._appToken || this._acquireAppToken();
  }

  async request(query, variables = {}) {
    return this._requestWithRetry(query, variables, false);
  }

  async _requestWithRetry(query, variables, hasRetried) {
    const authHeader = await this._authHeader();
    const res = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && this.appAuth && !hasRetried) {
      await this._acquireAppToken();
      return this._requestWithRetry(query, variables, true);
    }
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
            inverseRelations { nodes {
              type
              issue { id state { name } }
              relatedIssue { id }
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
  const inverseRelations = node.inverseRelations ? node.inverseRelations.nodes : [];
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description || "",
    url: node.url,
    project: node.project ? node.project.name : null,
    labels: node.labels.nodes.map((l) => l.name),
    // A "blocks" entry under this issue's own `relations` means THIS issue
    // blocks the related one (a dependent) -- the inverse of what "blocked
    // by" means. Real blockers show up under `inverseRelations`: for a
    // "blocks" entry there, `issue` is the blocker and `relatedIssue` is
    // THIS issue. Read `issue`, not `relatedIssue` (which is just self). See
    // docs/governance/linear-information-architecture.md §Relations (MOV-128).
    blockedByIds: inverseRelations
      .filter((r) => r.type === "blocks" && r.issue)
      .map((r) => r.issue.id),
    // exposed for isIssueSatisfied() callers that want the blocking issue's state
    inverseRelations,
    // dependents view: issues this one blocks
    relations: node.relations.nodes,
  };
}
