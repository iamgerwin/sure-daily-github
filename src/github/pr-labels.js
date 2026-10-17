import logger from '../utils/logger.js';
import {
  MARKERS, MERGE_POLICY_CONTEXT, PAUSED, BABYSIT, NEEDS_HUMAN, CONFLICT_RESOLVED
} from '../core/policy.js';

export const DASHBOARD_TITLE = 'sdg: PR automation';

// Created on first act-mode run. Human-owned labels (babysit, the kill switch)
// are only created when missing, never recolored.
export const LABEL_DEFINITIONS = [
  { name: 'sdg:conflict', color: 'd93f0b', description: 'Lifecycle: resolving merge conflicts', managed: true },
  { name: 'sdg:fixing', color: 'fbca04', description: 'Lifecycle: addressing review findings or scorecard gaps', managed: true },
  { name: 'sdg:waiting', color: 'c5def5', description: 'Lifecycle: waiting on CI, re-review, quiet period or quarantine', managed: true },
  { name: 'sdg:ready', color: '0e8a16', description: 'Lifecycle: every merge gate passes', managed: true },
  { name: CONFLICT_RESOLVED, color: '5319e7', description: 'History: pr-maint resolved a conflict here, so merge quarantine applies', managed: true },
  { name: NEEDS_HUMAN, color: 'b60205', description: 'Escalated: reason and clearing condition are in the sdg status comment', managed: true },
  { name: BABYSIT, color: '1d76db', description: 'Priority hint: handled first with twice the per-PR budget', managed: false },
  { name: PAUSED, color: '000000', description: 'Kill switch: pr-maint ignores this PR, or everything when on the dashboard issue', managed: false }
];

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

