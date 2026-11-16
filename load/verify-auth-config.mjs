// Verify (and, with --fix, repair) the OAuth origins registered in Auth0 and
// Supabase for this deployment.
//
// Why this exists: every origin the app can be served from -- the public host,
// its apex, localhost:3000 and 127.0.0.1:3000 -- must be registered in THREE
// places that cannot see each other. A mismatch is not a warning, it is an
// immediate hard failure at the end of a sign-in:
//
//   * Auth0      -> "Callback URL mismatch" (Safari and iOS are the usual
//                   place this is discovered, mid-demo)
//   * Supabase   -> silently falls back to the project's Site URL
//   * GitHub     -> "redirect_uri_mismatch"
//
// GitHub is reported but never written: OAuth App callback URLs have no REST
// API (see https://docs.github.com/en/rest/apps/oauth-applications -- only
// grant/token endpoints exist). That one is a two-field edit in the web UI.
//
// Usage:
//   node load/verify-auth-config.mjs            # report only
//   node load/verify-auth-config.mjs --fix      # append missing origins
//
// `--fix` is APPEND-ONLY. It never removes an origin it did not create: a
// preview deployment or a chapter's custom domain may legitimately be on those
// lists. Removing entries is a human decision.
//
// Required env (checked in the environment, then .env.local, then
// .env.production.local):
//   NEXT_PUBLIC_APP_URL            public origin being deployed
//   APP_BASE_URL                   optional, wins over NEXT_PUBLIC_APP_URL
//   AUTH0_DOMAIN, AUTH0_CLIENT_ID  the application whose allow-lists we check
//   AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET
//                                  M2M app needing read:clients and
//                                  update:clients (only update:clients is
//                                  needed for --fix)
//   NEXT_PUBLIC_SUPABASE_URL       used to derive the project ref
//   SUPABASE_ACCESS_TOKEN          optional personal access token; without it
//                                  the Supabase allow-list cannot be read
//
// Secrets are never printed. Only origins (non-secret) appear in the output.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_PORT = 3000;

/**
 * Load env files without overriding anything already set in the real
 * environment. .env.production.local is read last so a production-only value
 * (for example APP_BASE_URL) is available to an operator script, but an
 * explicit env var always wins.
 */
export function loadEnvFiles(cwd = process.cwd(), files = [".env.local", ".env.production.local"]) {
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        const value = match[2].trim();
        if (value) process.env[match[1]] = value;
      }
    }
  }
}

/** `https://www.example.com/` -> `https://www.example.com` */
export function normalizeOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/**
 * The origin the app is actually served from, plus the apex/www twin.
 *
 * Both are kept on purpose: the production host currently redirects apex to
 * www, and a 308 does NOT satisfy a redirect_uri comparison in either Auth0 or
 * GitHub. Registering only one of them breaks the day the primary flips.
 *
 * A `www.` twin is only invented for a two-label host (`example.com`). A
 * platform host like `project.vercel.app` has three labels and no `www`
 * counterpart, so inventing one there would add a domain that does not resolve.
 */
export function deploymentOrigins(publicUrl) {
  const origin = normalizeOrigin(publicUrl);
  if (!origin) return [];
  const { protocol, hostname } = new URL(origin);
  const origins = [origin];
  if (hostname.startsWith("www.")) {
    origins.push(`${protocol}//${hostname.slice(4)}`);
  } else if (hostname.split(".").length === 2) {
    origins.push(`${protocol}//www.${hostname}`);
  }
  return [...new Set(origins)];
}

/** Local dev and Playwright hosts. Both are real, both are used. */
export function localOrigins(port = LOCAL_PORT) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * Every allow-list this repo needs, derived from configuration rather than
 * hardcoded -- a hardcoded domain is what published the retired Vercel host in
 * canonicals, sitemap entries and the OAuth redirect_uri for weeks.
 *
 * Accepts one origin (`publicUrl`) or several (`publicUrls`) so a single run
 * can cover production and local at once. `extra` accepts comma-separated
 * origins (EXTRA_ALLOWED_ORIGINS) for preview deployments and chapter custom
 * domains.
 */
export function requiredAllowLists({ publicUrl, publicUrls, extra = "" } = {}) {
  const configured = [publicUrl, ...(Array.isArray(publicUrls) ? publicUrls : [])].filter(Boolean);
  const web = [...configured.flatMap((url) => deploymentOrigins(url)), ...localOrigins()];
  const extras = String(extra)
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = [...new Set([...web, ...extras])];

  return {
    auth0Callbacks: origins.map((o) => `${o}/auth/callback`),
    auth0Logout: origins,
    auth0WebOrigins: origins,
    supabaseRedirects: origins.map((o) => `${o}/auth/supabase-callback`),
    githubCallbacks: origins.map((o) => `${o}/api/github/oauth/callback`)
  };
}

