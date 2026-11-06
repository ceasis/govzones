#!/usr/bin/env node
/**
 * AC-10 layout check: at 320/360/375/390/414/430 CSS px no page may overflow horizontally.
 * Asserts document.documentElement.scrollWidth <= window.innerWidth and names offending elements.
 * Uses the locally installed Google Chrome via playwright-core. Screenshots go to test-results/.
 *
 * Usage: node scripts/check-layout.mjs [baseUrl]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://govzones.localhost:5173";
const WIDTHS = [320, 360, 375, 390, 414, 430];
const PAGES = [
  "/ph",
  "/ph/search?q=lto",
  "/ph/search?scope=local&region=r-07",
  "/ph/rankings",
  "/ph/rankings?kind=most&type=mixed",
  "/ph/places",
  "/ph/places/r-ncr",
  "/ph/places/c-caloocan",
  "/ph/agency/land-transportation-office",
  "/ph/agency/department-of-foreign-affairs",
  "/ph/office/dfa-office-of-consular-affairs-aseana",
  "/ph/agency/city-government-of-quezon-city",
  "/ph/methodology",
  "/ph/transparency",
  "/ph/suggest",
  "/sign-in",
  "/me/wallet",
  "/me/ratings",
  "/me/account",
  "/about",
  "/privacy",
  "/policies/appeals",
  "/countries",
];

mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let failures = 0;
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const path of PAGES) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const vw = window.innerWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 0.5 && getComputedStyle(el).position !== "fixed") {
          offenders.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].slice(0, 3).join(".")} right=${Math.round(r.right)}`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, offenders: offenders.slice(0, 5) };
    });
    const ok = result.scrollWidth <= result.innerWidth;
    if (!ok) {
      failures++;
      console.log(`✗ ${width}px ${path}: scrollWidth ${result.scrollWidth} > ${result.innerWidth}\n    ${result.offenders.join("\n    ")}`);
    }
    if (width === 320) await page.screenshot({ path: `test-results/320${path.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: true });
  }
  await ctx.close();
  console.log(`${width}px: checked ${PAGES.length} pages`);
}
const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const dp = await desktop.newPage();
for (const path of ["/ph", "/ph/agency/land-transportation-office", "/ph/rankings"]) {
  await dp.goto(BASE + path, { waitUntil: "networkidle" });
  await dp.screenshot({ path: `test-results/1280${path.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: true });
}
await browser.close();
console.log(failures ? `\n${failures} overflow failure(s)` : "\nNo horizontal overflow at any tested width.");
process.exit(failures ? 1 : 0);
