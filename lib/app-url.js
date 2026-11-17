// Single source of truth for this deployment's public origin.
//
// NEXT_PUBLIC_APP_URL is the canonical value (build-time, safe in client
// bundles). APP_BASE_URL is the server-side override used for Auth0; it is a
// fallback here so a deployment that sets only the Auth0 variable still builds
// correct absolute URLs. Local development falls back to localhost.
const DEFAULT_APP_URL = "http://localhost:3000";

export function appBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || DEFAULT_APP_URL;
  return String(raw).trim().replace(/\/+$/, "");
}

export function appUrl(path = "/") {
  const base = appBaseUrl();
  const suffix = String(path || "");
  if (!suffix || suffix === "/") return base;
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}
