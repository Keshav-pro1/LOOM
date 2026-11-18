import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitMemory,
  checkRateLimit,
  durableRateLimitConfigured,
  rateLimitResponse
} from "@/lib/rate-limit";

// The limiter is what stands between a login form and credential stuffing. It
// has two backends: an in-memory bucket per instance, and an optional shared
// Redis counter. The tests pin both, plus the fail-open-on-outage rule: a Redis
// failure must degrade to the local bucket, never to "no limit".

const ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
let savedEnv = {};

function requestFor(ip, path = "/api/auth/login", userId = null) {
  const headers = new Headers();
  if (ip) headers.set("x-forwarded-for", ip);
  const request = new Request(`http://localhost${path}`, { headers });
  return { request, userId };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  __resetRateLimitMemory();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});

afterEach(() => {
  __resetRateLimitMemory();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("in-memory limiter", () => {
  it("allows the budget, then blocks the next request", () => {
    const first = checkRateLimit("login:ip1", { limit: 3, windowMs: 60_000 });
    const second = checkRateLimit("login:ip1", { limit: 3, windowMs: 60_000 });
    const third = checkRateLimit("login:ip1", { limit: 3, windowMs: 60_000 });
    const fourth = checkRateLimit("login:ip1", { limit: 3, windowMs: 60_000 });

    expect([first.ok, second.ok, third.ok]).toEqual([true, true, true]);
    expect([first.remaining, second.remaining, third.remaining]).toEqual([2, 1, 0]);
    expect(fourth.ok).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.backend).toBe("memory");
  });

  it("reports a positive retryAfter in seconds", () => {
    checkRateLimit("retry:key", { limit: 1, windowMs: 10_000 });
    const blocked = checkRateLimit("retry:key", { limit: 1, windowMs: 10_000 });
    expect(blocked.retryAfter).toBe(10);
  });

  it("resets after the window elapses", () => {
    checkRateLimit("window:key", { limit: 1, windowMs: 5_000 });
    expect(checkRateLimit("window:key", { limit: 1, windowMs: 5_000 }).ok).toBe(false);
    vi.advanceTimersByTime(5_001);
    const after = checkRateLimit("window:key", { limit: 1, windowMs: 5_000 });
    expect(after.ok).toBe(true);
    expect(after.remaining).toBe(0);
  });

  it("keeps separate budgets per key", () => {
    checkRateLimit("a", { limit: 1 });
    expect(checkRateLimit("b", { limit: 1 }).ok).toBe(true);
    expect(checkRateLimit("a", { limit: 1 }).ok).toBe(false);
  });

  it("uses a default budget of 60 per minute", () => {
    for (let i = 0; i < 60; i += 1) {
      expect(checkRateLimit("default").ok, `request ${i + 1}`).toBe(true);
    }
    expect(checkRateLimit("default").ok).toBe(false);
  });
});

describe("request-derived keys", () => {
  it("separates callers by the first forwarded IP", () => {
    const a = checkRateLimit(requestFor("1.1.1.1").request, { limit: 1, windowMs: 60_000 });
    const b = checkRateLimit(requestFor("2.2.2.2").request, { limit: 1, windowMs: 60_000 });
    const aAgain = checkRateLimit(requestFor("1.1.1.1").request, { limit: 1, windowMs: 60_000 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(aAgain.ok).toBe(false);
  });

  it("prefers a user id over the IP", () => {
    const r1 = requestFor("1.1.1.1", "/api/x", "user-a");
    const r2 = requestFor("1.1.1.1", "/api/x", "user-b");
    checkRateLimit(r1.request, { userId: r1.userId, limit: 1 });
    // A second account behind the same NAT must not inherit the first budget.
    expect(checkRateLimit(r2.request, { userId: r2.userId, limit: 1 }).ok).toBe(true);
  });

  it("separates routes for the same caller", () => {
    checkRateLimit(requestFor("1.1.1.1", "/api/auth/login").request, { limit: 1 });
    expect(checkRateLimit(requestFor("1.1.1.1", "/api/auth/register").request, { limit: 1 }).ok).toBe(true);
  });

  it("falls back to an anon bucket when no IP header is present", () => {
    const r = requestFor(null);
    checkRateLimit(r.request, { limit: 1 });
    expect(checkRateLimit(r.request, { limit: 1 }).ok).toBe(false);
  });
});

describe("durable backend configuration", () => {
  it("is disabled unless both Redis variables are present", () => {
    expect(durableRateLimitConfigured()).toBe(false);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    expect(durableRateLimitConfigured()).toBe(false);
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    expect(durableRateLimitConfigured()).toBe(true);
  });

  it("stays on the local backend when durable is requested but not configured", () => {
    const result = checkRateLimit("durable:off", { limit: 1, durable: true });
    expect(result.backend).toBe("memory");
    expect(result.ok).toBe(true);
  });
});

describe("redis backend", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "secret";
  });

  it("uses the shared counter and reports remaining budget", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: [1, 60_000] })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkRateLimit("redis:key", { limit: 5, durable: true, windowMs: 60_000 });
    expect(result).toMatchObject({ ok: true, remaining: 4, backend: "redis" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://redis.example");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)[0]).toBe("EVAL");
  });

  it("blocks once the shared counter passes the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: [6, 30_000] })
    })));
    const result = await checkRateLimit("redis:blocked", { limit: 5, durable: true });
    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBe(30);
    expect(result.backend).toBe("redis");
  });

  it("falls back to the local bucket when Redis is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const result = await checkRateLimit("redis:down", { limit: 2, durable: true });
    expect(result).toMatchObject({ ok: true, remaining: 1, backend: "memory" });
  });

  it("falls back when Redis answers with an error payload or a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: "WRONGTYPE" })
    })));
    expect((await checkRateLimit("redis:error", { limit: 2, durable: true })).backend).toBe("memory");

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    expect((await checkRateLimit("redis:status", { limit: 2, durable: true })).backend).toBe("memory");
  });

  it("falls back when Redis returns no numeric counter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: ["not-a-number", 60_000] })
    })));
    expect((await checkRateLimit("redis:null", { limit: 2, durable: true })).backend).toBe("memory");
  });

  it("uses the window when Redis omits the TTL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: [1] })
    })));
    const result = await checkRateLimit("redis:ttl", { limit: 5, durable: true, windowMs: 20_000 });
    expect(result.backend).toBe("redis");
    expect(result.resetAt).toBe(Date.now() + 20_000);
  });
});

describe("rateLimitResponse", () => {
  it("returns the standard error envelope with the retry hint", () => {
    expect(rateLimitResponse(42)).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Retry after 42s"
      }
    });
  });
});
