import { describe, expect, it, vi } from "vitest";
import { fetchAccepted, normalizeLeetCodeUsername } from "@/lib/leetcode";

const NOW = Date.parse("2026-11-16T00:00:00Z");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

describe("LeetCode profile lookup", () => {
  it("accepts handles but not profile URLs", () => {
    expect(normalizeLeetCodeUsername("  DemonStrikkk ")).toBe("demonstrikkk");
    expect(normalizeLeetCodeUsername("https://leetcode.com/u/demonstrikkk/")).toBeNull();
    expect(normalizeLeetCodeUsername("name with spaces")).toBeNull();
  });

  it("reports a profile LeetCode does not recognise", async () => {
    const fetchImpl = vi.fn(async () => response({
      errors: [{ message: "That user does not exist." }],
      data: { matchedUser: null, recentAcSubmissionList: [] }
    }));

    const result = await fetchAccepted("missing-profile", "user-1", { fetchImpl, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "LEETCODE_PROFILE_NOT_FOUND", retryable: false });
  });

  it("reports rate limiting without treating the profile as missing", async () => {
    const fetchImpl = vi.fn(async () => response({}, 429));

    const result = await fetchAccepted("someone", "user-1", { fetchImpl, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "LEETCODE_RATE_LIMITED", retryable: true });
  });

  it("parses accepted submissions from a real GraphQL-shaped response", async () => {
    const acceptedAt = Math.floor((NOW - 60_000) / 1000);
    const fetchImpl = vi.fn(async () => response({
      data: {
        matchedUser: { username: "demonstrikkk" },
        recentAcSubmissionList: [
          { id: "2195305747", titleSlug: "subsets", timestamp: String(acceptedAt) }
        ]
      }
    }));

    const result = await fetchAccepted("demonstrikkk", "user-1", { fetchImpl, now: NOW });

    expect(result).toMatchObject({
      ok: true,
      username: "demonstrikkk",
      submissions: [{
        userId: "user-1",
        externalId: "2195305747",
        slug: "subsets",
        acceptedAt: acceptedAt * 1000
      }]
    });
  });
});
