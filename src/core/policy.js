// Pre-flight check for every GitHub write pr-maint makes. Pure: the caller
// passes the fresh PR state and the tick context, so every rule is unit-tested.
//
// An Action is { type, scope, pr, headSha, payload }: scope 'pr' writes to a
// pull request, scope 'dashboard' to the dashboard issue (payload.issue).

export const MODES = ['shadow', 'act', 'autonomous'];
export const ACTION_TYPES = ['label.add', 'label.remove', 'comment.upsert', 'thread.resolve', 'status.post'];
export const SCOPES = ['pr', 'dashboard'];

// Exactly one of these is on an open PR; all are AI-owned
export const LIFECYCLE_LABELS = ['sdg:conflict', 'sdg:fixing', 'sdg:waiting', 'sdg:ready'];
export const NEEDS_HUMAN = 'needs-human';
export const CONFLICT_RESOLVED = 'conflict-resolved';
export const BABYSIT = 'babysit';
export const PAUSED = 'automation-paused';
// The only labels the AI may add or remove
export const MANAGED_LABELS = [...LIFECYCLE_LABELS, CONFLICT_RESOLVED, NEEDS_HUMAN];
// Set by humans only: a priority hint and the kill switch
export const HUMAN_LABELS = [BABYSIT, PAUSED];

export const MARKERS = {
  status: '<!-- sdg:status -->',
  dashboard: '<!-- sdg:dashboard -->'
};
export const MERGE_POLICY_CONTEXT = 'sdg/merge-policy';
// The real verdict (success/failure) arrives with the merge policy itself
export const STATUS_STATES = ['pending'];
export const MAX_TEXT_BYTES = 8 * 1024;
export const MAX_STATUS_DESCRIPTION = 140;

export const NEEDS_HUMAN_CLEAR_LIMIT = 2;
export const NEEDS_HUMAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Escalations only a human may clear
export const NEVER_AUTO_CLEAR = ['gate-weakening', 'policy-denial', 'flapping'];

export const DEFAULT_CAPS = { writesPerPrPerTick: 20, writesPerHour: 200 };

