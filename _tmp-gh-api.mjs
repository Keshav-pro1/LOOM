import { chromium } from "playwright";

const base = "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/login?redirect=/student/github`, { waitUntil: "domcontentloaded" });
await page.fill("#email", process.env.LOOM_EMAIL);
await page.fill("#password", process.env.LOOM_PW);
await page.click('button[type="submit"]');
await page.waitForURL((u) => u.pathname === "/student/github", { timeout: 60000 });
await page.waitForSelector("main", { timeout: 30000 });
await page.waitForTimeout(1000);

const result = await page.evaluate(async () => {
  const out = {};
  const t0 = performance.now();
  const r = await fetch("/api/github/repos?page=1");
  const body = await r.json();
  out.repos = { status: r.status, ms: Math.round(performance.now() - t0), ok: body.ok, count: body.data?.repos?.length, hasMore: body.data?.hasMore, error: body.error?.code };
  const t1 = performance.now();
  const r2 = await fetch("/api/github/repos?page=2");
  const body2 = await r2.json();
  out.repos2 = { status: r2.status, ms: Math.round(performance.now() - t1), ok: body2.ok, count: body2.data?.repos?.length, hasMore: body2.data?.hasMore, first: body2.data?.repos?.[0]?.fullName };
  const t2 = performance.now();
  const r3 = await fetch("/api/practice/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body3 = await r3.json();
  out.practice = { status: r3.status, ms: Math.round(performance.now() - t2), ok: body3.ok, message: body3.data?.message, error: body3.error?.code };
  return out;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
