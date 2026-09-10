// Minimal Linear GraphQL client.
//
// Uses Node's built-in fetch (available since Node 18, and this repo
// targets Node 24) — no SDK dependency needed for the calls the dispatcher
// makes. See docs/governance/linear-information-architecture.md for the
// workspace shape this queries against.

import { getAppToken } from "./linear-app-auth.mjs";
import { normalizeDelegate } from "./dispatch-eligibility.mjs";

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * The issue selection every dispatcher query shares. Kept in one place so the
 * batch queries and the single-issue re-read (`issueSnapshot`) can never drift
 * apart — a snapshot missing a field the batch has would silently change a
 * dispatch decision at exactly the moment it matters most.
 *
 * `delegate` (MOV-143) is Linear's agent-delegation field: the actor an issue
 * is handed to. It is `null` for the ordinary undelegated case.
 */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  project { name }
  delegate { id name displayName }
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
`;

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
   * Every issue in a given workflow state name, for a given team. This is a
   * plain state query and is deliberately **not** filtered by delegation:
   * `delegate` is selected and normalized so the dispatcher can apply the
   * MOV-143 route + delegate gate itself (`dispatch-eligibility.mjs`), and see
   * — in `dispatcher dry-run` — exactly which queued issues it is declining
   * and why. Filtering server-side would make an issue it should have claimed
   * indistinguishable from one that does not exist.
   */
  async issuesInState({ teamKey, stateName }) {
    const query = `
      query($teamKey: String!, $stateName: String!) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { eq: $stateName } }
        }) {
          nodes {
            ${ISSUE_FIELDS}
          }
        }
      }
    `;
    const data = await this.request(query, { teamKey, stateName });
    return data.issues.nodes.map(normalizeIssue);
  }

  /**
   * Re-read a single issue by id, with its current workflow state (MOV-143).
   * Used immediately before the dispatcher commits to an issue, so a route or
   * delegation change made after the poll snapshot is seen and honoured rather
   * than raced past. Returns `null` when the issue is gone or not visible to
   * this credential — which the caller treats as "do not claim", never as
   * "unchanged".
   */
  async issueSnapshot(issueId) {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          state { name }
        }
      }
    `;
    const data = await this.request(query, { id: issueId });
    const node = data && data.issue;
    if (!node) return null;
    return { ...normalizeIssue(node), stateName: node.state ? node.state.name : null };
  }

  /**
   * Issues in any of `stateNames`, with the extra fields the automated
   * promoter needs (MOV-129): the issue's own `state.name`, and recent
   * comment bodies (to read back the dispatcher's last preflight-failure
   * reason). Same normalization as issuesInState, plus `stateName` and
   * `recentComments` (oldest-to-newest).
   */
  async issuesForPromotion({ teamKey, stateNames }) {
    const query = `
      query($teamKey: String!, $stateNames: [String!]!) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $stateNames } }
        }) {
          nodes {
            ${ISSUE_FIELDS}
            state { name }
            comments(last: 20) { nodes { body } }
          }
        }
      }
    `;
    const data = await this.request(query, { teamKey, stateNames });
    return data.issues.nodes.map((node) => ({
      ...normalizeIssue(node),
      stateName: node.state ? node.state.name : null,
      recentComments: (node.comments ? node.comments.nodes : []).map((c) => c.body),
    }));
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

  async issueComments(issueId) {
    const query = `
      query($issueId: String!) {
        issue(id: $issueId) { comments(last: 20) { nodes { body } } }
      }
    `;
    const data = await this.request(query, { issueId });
    return (data.issue?.comments?.nodes || []).map((comment) => comment.body);
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
      mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationCreate(input: {
          issueId: $issueId
          relatedIssueId: $relatedIssueId
          type: $type
        }) { success }
      }
    `;
    const data = await this.request(mutation, {
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
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

  /**
   * Open an Agent Session on an issue under this app's own identity (MOV-158).
   *
   * **Developer Preview, and unverified against this workspace.** MOV-141's
   * live probe got `agent sessions disabled` back from this exact mutation, so
   * the document below is transcribed from Linear's published preview docs and
   * has never returned a session here. It is deliberately the only place that
   * shape is written down, and every caller
   * (`agent-session.mjs`'s `AgentSessionBridge`) treats a failure as
   * "sessions are unavailable, keep using comments" rather than as an error on
   * the issue. See docs/governance/mov-141-linear-capability-findings.md.
   */
  async createAgentSessionOnIssue({ issueId }) {
    if (!issueId) throw new Error("createAgentSessionOnIssue requires an issueId");
    const mutation = `
      mutation($issueId: String!) {
        agentSessionCreateOnIssue(input: { issueId: $issueId }) {
          success
          agentSession { id status }
        }
      }
    `;
    const data = await this.request(mutation, { issueId });
    const session = data && data.agentSessionCreateOnIssue && data.agentSessionCreateOnIssue.agentSession;
    if (!session || !session.id) throw new Error("agentSessionCreateOnIssue returned no agent session");
    return { id: session.id, status: session.status || null };
  }

  /**
   * Emit one semantic Agent Activity. `content` is the serialized shape from
   * `agent-session.mjs`'s `activityFor()` — a thought, action, elicitation,
   * response, or error. Linear derives the session's status from the activity
   * type, which is why the dispatcher never sets status separately.
   */
  async createAgentActivity({ agentSessionId, content }) {
    if (!agentSessionId) throw new Error("createAgentActivity requires an agentSessionId");
    if (!content || typeof content !== "object") throw new Error("createAgentActivity requires a content object");
    const mutation = `
      mutation($agentSessionId: String!, $content: AgentActivityContentInput!) {
        agentActivityCreate(input: { agentSessionId: $agentSessionId, content: $content }) {
          success
          agentActivity { id }
        }
      }
    `;
    const data = await this.request(mutation, { agentSessionId, content });
    return Boolean(data && data.agentActivityCreate && data.agentActivityCreate.success);
  }

  /**
   * Point the session's external URL at the PR it produced, so the issue shows
   * the PR link without anyone reading a local run log.
   *
   * Same preview caveat as above — and this one is why `activityFor()` also
   * puts the PR URL in the activity body: if this field name is wrong, the
   * link still renders, and the failure is logged rather than fatal.
   */
  async updateAgentSessionExternalLink(agentSessionId, externalUrl) {
    if (!agentSessionId) throw new Error("updateAgentSessionExternalLink requires an agentSessionId");
    if (!externalUrl) throw new Error("updateAgentSessionExternalLink requires an externalUrl");
    const mutation = `
      mutation($id: String!, $externalUrl: String!) {
        agentSessionUpdate(id: $id, input: { externalUrl: $externalUrl }) { success }
      }
    `;
    const data = await this.request(mutation, { id: agentSessionId, externalUrl });
    return Boolean(data && data.agentSessionUpdate && data.agentSessionUpdate.success);
  }

  /**
   * Read a session back, so a later attempt can tell "still live" from
   * "finished, open a new linked one". Returns `null` when the session is gone
   * or Agent Sessions are not readable by this credential — which callers
   * treat the same as "no prior session".
   */
  async agentSession(agentSessionId) {
    if (!agentSessionId) return null;
    const query = `
      query($id: String!) {
        agentSession(id: $id) { id status updatedAt }
      }
    `;
    const data = await this.request(query, { id: agentSessionId });
    const node = data && data.agentSession;
    if (!node) return null;
    return { id: node.id, status: node.status || null, lastActivityAt: node.updatedAt || null };
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
    // MOV-143: the actor this issue is delegated to, or null. Normalized here
    // (rather than at each decision site) so every consumer sees one shape.
    delegate: normalizeDelegate(node.delegate),
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
