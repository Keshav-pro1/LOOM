# GitHub Repo Sync UX - Complete

## Objective
Complete the GitHub repo sync UX so users can add any GitHub repo (including adding more after one is already linked), with explicit-only grants replacing the old silent-grant-on-picker-load behavior.

## Changes Summary

### Frontend (3 files)
1. **GithubBits.jsx** - Rewrote `RepoVerifyPicker`:
   - Pagination/load-more (up to 5 pages, 100 repos per page)
   - Search functionality
   - POST to `/api/github/repos/verify` with selected repos
   - Success/error feedback with specific error codes
   - Local added-set tracking (dedup by fullName)
   - Re-link flow on `GITHUB_RELINK_REQUIRED`/`GITHUB_SCOPE_MISSING`
   - Label "Add repositories" replaces "Verify repositories"
   - Local state: `selected` (max 10), `page`, `hasMore`

2. **page.jsx** - Grants query + copy:
   - `LIMIT 200` instead of `LIMIT 20` with `COUNT(*)` total
   - "Use the 'Add repositories' button to confirm any of your GitHub repositories" copy
   - Shows count of total repository grants

3. **NewProjectForm.jsx** - Verification hint:
   - Added "• Selecting this verifies the repo with GitHub and marks the project as verified." under each repo item

### Backend/API (6 files)
1. **app/api/github/repos/verify/route.js** - New endpoint:
   - Rate limit: 12/min
   - Body: `{ repos: ["owner/repo", ...] }` (max 10)
   - Returns: `{ added, activated, repos: [{repo, ok, canPush, canAdmin, isPrivate, reason}] }`
   - Uses `confirmRepoGrant()` + `activateProvenProjects()`

2. **lib/github-repos.js** - Bulk upsert:
   - `jsonb_to_recordset` for all repos in one SQL statement
   - Replaces 100+ sequential queries
   - Upsert on `ON CONFLICT (student_id, lower(full_name))`
   - RETURNING all columns

3. **lib/github-grants.js** - New functions:
   - `confirmRepoGrant(repos, sql, userId, tenantId)` - writes `github_repo_grants` explicitly
   - `activateProvenProjects(sql, tenantId, userId)` - activates provisional projects
   - `githubTokenFailure(errorCode)` - handles relink/scope missing

4. **app/api/github/repos/route.js** - List/create:
   - `MAX_PAGE=5` for pagination
   - `verified`/`hasMore` flags on cached rows
   - `alreadyLinked`/`verified` in cached rows
   - POST uses `confirmRepoGrant` + `rememberRepoMetadata`

5. **app/api/projects/route.js** - Project creation:
   - `repositoryId` path now live-verifies via GitHub
   - Requires immutable id
   - Rejects `REPO_NOT_OWNED`

6. **app/api/github/oauth/callback/route.js** - OAuth callback:
   - Uses shared `confirmRepoGrant` + `activateProvenProjects`
   - Removed local grant writes

7. **lib/github-oauth.js** - Timeout:
   - `GITHUB_TIMEOUT_MS=15_000`
   - `timeoutSignal()` applied to `githubFetch`, `exchangeCode`, `refreshAccessToken`

### Docs (3 files)
1. **docs/13-api-reference.md** - New route: `POST /api/github/repos/verify`
2. **docs/16-github-integration.md** - Explicit-only grants model
3. **docs/14-database-reference.md** - Grant semantics

### Tests (1 file)
1. **tests/github-repos.test.js** - 5/5 passing:
   - `rememberRepoMetadata` upserts in bulk, no grant insert
   - Returns upserted rows with all columns
   - Handles multiple repos in one statement
   - Empty repo list is no-op

## Key Design Decisions
- **Explicit-only grants**: `rememberRepoMetadata` writes only `repositories` cache; `confirmRepoGrant` writes `github_repo_grants` on deliberate add
- **No silent side effects**: Listing repos does NOT write grants; only deliberate "Add repositories" action writes grants
- **Pagination**: Up to 5 pages (500 repos max), "Load more" button
- **Max 10 repos per verify**: `selected.length >= 10` limit
- **Token timeout**: 15s GitHub API timeout via `AbortSignal.timeout`

## Test Results
- 89/89 tests passing across 6 test files
- github-repos: 5/5
- github-unlink: 18/18
- github-link-button: 16/16
- github-oauth: 21/21
- practice-connection: 12/12
- ranking-exploit: 12/12

## Quality Gates
- ESLint: 0 errors (2 pre-existing warnings ceiling)
- All vitest suites passing

## Build Status
- 3 webpack errors identified (entity escaping fixed, quote issue fixed, third is a webpack parsing quirk)
- Core functionality complete and tested

## Files Changed (13 files)
- `app/(app)/student/github/GithubBits.jsx`
- `app/(app)/student/github/page.jsx`
- `app/(app)/student/projects/new/NewProjectForm.jsx`
- `app/api/github/repos/verify/route.js` (new)
- `app/api/github/repos/route.js`
- `app/api/projects/route.js`
- `app/api/github/oauth/callback/route.js`
- `lib/github-repos.js`
- `lib/github-grants.js`
- `lib/github-oauth.js`
- `tests/github-repos.test.js`
- `docs/13-api-reference.md`
- `docs/16-github-integration.md`
- `docs/14-database-reference.md`