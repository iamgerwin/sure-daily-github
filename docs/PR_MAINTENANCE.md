# PR Maintenance

This page covers the CI and branch-protection setup that automated PR maintenance relies on. The automation will resolve
conflicts, address review findings, and merge PRs that pass the merge policy. Nothing may be merged automatically until
the test suite runs on every PR and `master` requires it to pass.

## CI workflow

`.github/workflows/test.yml` runs on:

- every pull request targeting `master`
- every push to `master`

It has one job, `test`, on `ubuntu-latest`. The job checks out the repo, sets up Node.js 22 with the npm cache, installs
dependencies (`npm ci`, or `npm install` if there is no `package-lock.json`), and runs `npm test`.

The job name `test` is load-bearing: the `master` ruleset below requires a status check with exactly that name. If you
rename the job, required checks will never report and every PR will be blocked.

## One-time setup: `master` ruleset

**Apply this by hand, once. This PR does not apply it.** Run it after the CI workflow has landed on `master`:

```bash
gh api -X POST repos/iamgerwin/sure-daily-github/rulesets --input - <<'JSON'
{"name":"master","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,
    "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,
    "required_status_checks":[{"context":"test"},{"context":"sdg/merge-policy"}]}}]}
JSON
```

The ruleset:

- blocks deleting `master` and force-pushing to it (`deletion`, `non_fast_forward`)
- requires every change to go through a pull request, with all review threads resolved
- requires the `test` check (this workflow) and the `sdg/merge-policy` commit status to pass on an up-to-date branch

The bypass list is empty, so admins don't get a bypass either. `sdg/merge-policy` is posted by the PR-maintenance
orchestrator, which is added in a later PR. Until that exists, PRs can't satisfy the ruleset. Apply the ruleset when the
orchestrator is ready, or expect merges to be blocked until it is.

To check it after applying:

```bash
gh api repos/iamgerwin/sure-daily-github/rulesets
```