// Paused issues are fetched with every page, but only the first page's are read
const SNAPSHOT_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pausedIssues: issues(states: OPEN, labels: ["${PAUSED}"], first: 20) {
        nodes { number body }
      }
      pullRequests(states: OPEN, first: 50, after: $cursor) {
        nodes {
          number
          isDraft
          isCrossRepository
          headRefName
          headRefOid
          baseRefName
          mergeable
          mergeStateStatus
          author { login }
          labels(first: 50) { nodes { name } }
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              opener: comments(first: 1) { nodes { author { login } } }
              latest: comments(last: 1) { nodes { id } }
            }
          }
          reviews(last: 50) { nodes { id state author { login } } }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  contexts(first: 100) {
                    nodes {
                      __typename
                      ... on CheckRun { name status conclusion }
                      ... on StatusContext { context state }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Check evidence for clearing needs-human, read right before the write
const FRESH_CHECKS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PIN_ISSUE_MUTATION = `
  mutation ($issueId: ID!) {
    pinIssue(input: { issueId: $issueId }) { issue { number } }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
  }
`;

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// A deleted issue answers 410 Gone, a missing one 404
const isGone = (error) => error.status === 404 || error.status === 410;

// REST mergeability in the GraphQL vocabulary; null (not computed yet) is UNKNOWN
export function restMergeable(data) {
  const mergeable = data.mergeable === true ? 'MERGEABLE' : data.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
  return { mergeable, mergeStateStatus: String(data.mergeable_state || 'unknown').toUpperCase() };
}

// GitHub's own rollup counts our sdg/merge-policy status, so posting it would
// change the fingerprint and wake the next tick; this one leaves it out
export function rollupState(contexts = []) {
  const states = contexts
    .filter(c => c && c.context !== MERGE_POLICY_CONTEXT)
    .map(c => {
      if (c.__typename === 'CheckRun') {
        if (c.status !== 'COMPLETED') return 'PENDING';
        return FAILED_CONCLUSIONS.has(c.conclusion) ? 'FAILURE' : 'SUCCESS';
      }
      if (PENDING_STATES.has(c.state)) return 'PENDING';
      return FAILED_CONCLUSIONS.has(c.state) ? 'FAILURE' : 'SUCCESS';
    });
  if (states.length === 0) return null;
  if (states.includes('FAILURE')) return 'FAILURE';
  if (states.includes('PENDING')) return 'PENDING';
  return 'SUCCESS';
}

// Our own status on this head, so a re-run (or a lost ledger) never posts it twice
export function mergePolicyState(contexts = []) {
  return contexts.find(c => c?.context === MERGE_POLICY_CONTEXT)?.state || null;
}

export function normalizePullRequest(node) {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  return {
    number: node.number,
    isDraft: Boolean(node.isDraft),
    isCrossRepository: Boolean(node.isCrossRepository),
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    baseRefName: node.baseRefName,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    author: node.author?.login || null,
    labels: (node.labels?.nodes || []).map(l => l.name),
    reviewThreads: (node.reviewThreads?.nodes || []).map(t => ({
      id: t.id,
      isResolved: Boolean(t.isResolved),
      author: t.opener?.nodes?.[0]?.author?.login || null,
      lastCommentId: t.latest?.nodes?.[0]?.id || null
    })),
    reviews: (node.reviews?.nodes || []).map(r => ({ id: r.id, state: r.state, author: r.author?.login || null })),
    checks: rollupState(contexts),
    mergePolicy: mergePolicyState(contexts)
  };
}

// Every GitHub read and write pr-maint makes. Writes return { written: n }
// (0 when GitHub already had the content) so callers can count real writes.
export class PrMaintGitHub {
  constructor(octokit) {
    this.octokit = octokit;
    this.login = null;
  }

  async whoami() {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    this.login = data.login;
    return data.login;
  }

  // One query (paginated by 50 PRs) for everything decide() reads
  async fetchSnapshot(owner, repo) {
    const prs = [];
    let paused = false;
    let cursor = null;
    let first = true;
    do {
      const data = await this.octokit.graphql(SNAPSHOT_QUERY, { owner, repo, cursor });
      const repository = data.repository;
      if (first) {
        paused = (repository.pausedIssues?.nodes || []).some(issue => String(issue.body || '').includes(MARKERS.dashboard));
        first = false;
      }
      prs.push(...repository.pullRequests.nodes.map(normalizePullRequest));
      cursor = repository.pullRequests.pageInfo.hasNextPage ? repository.pullRequests.pageInfo.endCursor : null;
    } while (cursor);
    return { owner, repo, paused, prs: prs.sort((a, b) => a.number - b.number) };
  }

  // The head pin: re-read right before a write. Mergeability comes with it;
  // `checks` also reads the check rollup (only clearing needs-human needs it),
  // failing closed to null when it belongs to another head.
  async freshPullRequest(owner, repo, number, { checks = false } = {}) {
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    const fresh = {
      number: data.number,
      state: String(data.state).toUpperCase(),
      headRefOid: data.head?.sha || null,
      labels: (data.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
      ...restMergeable(data)
    };
    if (checks) {
      const result = await this.octokit.graphql(FRESH_CHECKS_QUERY, { owner, repo, number });
      const commit = result.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
      fresh.checks = commit && commit.oid === fresh.headRefOid
        ? rollupState(commit.statusCheckRollup?.contexts?.nodes || [])
        : null;
    }
    return fresh;
  }

  // Creates missing labels and repairs drifted managed ones; zero writes once
  // in place. `write(what, fn)` admits each write (false stops the setup, so
  // `complete` is false and it is retried later).
  async ensureLabels(owner, repo, { write = async (what, fn) => { await fn(); return true; } } = {}) {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    const byName = new Map(existing.map(l => [l.name.toLowerCase(), l]));
    let written = 0;
    for (const { name, color, description, managed } of LABEL_DEFINITIONS) {
      const current = byName.get(name.toLowerCase());
      let op = null;
      if (!current) {
        op = [`create label ${name}`, () => this.octokit.rest.issues.createLabel({ owner, repo, name, color, description })];
      } else if (managed && (current.color?.toLowerCase() !== color || (current.description || '') !== description)) {
        op = [`repair label ${name}`, () => this.octokit.rest.issues.updateLabel({ owner, repo, name: current.name, color, description })];
      }
      if (!op) continue;
      if (!(await write(...op))) return { written, complete: false };
      written++;
    }
    return { written, complete: true };
  }

  async addLabel(owner, repo, number, label) {
    await this.octokit.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [label] });
    return { written: 1 };
  }

  async removeLabel(owner, repo, number, label) {
    try {
      await this.octokit.rest.issues.removeLabel({ owner, repo, issue_number: number, name: label });
      return { written: 1 };
    } catch (error) {
      if (error.status === 404) return { written: 0 };
      throw error;
    }
  }

  // Only comments we wrote count: anyone can paste a marker
  isOurs(item, marker) {
    return String(item?.body || '').includes(marker) && sameLogin(item?.user?.login, this.login);
  }

  // One sticky comment per PR, edited only when its body changed
  async upsertSticky(owner, repo, number, body, { commentId = null } = {}) {
    let existing = null;
    if (commentId) {
      try {
        const { data } = await this.octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
        if (this.isOurs(data, MARKERS.status)) existing = data;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (!existing) {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner, repo, issue_number: number, per_page: 100
      });
      existing = comments.find(c => this.isOurs(c, MARKERS.status)) || null;
    }
    if (existing && existing.body === body) return { written: 0, id: existing.id };
    if (existing) {
      await this.octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      return { written: 1, id: existing.id };
    }
    const { data } = await this.octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
    return { written: 1, id: data.id };
  }

  // The known dashboard issue, or null when it was deleted, closed, or is not
  // ours (marker and author) any more
  async readDashboard(owner, repo, number) {
    if (!number) return null;
    try {
      const { data } = await this.octokit.rest.issues.get({ owner, repo, issue_number: number });
      return data.state === 'open' && !data.pull_request && this.isOurs(data, MARKERS.dashboard) ? data : null;
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  }

  // One pinned dashboard issue, found by its marker, edited only on change
  async upsertDashboard(owner, repo, body, { number = null } = {}) {
    let existing = await this.readDashboard(owner, repo, number);
    if (!existing) {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner, repo, state: 'open', creator: this.login, per_page: 100
      });
      existing = issues.find(issue => !issue.pull_request && this.isOurs(issue, MARKERS.dashboard)) || null;
    }
    if (existing && existing.body === body) return { written: 0, number: existing.number };
    if (existing) {
      await this.octokit.rest.issues.update({ owner, repo, issue_number: existing.number, body });
      return { written: 1, number: existing.number };
    }

    const { data } = await this.octokit.rest.issues.create({ owner, repo, title: DASHBOARD_TITLE, body });
    try {
      await this.octokit.graphql(PIN_ISSUE_MUTATION, { issueId: data.node_id });
      return { written: 2, number: data.number };
    } catch (error) {
      // An unpinned dashboard still works; the owner can pin it by hand
      logger.warn('Failed to pin the dashboard issue', { owner, repo, number: data.number, error: error.message });
      return { written: 1, number: data.number };
    }
  }

  async postStatus(owner, repo, sha, { state, description }) {
    await this.octokit.rest.repos.createCommitStatus({
      owner, repo, sha, state, context: MERGE_POLICY_CONTEXT, description
    });
    return { written: 1 };
  }

  async resolveThread(threadId) {
    await this.octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    return { written: 1 };
  }
}