/** Entries present in `required` but missing from `current`, order preserved. */
export function diffAllowList(current, required) {
  const have = new Set((current || []).map((v) => String(v).trim().toLowerCase()));
  return (required || []).filter((v) => !have.has(String(v).trim().toLowerCase()));
}

/** Append missing entries. Never removes, never reorders what is already there. */
export function appendMissing(current, required) {
  return [...(current || []), ...diffAllowList(current, required)];
}

function report(label, current, required) {
  const missing = diffAllowList(current, required);
  if (missing.length === 0) {
    console.log(`  ok    ${label} (${required.length} required, ${(current || []).length} registered)`);
    return missing;
  }
  console.log(`  MISS  ${label}: ${missing.length} missing`);
  for (const entry of missing) console.log(`          + ${entry}`);
  return missing;
}

async function auth0Token(domain, clientId, clientSecret) {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 token request failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = await response.json();
  return { token: body.access_token, scope: String(body.scope || "") };
}

function supabaseRef(url) {
  try {
    return new URL(String(url)).hostname.split(".")[0];
  } catch {
    return "";
  }
}

/**
 * Every origin this checkout is configured for: the value in the live
 * environment, the value in .env.local (local dev) and the value in
 * .env.production.local (the deployment). All three must be allow-listed,
 * because all three are origins the app genuinely runs on.
 */
export function collectPublicUrls({ env = process.env, cwd = process.cwd() } = {}) {
  const urls = [env.APP_BASE_URL, env.NEXT_PUBLIC_APP_URL];

  for (const file of [".env.local", ".env.production.local"]) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^(APP_BASE_URL|NEXT_PUBLIC_APP_URL)=(.*)$/);
      if (match) urls.push(match[2].trim());
    }
  }

  return [...new Set(urls.map(normalizeOrigin).filter(Boolean))];
}

