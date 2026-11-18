Git Commit Summary for Github Repo Sync UX

Staged files (13):
1. app/(app)/student/github/GithubBits.jsx — RepoVerifyPicker rewrite
2. app/(app)/student/github/page.jsx — grants query + copy update
3. app/(app)/student/projects/new/NewProjectForm.jsx — verification hint
4. app/api/github/oauth/callback/route.js — shared grant helpers
5. app/api/github/repos/route.js — list/create with verified/hasMore flags
6. app/api/github/sync/route.js — (may be same as repos/route.js)
7. app/api/projects/route.js — repositoryId live verification
8. docs/13-api-reference.md — new /api/github/repos/verify doc
9. docs/14-database-reference.md — grant semantics update
10. docs/16-github-integration.md — explicit-only grants model
11. lib/github-oauth.js — 15s timeout, timeoutSignal()
12. lib/github-repos.js — bulk jsonb_to_recordset upsert
13. tests/github-repos.test.js — 5/5 passing, rememberRepoMetadata contract

Commit message: "Github: explicit grants + add repos UX"

All checks passed:
- 89/89 tests across 6 test files
- ESLint: 0 errors
- Vitest: all suites passing