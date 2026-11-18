import { chromium } from "playwright";

const base = "http://localhost:3000";
const email = process.env.LOOM_EMAIL;
const password = process.env.LOOM_PW;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE ERROR:", m.text()); });

await page.goto(`${base}/login?redirect=/student/github`, { waitUntil: "domcontentloaded" });
await page.fill("#email", email);
await page.fill("#password", password);
await page.click('button[type="submit"]');
await page.waitForURL(/\/student\/github/, { timeout: 30000 });
await page.waitForTimeout(1500);

console.log("URL:", page.url());
const body = await page.locator("body").innerText();
console.log("has 'Repositories GitHub confirmed':", body.includes("Repositories GitHub confirmed"));
console.log("has 'Verify repositories':", body.includes("Verify repositories"));
const grants = await page.locator('a[href^="https://github.com/demonstrikkk/"]').count();
console.log("grant-ish github links:", grants);
const sectionText = await page.locator("section.wss").filter({ hasText: "Repositories GitHub confirmed" }).innerText();
console.log("SECTION TEXT:\n" + sectionText.slice(0, 1200));

const btn = page.getByRole("button", { name: "Verify repositories" });
console.log("verify button count:", await btn.count());
if (await btn.count()) {
  await btn.first().click();
  await page.waitForTimeout(4000);
  console.log("AFTER CLICK:\n" + (await page.locator("section.wss").filter({ hasText: "Repositories GitHub confirmed" }).innerText()).slice(0, 2000));
}

await page.screenshot({ path: "C:/Users/asus/AppData/Local/Temp/opencode/gh-page.png", fullPage: true });
console.log("screenshot saved");
await browser.close();
