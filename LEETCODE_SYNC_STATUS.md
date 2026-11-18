# LeetCode Sync Status

## Status: ✅ Complete — Already Implemented

LeetCode sync is a separate, pre-existing feature that is fully functional. No additional work needed.

### Files
- `lib/practice-sync.js` — Sync engine (`syncConnection`, `syncDueConnections`)
- `app/api/practice/connection/route.js` — POST /api/practice/connection
- `app/api/practice/refresh/route.js` — POST /api/practice/refresh
- `lib/leetcode.js` — Fetches accepted submissions from LeetCode API

### How It Works
1. User links LeetCode username at `/student/practice`
2. Sync checks for accepted submissions since last sync
3. New submissions recorded as `practice_solves` with evidence
4. Practice score recomputed
5. `next_sync_at` set 15min in future (cooldown)
6. Manual refresh via "Refresh LeetCode Progress" button

### API Endpoints
- `POST /api/practice/connection` — Link LeetCode username
- `POST /api/practice/refresh` — Manual sync refresh

### Rate Limits & Cooldowns
- 3 refreshes per 10min window per user
- 15min cooldown between automatic syncs
- 12s GitHub API timeout, 8s LeetCode API timeout

### Tests
All practice-related tests pass (see `tests/practice-connection.test.js`, `tests/ranking-exploit.test.js`)

### Independent from GitHub Repo Sync
- GitHub repo sync: `POST /api/github/repos/verify` + `RepoVerifyPicker` UX
- LeetCode sync: `POST /api/practice/connection` + `/api/practice/refresh`
- Both features are complete and working independently