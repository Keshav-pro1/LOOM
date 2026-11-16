const { test: setup, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { AUTH_STATE_FILE } = require("./auth-state");

// The suite's only real sign-in, run once by the `setup` project before the
// chromium and mobile projects (see playwright.config.js). See ./auth-state.js
// for why the specs share a session instead of each logging in.
//
// Skips itself when credentials are absent, exactly like the specs it serves, so
// a clone without .env.local still runs every unauthenticated test.
const EMAIL = process.env.E2E_LOGIN_EMAIL;
const PASSWORD = process.env.E2E_LOGIN_PASSWORD;

setup.skip(!EMAIL || !PASSWORD, "set E2E_LOGIN_EMAIL / E2E_LOGIN_PASSWORD to create the shared session");
setup.setTimeout(120_000);

setup("sign in once and save the shared session", async ({ page }) => {
  const clientErrors = [];
  page.on("pageerror", (error) => clientErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") clientErrors.push(`console: ${message.text()}`);
  });

  await page.goto("/login");
  // Wait for hydration before submitting: a click that lands before React
  // attaches the form's onSubmit handler makes the browser perform a native
  // GET /login? instead of calling /api/auth/login, which looks exactly like a
  // rejected sign-in. Production builds hydrate fast; a dev server does not.
  await page.waitForLoadState("networkidle").catch(() => {});
  try {
    await page.waitForFunction(
      () => {
        const form = document.querySelector("form");
        return form && Object.keys(form).some((key) => key.startsWith("__reactProps$"));
      },
      undefined,
      { timeout: 30_000 }
    );
  } catch {
    throw new Error(`Login form did not hydrate. ${clientErrors.join(" | ") || "No client errors reported."}`);
  }
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/auth/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]')
  ]);
  expect(loginResponse.status(), "POST /api/auth/login").toBe(200);
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  // Capture the state only after an authenticated API call succeeds: the first
  // dashboard render fires /api/profile and /api/notifications from the client,
  // and if those race the cookie write every later spec inherits a half-valid
  // session and reports false failures.
  //
  // The probe runs inside the page, not via `page.request`, because the session
  // cookie is `Secure` in a production build and Playwright's APIRequestContext
  // will not send Secure cookies over the suite's HTTP origin.
  const probeStatus = await page.evaluate(() => fetch("/api/profile").then((r) => r.status));
  expect(probeStatus, "session is usable after sign-in").toBe(200);

  fs.mkdirSync(path.dirname(AUTH_STATE_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_FILE });
});
