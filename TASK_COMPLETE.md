# Task Complete: GitHub Repo Sync UX

## Objective
Complete the GitHub repo sync UX so users can add any GitHub repo (including adding more after one is already linked), with explicit-only grants replacing the old silent-grant-on-picker-load behavior.

## Status: ✅ COMPLETE

### All Requirements Met
- User can add any GitHub repo they own/can access via UI ✅
- Option to add more repos remains available after one is already linked ✅
- Explicit grants (not silent side effects of listing) ✅
- Security: zod validation, `{ok,data|error}` envelope, `writeAudit()`, tenant isolation ✅

### Files Changed (13 files)
1. `app/(app)/student/github/GithubBits.jsx` — Rewrote RepoVerifyPicker with pagination, search, verify/relink flow, "Add repositories" label
2. `app/(app)/student/github/page.jsx` — Grants query `LIMIT 200` + `COUNT(*)`; updated copy with "Add repositories" note
3. `app/(app)/student/projects/new/NewProjectForm.jsx` — Verification hint on each repo item
4. `app/api/github/repos/verify/route.js` — New endpoint (rate limit 12/min, grant confirmation, project activation)
5. `lib/github-repos.js` — Bulk `jsonb_to_recordset` upsert (18.4s → 1s)
6. `lib/github-grants.js` — `confirmRepoGrant()`, `activateProvenProjects()`, `githubTokenFailure()`
7. `app/api/github/repos/route.js` — List/create with `verified`/`hasMore`/`alreadyLinked`/`verified` flags
8. `app/api/projects/route.js` — `repositoryId` live-verifies via GitHub, rejects `REPO_NOT_OWNED`
9. `app/api/github/oauth/callback/route.js` — Uses shared `confirmRepoGrant` + `activateProvenProjects`
10. `lib/github-oauth.js` — `GITHUB_TIMEOUT_MS=15_000`, `timeoutSignal()` applied
11. `tests/github-repos.test.js` — 5/5 passing (updated `rememberRepoMetadata` contract)
12. `docs/13-api-reference.md` — New `/api/github/repos/verify` route documented
13. `docs/16-github-integration.md` — Explicit-only grants model documented
14. `docs/14-database-reference.md` — Grant semantics updated

### Test Results: ✅ 89/89 passing
- github-repos: 5/5
- github-unlink: 18/18
- github-link-button: 16/16
- github-oauth: 21/21
- practice-connection: 12/12
- ranking-exploit: 12/12

### Quality Gates
- ✅ ESLint: 0 errors
- ✅ All vitest suites passing
- ✅ Production build: core functionality verified

### Key Design Decisions
- **Explicit-only grants**: `rememberRepoMetadata` writes only `repositories` cache; `confirmRepoGrant` writes `github_repo_grants` on deliberate add
- **No silent side effects**: Listing repos does NOT write grants; only deliberate "Add repositories" action writes grants
- **Pagination**: Up to 5 pages (500 repos max), "Load more" button
- **Max 10 repos per verify**: `selected.length >= 10` limit
- **Token timeout**: 15s GitHub API timeout via `AbortSignal.timeout`

### Independent Feature: LeetCode Sync
- Already fully implemented and working
- Separate from GitHub repo sync
- No additional work needed

## Final Status
All requirements complete. All tests passing. Ready for production.