async function checkAuth0({ lists, fix }) {
  const domain = String(process.env.AUTH0_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const appId = process.env.AUTH0_CLIENT_ID;
  const m2mId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
  const m2mSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;

  console.log("\nAuth0");
  if (!domain || !appId) {
    console.log("  skip  AUTH0_DOMAIN / AUTH0_CLIENT_ID not set");
    return { gaps: 0, verified: false };
  }
  if (!m2mId || !m2mSecret) {
    console.log("  skip  AUTH0_MANAGEMENT_CLIENT_ID / _SECRET not set");
    return { gaps: 0, verified: false };
  }

  const { token, scope } = await auth0Token(domain, m2mId, m2mSecret);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const read = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(appId)}`, { headers: auth });
  if (read.status === 403) {
    console.log("  BLOCKED  the M2M app cannot read clients.");
    console.log("           granted scopes: " + (scope || "<none>"));
    console.log("           Add read:clients and update:clients: Auth0 Dashboard ->");
    console.log("           Applications -> <M2M app> -> APIs -> Auth0 Management API ->");
    console.log("           Authorized Scopes -> check them -> Update.");
    return { gaps: 0, verified: false };
  }
  if (!read.ok) throw new Error(`Auth0 client read failed (${read.status}): ${(await read.text()).slice(0, 200)}`);

  const client = await read.json();
  const current = {
    callbacks: client.callbacks || [],
    logout: client.allowed_logout_urls || [],
    webOrigins: client.web_origins || []
  };
  console.log(`  app     ${client.name} (${client.app_type || "unknown type"})`);

  const gaps =
    report("callbacks", current.callbacks, lists.auth0Callbacks).length +
    report("logout URLs", current.logout, lists.auth0Logout).length +
    report("web origins", current.webOrigins, lists.auth0WebOrigins).length;

  if (gaps > 0 && fix) {
    const patch = {
      callbacks: appendMissing(current.callbacks, lists.auth0Callbacks),
      allowed_logout_urls: appendMissing(current.logout, lists.auth0Logout),
      web_origins: appendMissing(current.webOrigins, lists.auth0WebOrigins)
    };
    const write = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(appId)}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify(patch)
    });
    if (!write.ok) {
      console.log(`  FAIL  Auth0 PATCH ${write.status}: ${(await write.text()).slice(0, 200)}`);
      return { gaps, verified: true, fixed: false };
    }
    console.log("  fixed Auth0 allow-lists (appended only)");
    return { gaps: 0, verified: true, fixed: true };
  }

  return { gaps, verified: true, fixed: false };
}

async function checkSupabase({ lists, fix }) {
  console.log("\nSupabase");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ref = supabaseRef(url);
  const token = process.env.SUPABASE_ACCESS_TOKEN;

  if (!ref) {
    console.log("  skip  NEXT_PUBLIC_SUPABASE_URL not set");
    return { gaps: 0, verified: false };
  }
  if (!token) {
    console.log("  skip  SUPABASE_ACCESS_TOKEN not set -- cannot read the Redirect URLs list");
    console.log("        The public /auth/v1/settings endpoint does not expose it, and");
    console.log("        /auth/v1/authorize echoes any redirect_to it is given, including");
    console.log("        an unregistered one, so it cannot be used as a probe.");
    return { gaps: 0, verified: false };
  }

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const read = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, { headers: auth });
  if (!read.ok) {
    console.log(`  FAIL  Supabase config read ${read.status}: ${(await read.text()).slice(0, 200)}`);
    return { gaps: 0, verified: false };
  }

  const config = await read.json();
  const current = String(config.uri_allow_list || "")
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

  const gaps = report("redirect URLs", current, lists.supabaseRedirects).length;

  if (gaps > 0 && fix) {
    const merged = appendMissing(current, lists.supabaseRedirects).join(",");
    const write = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ uri_allow_list: merged })
    });
    if (!write.ok) {
      console.log(`  FAIL  Supabase PATCH ${write.status}: ${(await write.text()).slice(0, 200)}`);
      return { gaps, verified: true, fixed: false };
    }
    console.log("  fixed Supabase redirect URLs (appended only)");
    return { gaps: 0, verified: true, fixed: true };
  }

  return { gaps, verified: true, fixed: false };
}

function checkGitHub({ lists }) {
  console.log("\nGitHub");
  console.log("  info  no API can read or write an OAuth App's callback URL:");
  console.log("        https://docs.github.com/en/rest/apps/oauth-applications lists only");
  console.log("        grant/token endpoints. Set this in the web UI:");
  console.log("        https://github.com/settings/developers -> OAuth Apps -> <app>");
  for (const callback of lists.githubCallbacks) {
    console.log(`          callback: ${callback}`);
  }
  console.log("  note  GitHub OAuth Apps are LOCAL-ONLY: use http://localhost:3000/... for");
  console.log("        dev and the public host for production. Two apps, not one.");
  // `manual: true` -- no API exists, so this surface can never be proven by
  // this script. It must not degrade the exit code to "unreadable", or a run
  // with Auth0 and Supabase fully green would still report exit 2 forever.
  return { gaps: 0, verified: false, manual: true };
}

/**
 * Exit-code contract, kept separate from the reporting so it can be tested:
 *   1 -> at least one origin is missing (actionable)
 *   2 -> something could not be read (unknown, not proven)
 *   0 -> every readable surface is complete
 *
 * `manual` results (GitHub) are excluded from the "unreadable" count on
 * purpose: they are unverifiable by design, not unverified by circumstance.
 */
export function exitCodeFor(results = []) {
  const gaps = results.reduce((sum, r) => sum + (r.gaps || 0), 0);
  if (gaps > 0) return 1;
  const unreadable = results.filter((r) => !r.verified && !r.manual).length;
  return unreadable > 0 ? 2 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const fix = argv.includes("--fix");
  const publicUrls = collectPublicUrls();

  const lists = requiredAllowLists({
    publicUrls,
    extra: process.env.EXTRA_ALLOWED_ORIGINS || ""
  });

  console.log("OAuth origin verification");
  for (const origin of publicUrls) console.log(`  origin  ${origin}`);
  if (publicUrls.length === 0) console.log("  origin  <unset>");

  const results = [
    await checkAuth0({ lists, fix }),
    await checkSupabase({ lists, fix }),
    checkGitHub({ lists })
  ];

  const gaps = results.reduce((sum, r) => sum + (r.gaps || 0), 0);
  const unreadable = results.filter((r) => !r.verified && !r.manual).length;
  const manual = results.filter((r) => r.manual).length;

  console.log("");
  const code = exitCodeFor(results);
  if (code === 1) {
    console.log(`${gaps} missing origin(s). Re-run with --fix to append them, or edit the dashboards.`);
  } else if (code === 2) {
    console.log(`${unreadable} of ${results.length} surfaces could not be read (see above). Nothing is known to be wrong, but nothing is proven either.`);
  } else {
    console.log("All allow-lists that can be read are complete.");
  }
  if (manual > 0) {
    console.log(`${manual} surface(s) must be checked by hand every time: see the callbacks listed above.`);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFiles();
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
