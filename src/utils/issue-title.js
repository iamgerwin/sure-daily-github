// GitHub rejects an issue title longer than this with a 422 ("title is too
// long (maximum is 256 characters)"). An uncounted failure is retried by every
// run, so a long template title or random title entry would never succeed.
export const MAX_ISSUE_TITLE_LENGTH = 256;

const ELLIPSIS = '…';

// Cuts a rendered issue title to GitHub's limit, ending it with an ellipsis.
// Counted in characters (code points), not UTF-16 units, so an emoji is never
// split in half. Returns the title unchanged when it already fits.
export function fitIssueTitle(title) {
  const chars = [...String(title)];
  if (chars.length <= MAX_ISSUE_TITLE_LENGTH) return String(title);
  return chars.slice(0, MAX_ISSUE_TITLE_LENGTH - 1).join('').trimEnd() + ELLIPSIS;
}
