import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appBaseUrl, appUrl } from "@/lib/app-url";

const saved = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  APP_BASE_URL: process.env.APP_BASE_URL
};

function restore(key) {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.APP_BASE_URL;
});

afterEach(() => {
  restore("NEXT_PUBLIC_APP_URL");
  restore("APP_BASE_URL");
});

describe("appBaseUrl", () => {
  it("defaults to localhost when neither variable is set", () => {
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it("uses NEXT_PUBLIC_APP_URL for the deployment origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://lets-loom.xyz";
    expect(appBaseUrl()).toBe("https://lets-loom.xyz");
  });

  it("falls back to APP_BASE_URL when the public variable is absent", () => {
    process.env.APP_BASE_URL = "https://lets-loom.xyz";
    expect(appBaseUrl()).toBe("https://lets-loom.xyz");
  });

  it("prefers NEXT_PUBLIC_APP_URL when both are set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://lets-loom.xyz";
    process.env.APP_BASE_URL = "https://old.example";
    expect(appBaseUrl()).toBe("https://lets-loom.xyz");
  });

  it("strips trailing slashes so derived URLs never double up", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000///";
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });
});

describe("appUrl", () => {
  it("joins a rooted path", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://lets-loom.xyz";
    expect(appUrl("/verify/credential/cred_abc")).toBe(
      "https://lets-loom.xyz/verify/credential/cred_abc"
    );
  });

  it("adds the missing leading slash and returns the base for an empty path", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(appUrl("verify/credential/cred_abc")).toBe(
      "http://localhost:3000/verify/credential/cred_abc"
    );
    expect(appUrl()).toBe("http://localhost:3000");
  });
});
