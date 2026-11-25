// GitHub rejects an issue whose title is over 256 characters or whose body is
// over 65,536 with a 422. Titles and bodies are rendered from configured
// templates and title lists, so one long entry would otherwise fail that
// repository's issue on every run. Lengths are counted in UTF-16 code units,
// which is never fewer than the characters GitHub counts.
export const MAX_ISSUE_TITLE_CHARS = 256;
export const MAX_ISSUE_BODY_CHARS = 65536;

const TITLE_ELLIPSIS = '...';
const BODY_TRUNCATION_NOTE = '\n\n... (truncated to fit GitHub\'s issue size limit)';

// Cuts text longer than max so that text plus suffix fits, without leaving
// half of a surrogate pair (an emoji) at the cut
function fitText(text, max, suffix) {
  if (typeof text !== 'string' || text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - suffix.length));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}${suffix}`;
}

export function fitIssueTitle(title, max = MAX_ISSUE_TITLE_CHARS) {
  return fitText(title, max, TITLE_ELLIPSIS);
}

export function fitIssueBody(body, max = MAX_ISSUE_BODY_CHARS) {
  return fitText(body, max, BODY_TRUNCATION_NOTE);
}
