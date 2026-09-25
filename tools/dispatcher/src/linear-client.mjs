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
  assignee { id name displayName }
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

/**
 * The extra selection the issue-completeness contract needs (MOV-303): the
 * project's own status, how many milestones it defines, and which milestone
 * (if any) this issue sits in.
 *
 * Deliberately a separate constant appended only to the queries that consume
 * it (`issuesForPromotion` here; the audit pass's `issuesForSpecAudit` reuses
 * it too — see MOV-308) rather than folded into `ISSUE_FIELDS`. The drift
 * `ISSUE_FIELDS` exists to prevent is between the batch dispatch query and
 * the single-issue re-read that gates the same decision — neither reads any
 * of these fields. Keeping them out of that shared selection also bounds the
 * blast radius: these are the only queries in the dispatcher that traverse a
 * nested project connection per issue.
 */
const ISSUE_SPEC_FIELDS = `
  projectMilestone { name }
  project { state projectMilestones { nodes { id } } }
`;

/**
 * Fold the spec fields into the normalized shape `issue-spec.mjs` expects. An
 * issue with no project has no project status and no milestone count — not a
 * zero-milestone project, which is a different (and compliant) thing.
 */
function withIssueSpecFields(node, normalized) {
  const project = node.project || null;
  return {
    ...normalized,
    projectStatus: project ? project.state || null : null,
    projectMilestoneCount: project ? (project.projectMilestones?.nodes || []).length : 0,
    milestone: node.projectMilestone ? node.projectMilestone.name : null,
  };
}

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
   *
   * @param {boolean} [includeSpecFields] - MOV-303: also select the issue-spec
   *   fields (`ISSUE_SPEC_FIELDS`) and fold them in via `withIssueSpecFields`,
   *   the same as `issuesForPromotion`/`issuesForSpecAudit`. Off by default:
   *   this query backs both the real "Ready for Agent" dispatch batch (which
   *   needs these fields for preflight's issue-completeness gate) and the
   *   "In Review" CI-observation batch (which does not), and the nested
   *   project-milestone traversal these fields add should not be paid by a
   *   caller that has no use for it.
   */
  async issuesInState({ teamKey, stateName, includeSpecFields = false }) {
    const query = `
      query($teamKey: String!, $stateName: String!) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { eq: $stateName } }
        }) {
          nodes {
            ${ISSUE_FIELDS}
            ${includeSpecFields ? ISSUE_SPEC_FIELDS : ""}
          }
        }
      }
    `;
    const data = await this.request(query, { teamKey, stateName });
    return data.issues.nodes.map((node) =>
      includeSpecFields ? withIssueSpecFields(node, normalizeIssue(node)) : normalizeIssue(node),
    );
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
          children { nodes { id identifier state { name } } }
        }
      }
    `;
    const data = await this.request(query, { id: issueId });
    const node = data && data.issue;
    if (!node) return null;
    return {
      ...normalizeIssue(node),
      stateName: node.state ? node.state.name : null,
      children: (node.children?.nodes || []).map((child) => ({
        id: child.id,
        identifier: child.identifier,
        stateName: child.state ? child.state.name : null,
      })),
    };
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
            ${ISSUE_SPEC_FIELDS}
            state { name }
            comments(last: 20) { nodes { body } }
          }
        }
      }
    `;
    const data = await this.request(query, { teamKey, stateNames });
    return data.issues.nodes.map((node) => ({
      ...withIssueSpecFields(node, normalizeIssue(node)),
      stateName: node.state ? node.state.name : null,
      recentComments: (node.comments ? node.comments.nodes : []).map((c) => c.body),
    }));
  }

  /**
   * Every issue the issue-completeness audit pass scans (MOV-308): the same
   * spec fields `issuesForPromotion` reads, plus recent comment bodies so the
   * audit can recognize its own previous comment's fingerprint marker and stay
   * silent when nothing has changed.
   *
   * `stateNames` is resolved by the caller from workflow-state *type*, not
   * from a hardcoded list, so a state added to the workspace later is audited
   * without a code change. Unlike `issuesForPromotion` this one paginates: the
   * promoter reads two states, while this reads every open state in the team
   * and will routinely exceed a single page.
   */
  async issuesForSpecAudit({ teamKey, stateNames }) {
    const query = `
      query($teamKey: String!, $stateNames: [String!]!, $after: String) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $stateNames } }
        }, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ${ISSUE_FIELDS}
            ${ISSUE_SPEC_FIELDS}
            state { name type }
            comments(last: 20) { nodes { body } }
          }
        }
      }
    `;
    const out = [];
    let after = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.request(query, { teamKey, stateNames, after });
      const issues = data.issues || {};
      out.push(
        ...(issues.nodes || []).map((node) => ({
          ...withIssueSpecFields(node, normalizeIssue(node)),
          stateName: node.state ? node.state.name : null,
          stateType: node.state ? node.state.type : null,
          recentComments: (node.comments ? node.comments.nodes : []).map((c) => c.body),
        })),
      );
      if (!issues.pageInfo?.hasNextPage || !issues.pageInfo.endCursor) break;
      after = issues.pageInfo.endCursor;
    }
    return out;
  }

  async issuesForPriorityPropagation({ teamKey, stateNames }) {
    const query = `
      query($teamKey: String!, $stateNames: [String!]!, $after: String) {
        issues(filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $stateNames } }
        }, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ${ISSUE_FIELDS}
            state { name type }
            priority
          }
        }
      }
    `;
    const out = [];
    let after = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.request(query, { teamKey, stateNames, after });
      const issues = data.issues || {};
      const nodes = issues.nodes || [];
      out.push(
        ...nodes.map((node) => ({
          ...normalizeIssue(node),
          stateName: node.state ? node.state.name : null,
          stateType: node.state ? node.state.type : null,
          priority: Number.isInteger(node.priority) ? node.priority : 0,
        })),
      );
      const pageInfo = issues.pageInfo || {};
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
      if (!after) break;
    }
    return out;
  }

  /**
   * Read every parent that has Linear sub-issues, including each child's
   * workflow state. This deliberately has no state filter: completed parents
   * must also be examined for a premature completion (MOV-172).
   */
  async issuesForParentReconciliation({ teamKey }) {
    const query = `
      query($teamKey: String!, $after: String) {
        issues(filter: { team: { key: { eq: $teamKey } } }, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            identifier
            url
            state { name }
            children { nodes { id identifier state { name } } }
          }
        }
      }
    `;
    const out = [];
    let after = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.request(query, { teamKey, after });
      const issues = data.issues || {};
      out.push(
        ...(issues.nodes || [])
          .filter((node) => (node.children?.nodes || []).length > 0)
          .map((node) => ({
            id: node.id,
            identifier: node.identifier,
            url: node.url,
            stateName: node.state ? node.state.name : null,
            children: (node.children.nodes || []).map((child) => ({
              id: child.id,
              identifier: child.identifier,
              stateName: child.state ? child.state.name : null,
            })),
          })),
      );
      if (!issues.pageInfo?.hasNextPage || !issues.pageInfo.endCursor) break;
      after = issues.pageInfo.endCursor;
    }
    return out;
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

  async updateIssuePriority(issueId, priority) {
    const mutation = `
      mutation($issueId: String!, $priority: Int) {
        issueUpdate(id: $issueId, input: { priority: $priority }) { success }
      }
    `;
    const data = await this.request(mutation, { issueId, priority });
    return data.issueUpdate.success;
  }

  /**
   * Assign one issue to a workspace member, reading the resulting assignee
   * back in the same mutation (MOV-359). The promoter must verify the write
   * actually landed before it moves the issue into Ready for Agent — a bare
   * `success: true` does not guarantee the field stuck — so the readback is
   * part of this call rather than a separate round trip a caller could skip.
   */
  async assignIssue(issueId, assigneeId) {
    const mutation = `
      mutation($issueId: String!, $assigneeId: String!) {
        issueUpdate(id: $issueId, input: { assigneeId: $assigneeId }) {
          success
          issue { assignee { id } }
        }
      }
    `;
    const data = await this.request(mutation, { issueId, assigneeId });
    return {
      success: Boolean(data.issueUpdate && data.issueUpdate.success),
      assigneeId: (data.issueUpdate && data.issueUpdate.issue && data.issueUpdate.issue.assignee && data.issueUpdate.issue.assignee.id) || null,
    };
  }

  /**
   * One workspace member by exact email, with enough shape to validate them
   * as a promoter-assignable human owner (MOV-359): whether they are active,
   * an app/bot actor, and which teams they belong to.
   *
   * `app` and `teamMemberships` are unverified against this live workspace —
   * the same caveat as `createAgentSessionOnIssue` below — but unlike that
   * path a failure here is never silently swallowed: `owner-assignment.mjs`
   * treats a thrown request or an unresolved candidate as "do not promote",
   * the fail-closed direction, so a wrong field name blocks a promotion
   * rather than mis-assigning one.
   */
  async workspaceMemberByEmail(email) {
    if (!email) return null;
    const query = `
      query($email: String!) {
        users(filter: { email: { eq: $email } }) {
          nodes {
            id
            name
            displayName
            email
            active
            app
            guest
            teamMemberships { nodes { team { key } } }
          }
        }
      }
    `;
    const data = await this.request(query, { email });
    const node = data.users?.nodes?.[0];
    if (!node) return null;
    return {
      id: node.id,
      name: node.displayName || node.name || null,
      email: node.email || null,
      active: node.active !== false,
      isApp: Boolean(node.app),
      isGuest: Boolean(node.guest),
      teamKeys: (node.teamMemberships?.nodes || []).map((m) => m.team?.key).filter(Boolean),
    };
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
   * Create a related (non-blocking) link between two issues.
   *
   * Used by the master-failure observer (MOV-305) to tie a remediation item
   * to the source issue whose merged change the failed run is attributed to.
   * `related` is deliberately not `blocks`: the source issue is normally
   * already `Done`, and a blocking edge from finished work would corrupt both
   * the promoter's readiness gate and priority propagation.
   */
  async addRelatedRelation({ issueId, relatedIssueId }) {
    if (!issueId || !relatedIssueId) throw new Error("addRelatedRelation requires issueId and relatedIssueId");
    if (issueId === relatedIssueId) throw new Error("addRelatedRelation: an issue cannot relate to itself");
    const mutation = `
      mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationCreate(input: {
          issueId: $issueId
          relatedIssueId: $relatedIssueId
          type: $type
        }) { success }
      }
    `;
    const data = await this.request(mutation, { issueId, relatedIssueId, type: "related" });
    return data.issueRelationCreate.success;
  }

  /** The team's own id, needed by every create mutation. */
  async teamId(teamKey) {
    const query = `
      query($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }) { nodes { id key } }
      }
    `;
    const data = await this.request(query, { teamKey });
    return data.teams?.nodes?.[0]?.id || null;
  }

  /**
   * Resolve label names to ids.
   *
   * A label group in this workspace may be team-scoped or workspace-level, so
   * both are read and a team-scoped match wins. Names that do not resolve are
   * returned in `missing` rather than skipped: the master-failure observer
   * refuses to file a partially-labeled remediation issue, because an issue
   * missing `execution:mac` would sit in `Ready for Agent` forever.
   */
  async issueLabelIds(teamKey, names = []) {
    const query = `
      query {
        issueLabels(first: 250) { nodes { id name team { key } } }
      }
    `;
    const data = await this.request(query);
    const nodes = data.issueLabels?.nodes || [];
    const ids = {};
    const missing = [];
    for (const name of names) {
      const matches = nodes.filter((node) => node.name === name);
      const scoped = matches.find((node) => node.team?.key === teamKey) || matches[0];
      if (scoped) ids[name] = scoped.id;
      else missing.push(name);
    }
    return { ids, missing };
  }

  /** One project by exact name, with its milestones, or null. */
  async projectByName(name) {
    if (!name) return null;
    const query = `
      query($name: String!) {
        projects(filter: { name: { eq: $name } }, first: 5) {
          nodes { id name state projectMilestones { nodes { id name } } }
        }
      }
    `;
    const data = await this.request(query, { name });
    const node = data.projects?.nodes?.[0];
    if (!node) return null;
    return {
      id: node.id,
      name: node.name,
      status: node.state || null,
      milestones: (node.projectMilestones?.nodes || []).map((milestone) => ({ id: milestone.id, name: milestone.name })),
    };
  }

  /** One issue by its human identifier (`MOV-123`), or null. */
  async issueByIdentifier(identifier) {
    const match = /^([A-Z]+)-(\d+)$/i.exec(String(identifier || "").trim());
    if (!match) return null;
    const query = `
      query($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
          nodes { id identifier url state { name type } }
        }
      }
    `;
    const data = await this.request(query, { teamKey: match[1].toUpperCase(), number: Number(match[2]) });
    const node = data.issues?.nodes?.[0];
    if (!node) return null;
    return {
      id: node.id,
      identifier: node.identifier,
      url: node.url,
      stateName: node.state?.name || null,
      stateType: node.state?.type || null,
    };
  }

  /**
   * Create one issue. The only issue-creating mutation in the dispatcher, and
   * its sole caller is the master-failure observer (MOV-305): everything else
   * the dispatcher does reacts to issues a human or an authoring agent filed.
   */
  async createIssue({ teamId, title, description, labelIds = [], projectId = null, projectMilestoneId = null, stateId = null, priority = null }) {
    if (!teamId || !title) throw new Error("createIssue requires teamId and title");
    const mutation = `
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }
    `;
    const input = { teamId, title, description: description || "", labelIds };
    if (projectId) input.projectId = projectId;
    if (projectMilestoneId) input.projectMilestoneId = projectMilestoneId;
    if (stateId) input.stateId = stateId;
    if (priority !== null && priority !== undefined) input.priority = priority;
    const data = await this.request(mutation, { input });
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue?.id) throw new Error("issueCreate returned no issue");
    return { id: issue.id, identifier: issue.identifier, url: issue.url };
  }

  /**
   * Open an Agent Session on an issue under this app's own identity (MOV-167).
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
    // MOV-359: the human owner the promoter checks before filling a missing
    // one. Same shape and same null-handling as `delegate` — both are just a
    // `User` node — so this reuses `normalizeDelegate` rather than a
    // near-duplicate normalizer.
    assignee: normalizeDelegate(node.assignee),
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
