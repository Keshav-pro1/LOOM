import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function request(username = "valid-handle") {
  return new Request("http://localhost/api/practice/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username })
  });
}

function sqlClient(handler) {
  const calls = [];
  const tag = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return handler(text, values);
  };
  tag.begin = async (fn) => fn(tag);
  tag.json = (value) => value;
  return { sql: tag, calls };
}

async function load(fetchAccepted, sql) {
  vi.resetModules();
  vi.doMock("@/lib/auth-server", () => ({
    getRequestContext: async () => ({
      user: { id: USER },
      profile: { role: "student", user_id: USER },
      tenant: { id: TENANT },
      sql
    }),
    writeAudit: async () => {}
  }));
  vi.doMock("@/lib/rate-limit", () => ({
    checkRateLimit: async () => ({ ok: true })
  }));
  vi.doMock("@/lib/leetcode", () => ({
    normalizeLeetCodeUsername: (value) => {
      const username = String(value || "").trim().toLowerCase();
      return /^[a-z0-9_-]{1,30}$/.test(username) ? username : null;
    },
    fetchAccepted
  }));
  return import("@/app/api/practice/connection/route");
}

describe("LeetCode connection validation", () => {
  beforeEach(() => vi.resetModules());

  it("rejects a username LeetCode says does not exist before saving it", async () => {
    const { sql, calls } = sqlClient(async () => []);
    const fetchAccepted = vi.fn(async () => ({
      ok: false,
      code: "LEETCODE_PROFILE_NOT_FOUND",
      message: "Profile unavailable. Check the username and public submission visibility.",
      retryable: false
    }));
    const { POST } = await load(fetchAccepted, sql);

    const response = await POST(request("missing-profile"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("LEETCODE_PROFILE_NOT_FOUND");
    expect(fetchAccepted).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.text.includes("INSERT INTO practice_connections"))).toBe(false);
  });

  it("does not save a username while LeetCode is unavailable", async () => {
    const { sql, calls } = sqlClient(async () => []);
    const fetchAccepted = vi.fn(async () => ({
      ok: false,
      code: "LEETCODE_UNAVAILABLE",
      message: "LeetCode is unavailable.",
      retryable: true
    }));
    const { POST } = await load(fetchAccepted, sql);

    const response = await POST(request("valid-handle"));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("LEETCODE_UNAVAILABLE");
    expect(calls.some((call) => call.text.includes("INSERT INTO practice_connections"))).toBe(false);
  });

  it("saves a username after LeetCode confirms the profile", async () => {
    const { sql, calls } = sqlClient(async (text) => {
      if (text.includes("SELECT leetcode_username")) return [];
      if (text.includes("INSERT INTO practice_connections")) {
        return [{ leetcode_username: "valid-handle", sync_state: "never" }];
      }
      return [];
    });
    const fetchAccepted = vi.fn(async () => ({ ok: true, username: "valid-handle", submissions: [] }));
    const { POST } = await load(fetchAccepted, sql);

    const response = await POST(request("valid-handle"));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ username: "valid-handle", syncState: "never" });
    expect(calls.some((call) => call.text.includes("INSERT INTO practice_connections"))).toBe(true);
  });
});
