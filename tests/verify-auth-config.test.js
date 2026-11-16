import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendMissing,
  collectPublicUrls,
  deploymentOrigins,
  diffAllowList,
  exitCodeFor,
  localOrigins,
  normalizeOrigin,
  requiredAllowLists
} from "@/load/verify-auth-config.mjs";

// These helpers decide which OAuth origins get registered in Auth0 and
// Supabase. A gap here surfaces as "Callback URL mismatch" after a successful
// password entry -- the worst possible moment -- so the apex/www pairing and
// the append-only merge are worth pinning down.

describe("normalizeOrigin", () => {
  it("strips trailing slashes and keeps the origin", () => {
    expect(normalizeOrigin("https://www.lets-loom.xyz/")).toBe("https://www.lets-loom.xyz");
    expect(normalizeOrigin("https://www.lets-loom.xyz///")).toBe("https://www.lets-loom.xyz");
  });

  it("returns an empty string for a missing or unparsable value", () => {
    expect(normalizeOrigin("")).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
    expect(normalizeOrigin("not a url")).toBe("");
  });

  it("drops a path so a callback path cannot leak into an origin list", () => {
    expect(normalizeOrigin("https://loom.example/auth/callback")).toBe("https://loom.example");
  });
});

describe("deploymentOrigins", () => {
  it("returns the public origin and its apex twin", () => {
    expect(deploymentOrigins("https://www.lets-loom.xyz")).toEqual([
      "https://www.lets-loom.xyz",
      "https://lets-loom.xyz"
    ]);
  });

  it("adds the www twin when the configured origin is the apex", () => {
    expect(deploymentOrigins("https://lets-loom.xyz")).toEqual([
      "https://lets-loom.xyz",
      "https://www.lets-loom.xyz"
    ]);
  });

  it("does not invent a www twin for a bare host", () => {
    expect(deploymentOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
  });

  it("does not invent a www twin for a platform host with no such record", () => {
    expect(deploymentOrigins("https://loom-self-omega.vercel.app")).toEqual([
      "https://loom-self-omega.vercel.app"
    ]);
  });

  it("returns nothing when no origin is configured", () => {
    expect(deploymentOrigins("")).toEqual([]);
  });
});

describe("requiredAllowLists", () => {
  const lists = requiredAllowLists({ publicUrl: "https://www.lets-loom.xyz" });

  it("covers every origin the app can be served from", () => {
    expect(lists.auth0Callbacks).toEqual([
      "https://www.lets-loom.xyz/auth/callback",
      "https://lets-loom.xyz/auth/callback",
      "http://localhost:3000/auth/callback",
      "http://127.0.0.1:3000/auth/callback"
    ]);
  });

  it("uses the Supabase path for Supabase and the GitHub path for GitHub", () => {
    expect(lists.supabaseRedirects).toContain("https://www.lets-loom.xyz/auth/supabase-callback");
    // Auth0 owns /auth/callback now; Supabase's exchange is a different path.
    expect(lists.supabaseRedirects).not.toContain("https://www.lets-loom.xyz/auth/callback");
    expect(lists.githubCallbacks).toContain("https://www.lets-loom.xyz/api/github/oauth/callback");
  });

  it("keeps 127.0.0.1 for the Playwright project", () => {
    expect(lists.auth0WebOrigins).toContain("http://127.0.0.1:3000");
    expect(lists.auth0WebOrigins).toEqual(lists.auth0Logout);
  });

  it("merges EXTRA_ALLOWED_ORIGINS for preview deployments", () => {
    const extended = requiredAllowLists({
      publicUrl: "https://www.lets-loom.xyz",
      extra: "https://preview-abc.vercel.app, https://chapter.example"
    });
    expect(extended.auth0Callbacks).toContain("https://preview-abc.vercel.app/auth/callback");
    expect(extended.auth0Callbacks).toContain("https://chapter.example/auth/callback");
  });

  it("de-duplicates and ignores blank entries", () => {
    const dupes = requiredAllowLists({ publicUrl: "https://www.lets-loom.xyz", extra: "," });
    expect(new Set(dupes.auth0Logout).size).toBe(dupes.auth0Logout.length);
  });
});

describe("diffAllowList", () => {
  it("reports only what is missing, in the required order", () => {
    const current = ["https://www.lets-loom.xyz/auth/callback"];
    const required = ["https://lets-loom.xyz/auth/callback", "https://www.lets-loom.xyz/auth/callback"];
    expect(diffAllowList(current, required)).toEqual(["https://lets-loom.xyz/auth/callback"]);
  });

  it("ignores case and surrounding whitespace", () => {
    const current = ["  HTTPS://WWW.LETS-LOOM.XYZ/AUTH/CALLBACK "];
    expect(diffAllowList(current, ["https://www.lets-loom.xyz/auth/callback"])).toEqual([]);
  });

  it("does not throw on an empty or absent list", () => {
    expect(diffAllowList(undefined, ["https://x.example"])).toEqual(["https://x.example"]);
    expect(diffAllowList([], [])).toEqual([]);
  });
});

describe("appendMissing", () => {
  it("appends without removing or reordering existing entries", () => {
    const current = ["https://www.lets-loom.xyz/auth/callback", "https://preview.example/auth/callback"];
    const merged = appendMissing(current, [
      "https://www.lets-loom.xyz/auth/callback",
      "https://lets-loom.xyz/auth/callback"
    ]);
    expect(merged).toEqual([
      "https://www.lets-loom.xyz/auth/callback",
      "https://preview.example/auth/callback",
      "https://lets-loom.xyz/auth/callback"
    ]);
  });

  it("is idempotent", () => {
    const required = ["https://www.lets-loom.xyz/auth/callback", "http://localhost:3000/auth/callback"];
    const once = appendMissing([], required);
    expect(appendMissing(once, required)).toEqual(once);
  });
});

describe("localOrigins", () => {
  it("returns both hosts the dev server answers on", () => {
    expect(localOrigins()).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });
});

describe("collectPublicUrls", () => {
  function withEnvFiles(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-config-"));
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return dir;
  }

  it("reads both the local and the production origin", () => {
    const cwd = withEnvFiles({
      ".env.local": "NEXT_PUBLIC_APP_URL=http://localhost:3000\n",
      ".env.production.local": "NEXT_PUBLIC_APP_URL=https://www.lets-loom.xyz\n"
    });
    expect(collectPublicUrls({ env: {}, cwd }).sort()).toEqual([
      "http://localhost:3000",
      "https://www.lets-loom.xyz"
    ]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("lets an explicit environment value win without losing the file values", () => {
    const cwd = withEnvFiles({ ".env.production.local": "NEXT_PUBLIC_APP_URL=https://www.lets-loom.xyz\n" });
    const urls = collectPublicUrls({ env: { APP_BASE_URL: "https://preview.example" }, cwd });
    expect(urls).toContain("https://preview.example");
    expect(urls).toContain("https://www.lets-loom.xyz");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("survives a missing env file", () => {
    const cwd = withEnvFiles({});
    expect(collectPublicUrls({ env: { NEXT_PUBLIC_APP_URL: "https://loom.example/" }, cwd })).toEqual([
      "https://loom.example"
    ]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("requiredAllowLists with several origins", () => {
  it("unions production and local in one list", () => {
    const lists = requiredAllowLists({ publicUrls: ["https://www.lets-loom.xyz", "http://localhost:3000"] });
    expect(lists.auth0Callbacks).toEqual([
      "https://www.lets-loom.xyz/auth/callback",
      "https://lets-loom.xyz/auth/callback",
      "http://localhost:3000/auth/callback",
      "http://127.0.0.1:3000/auth/callback"
    ]);
  });
});

describe("exitCodeFor", () => {
  const readable = { gaps: 0, verified: true };
  const github = { gaps: 0, verified: false, manual: true };
  const blocked = { gaps: 0, verified: false };

  it("returns 0 when every readable surface is complete", () => {
    expect(exitCodeFor([readable, readable, github])).toBe(0);
  });

  it("returns 1 when any origin is missing, even if one surface is unreadable", () => {
    expect(exitCodeFor([{ gaps: 2, verified: true }, blocked])).toBe(1);
  });

  it("returns 2 when a surface could not be read", () => {
    expect(exitCodeFor([readable, blocked])).toBe(2);
  });

  it("never returns 2 solely because GitHub cannot be automated", () => {
    // GitHub is unverifiable by design (no API exists), so it is flagged
    // `manual`. If it counted as "unreadable", a fully green run could never
    // exit 0. Same shape without the flag must still be 2 -- that is the whole
    // distinction.
    const sameShapeWithoutFlag = { gaps: 0, verified: false };
    expect(exitCodeFor([readable, sameShapeWithoutFlag])).toBe(2);
    expect(exitCodeFor([readable, github])).toBe(0);
  });

  it("treats an empty result set as success", () => {
    expect(exitCodeFor([])).toBe(0);
  });
});