const ATTRIBUTION_PATTERN = /Co-Authored-By|Generated with|\bClaude\b|\bAnthropic\b|\u{1F916}/iu;
const SECRET_PATTERN = /\bgh[pousr]_[A-Za-z0-9]|github_pat_|sk-ant-/;
const SLASH_COMMAND_PATTERN = /^\s*\/sdg\b/i;
// A word character before "@" means an email address, not a mention
const MENTION_PATTERN = /(^|[^\w@])@([A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?)/g;

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isLabelAction = (action) => action.type === 'label.add' || action.type === 'label.remove';

// autonomous -> act -> shadow; a tripped breaker drops one level
export function downgradeMode(mode) {
  const index = MODES.indexOf(mode);
  return index > 0 ? MODES[index - 1] : 'shadow';
}

export function actionText(action) {
  if (action.type === 'comment.upsert') return String(action.payload?.body ?? '');
  if (action.type === 'status.post') return String(action.payload?.description ?? '');
  return null;
}

export function mentions(text) {
  return [...String(text).matchAll(MENTION_PATTERN)].map(match => match[2]);
}

function recentClears(escalation, now) {
  return (escalation?.clears || []).filter(at => now - at < NEEDS_HUMAN_WINDOW_MS).length;
}

// kind: 'impossible' denials should never happen (a bug or an injection): they
// trip the breaker and escalate the PR. 'trip' only trips the breaker.
// 'deny' is an ordinary refusal. Rules run in order; the first denial wins.
// Content rules run before the mode rule so shadow mode still surfaces them.
export const RULES = [
  {
    rule: 'type',
    kind: 'impossible',
    check: (action) => {
      if (!ACTION_TYPES.includes(action.type)) return `unknown action type ${action.type}`;
      if (!SCOPES.includes(action.scope)) return `unknown scope ${action.scope}`;
      return null;
    }
  },
  {
    rule: 'scope',
    kind: 'impossible',
    check: (action, fresh, ctx) => {
      if (action.scope === 'dashboard') {
        if (action.type !== 'comment.upsert' || action.payload?.marker !== 'dashboard') {
          return 'the dashboard issue only takes its own body upsert';
        }
        return null;
      }
      if (!fresh || fresh.number !== action.pr) return `no snapshot for #${action.pr}`;
      if (fresh.isCrossRepository) return 'head branch lives in a fork';
      if (!(ctx.authors || []).some(author => sameLogin(author, fresh.author))) {
        return `author ${fresh.author || 'unknown'} is not allowlisted`;
      }
      if (action.type === 'comment.upsert' && action.payload?.marker !== 'status') {
        return 'pull requests only take the sticky status comment';
      }
      if (action.type === 'status.post' && action.payload?.context !== MERGE_POLICY_CONTEXT) {
        return `only the ${MERGE_POLICY_CONTEXT} status may be posted`;
      }
      if (action.type === 'thread.resolve'
        && !(fresh.reviewThreads || []).some(thread => thread.id === action.payload?.threadId)) {
        return 'thread does not belong to this pull request';
      }
      return null;
    }
  },
  {
    rule: 'labels',
    kind: 'impossible',
    check: (action) => {
      if (!isLabelAction(action)) return null;
      const label = action.payload?.label;
      if (HUMAN_LABELS.includes(label)) return `${label} is set by humans only`;
      if (!MANAGED_LABELS.includes(label)) return `${label} is not a managed label`;
      return null;
    }
  },
  {
    rule: 'text-safety',
    kind: 'impossible',
    check: (action) => {
      const text = actionText(action);
      if (text === null) return null;
      if (ATTRIBUTION_PATTERN.test(text)) return 'text contains attribution';
      if (SECRET_PATTERN.test(text)) return 'text contains a secret pattern';
      return null;
    }
  },
  {
    rule: 'text-format',
    kind: 'deny',
    check: (action, fresh, ctx) => {
      const text = actionText(action);
      if (text === null) return null;
      if (action.type === 'comment.upsert') {
        const marker = MARKERS[action.payload?.marker];
        if (!marker || !text.includes(marker)) return 'comment is missing its sdg marker';
      }
      if (SLASH_COMMAND_PATTERN.test(text)) return 'text starts with an /sdg command';
      const stranger = mentions(text).find(login => !sameLogin(login, ctx.owner));
      if (stranger) return `text mentions @${stranger}`;
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return `text exceeds ${MAX_TEXT_BYTES} bytes`;
      if (action.type === 'status.post' && text.length > MAX_STATUS_DESCRIPTION) {
        return `status description exceeds ${MAX_STATUS_DESCRIPTION} characters`;
      }
      return null;
    }
  },
  {
    rule: 'status',
    kind: 'deny',
    check: (action) => {
      if (action.type !== 'status.post') return null;
      return STATUS_STATES.includes(action.payload?.state)
        ? null
        : `status state ${action.payload?.state} is not allowed before the merge policy exists`;
    }
  },
  {
    rule: 'lifecycle',
    kind: 'deny',
    check: (action, fresh) => {
      if (action.type !== 'label.add' || !LIFECYCLE_LABELS.includes(action.payload?.label)) return null;
      const others = (fresh?.labels || []).filter(l => LIFECYCLE_LABELS.includes(l) && l !== action.payload.label);
      return others.length ? `would add a second lifecycle label next to ${others.join(', ')}` : null;
    }
  },
  {
    rule: 'needs-human',
    kind: 'deny',
    check: (action, fresh, ctx) => {
      if (action.type !== 'label.remove' || action.payload?.label !== NEEDS_HUMAN) return null;
      const escalation = ctx.escalation;
      if (!escalation?.active) return 'needs-human was set by a human';
      if (NEVER_AUTO_CLEAR.includes(escalation.reason)) return `escalation reason ${escalation.reason} is cleared by humans only`;
      if (recentClears(escalation, ctx.now) >= NEEDS_HUMAN_CLEAR_LIMIT) {
        return `needs-human was auto-cleared ${NEEDS_HUMAN_CLEAR_LIMIT} times in 7 days`;
      }
      return null;
    }
  },
  {
    rule: 'escalated',
    kind: 'deny',
    check: (action, fresh) => {
      if (action.scope !== 'pr' || !(fresh?.labels || []).includes(NEEDS_HUMAN)) return null;
      if (action.type === 'comment.upsert') return null;
      if (isLabelAction(action) && action.payload?.label === NEEDS_HUMAN) return null;
      return 'pull request is escalated; only the sticky comment may change';
    }
  },
  {
    rule: 'thread',
    kind: 'deny',
    check: (action, fresh, ctx) => {
      if (action.type !== 'thread.resolve') return null;
      const thread = fresh.reviewThreads.find(t => t.id === action.payload.threadId);
      if (thread.isResolved) return 'thread is already resolved';
      if (sameLogin(thread.author, ctx.owner) && action.payload.outcome !== 'fixed') {
        return 'owner threads are only resolved once fixed';
      }
      return null;
    }
  },
  {
    rule: 'mode',
    kind: 'deny',
    check: (action, fresh, ctx) => {
      if (!MODES.includes(ctx.mode)) return `unknown mode ${ctx.mode}`;
      if (ctx.mode === 'shadow' && action.scope !== 'dashboard') return 'shadow mode only writes the dashboard issue';
      return null;
    }
  },
  {
    rule: 'paused',
    kind: 'deny',
    check: (action, fresh) => (action.scope === 'pr' && (fresh?.labels || []).includes(PAUSED)
      ? `pull request is labeled ${PAUSED}`
      : null)
  },
  {
    rule: 'rate',
    kind: 'trip',
    check: (action, fresh, ctx) => {
      const caps = { ...DEFAULT_CAPS, ...(ctx.caps || {}) };
      const writes = ctx.writes || {};
      if (action.scope === 'pr' && (writes.pr || 0) >= caps.writesPerPrPerTick) {
        return `${caps.writesPerPrPerTick} writes on this pull request this tick`;
      }
      if ((writes.hour || 0) >= caps.writesPerHour) return `${caps.writesPerHour} writes in the last hour`;
      return null;
    }
  },
  {
    rule: 'head-pin',
    kind: 'deny',
    check: (action, fresh) => {
      if (action.scope !== 'pr') return null;
      if (String(fresh.state || 'OPEN').toUpperCase() !== 'OPEN') return 'pull request is no longer open';
      if (!action.headSha || action.headSha !== fresh.headRefOid) {
        return `head moved from ${action.headSha || 'none'} to ${fresh.headRefOid}`;
      }
      return null;
    }
  }
];

// Returns { allowed: true } or { allowed: false, rule, kind, reason, trip, escalate }
export function check(action, fresh, ctx = {}) {
  for (const { rule, kind, check: evaluate } of RULES) {
    const reason = evaluate(action, fresh, ctx);
    if (reason) {
      return { allowed: false, rule, kind, reason, trip: kind !== 'deny', escalate: kind === 'impossible' };
    }
  }
  return { allowed: true };
}
