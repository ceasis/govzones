#!/usr/bin/env node
/**
 * Browser journey against the local dev stack (or the temporary preview: pass its web origin), at phone width:
 * choose a score → sign in (dev provider) → create wallet + recovery key → enroll →
 * queued anonymous submission with in-browser (Web Worker) Semaphore proof → My ratings → direct re-rate path.
 */
import { chromium } from "playwright-core";

const WEB = process.argv[2] ?? "http://govzones.localhost:5173";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
const voteRequests = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (/\/\/(vote\.|govzones-ballot-)/.test(r.url())) voteRequests.push({ url: r.url(), headers: r.headers() });
});
const step = (s) => console.log(`• ${s}`);
async function diag(err) {
  console.log("FAILED:", err.message.split("\n")[0]);
  console.log("url:", page.url());
  console.log("page text:", (await page.locator("main").innerText().catch(() => "")).slice(0, 1200));
  console.log("console errors:", errors.slice(-5));
  await page.screenshot({ path: "test-results/browser-failure.png", fullPage: true }).catch(() => undefined);
  process.exit(1);
}
const t0 = Date.now();

step("open an agency page and choose a score");
await page.goto(`${WEB}/ph/agency/bureau-of-internal-revenue`, { waitUntil: "networkidle" });
await page.locator("label", { hasText: /^7$/ }).click();
await page.getByRole("button", { name: "Submit rating" }).click();
await page.waitForURL(/\/sign-in$/);

step("sign in with an e-mailed code (local: the code is shown on the page)");
await page.fill("#email", `browser-${Date.now().toString(36)}@example.test`);
await page.getByRole("button", { name: "Send code" }).click();
const devCode = (await page.locator("[data-dev-code]").textContent({ timeout: 20_000 })).trim();
await page.fill("#code", devCode);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(/\/me\/wallet\?continue=1/);

step("create wallet: explanation → recovery key → confirm");
await page.getByRole("button", { name: "Continue" }).click();
const key = (await page.getByLabel("Recovery key", { exact: true }).textContent()).trim();
if (!/^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/.test(key)) throw new Error("bad recovery key format: " + key);
await page.getByLabel("I have saved my recovery key somewhere safe.").check();
await page.fill("#confirm-key", key.slice(-4));
await page.getByRole("button", { name: "Continue" }).click();

step("register credential (public commitment only) + encrypted backup");
await page.getByRole("button", { name: "Activate voting pass" }).click();
await page.waitForURL(/\/ph\/agency\/bureau-of-internal-revenue/, { timeout: 60_000 }).catch(diag);

step("queued rating is submitted anonymously (in-browser proof, jittered delay)");
await page.getByText(/You rated this 7 \/ 10/).waitFor({ timeout: 180_000 }).catch(diag);
console.log(`  submitted after ${Math.round((Date.now() - t0) / 1000)} s total`);

const leaked = voteRequests.filter((r) => r.headers.cookie || r.headers.authorization || r.headers.referer);
if (leaked.length) throw new Error("ballot request carried cookie/authorization/referer: " + JSON.stringify(leaked[0].headers));
console.log(`  ${voteRequests.length} requests to the vote host, none with cookies, Authorization or Referer`);

step("My ratings is rebuilt from the local wallet");
await page.goto(`${WEB}/me/ratings`, { waitUntil: "networkidle" });
await page.getByText("Bureau of Internal Revenue").first().waitFor();
await page.getByRole("button", { name: "Check receipts" }).click();
await page.getByText("Receipt check: Received").waitFor({ timeout: 20_000 });

step("direct rating on a second agency (credential already active)");
await page.goto(`${WEB}/ph/agency/land-transportation-office`, { waitUntil: "networkidle" });
await page.locator("label", { hasText: /^9$/ }).click();
const tProof = Date.now();
await page.getByRole("button", { name: "Submit rating" }).click();
await page.getByText("Your rating was submitted.").waitFor({ timeout: 120_000 }).catch(diag);
console.log(`  proof + submission took ${((Date.now() - tProof) / 1000).toFixed(1)} s`);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) throw new Error("horizontal overflow after rating");

await page.screenshot({ path: "test-results/browser-rated.png", fullPage: true });
await browser.close();
const relevant = errors.filter((e) => !/favicon|DevTools|Download the React/.test(e));
if (relevant.length) {
  console.log("console errors:\n  " + relevant.join("\n  "));
  process.exit(1);
}
console.log("\nBrowser journey passed.");
