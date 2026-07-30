// spike/monaco/check.spec.ts — THROWAWAY spike headless check (P0 spike C).
// Standalone script (not part of the tests/ suite, not run by playwright.config.ts's testDir) —
// drives spike/monaco/serve.ts with a plain chromium.launch() and fails on ANY console error,
// especially worker load failures, which is the classic self-host-Monaco-without-a-bundler trap.
// Run: bun spike/monaco/check.spec.ts   (serve.ts must be running on :4910 first)
import { chromium } from "@playwright/test";

const URL = "http://localhost:4910";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("requestfailed", (req) => {
    consoleErrors.push(`requestfailed: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  await page.goto(URL, { waitUntil: "load" });

  // Wait for Monaco's own ready flag (set after require(['vs/editor/editor.main']) resolves),
  // not just the DOM node — proves the AMD module graph + worker bootstrap actually completed.
  await page.waitForFunction(() => (window as any).__monacoReady === true, null, { timeout: 15_000 });
  await page.waitForSelector(".monaco-editor", { timeout: 15_000 });

  // Give the TS language worker a beat to spin up + report back (it's created lazily on first
  // model access) — this is where a broken worker URL would surface as a console error.
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => (window as any).editor.getValue());
  const visibleText = await page.locator(".view-lines").innerText();

  const checks: Array<[string, boolean]> = [
    ["monaco-editor DOM present", await page.locator(".monaco-editor").count() > 0],
    ["editor model has sample text", text.includes("test('user can log in @smoke'")],
    ["sample text is visibly rendered", visibleText.includes("login('admin')")],
    ["no console errors", consoleErrors.length === 0],
    ["no uncaught page errors", pageErrors.length === 0],
  ];

  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) pass = false;
  }
  if (consoleErrors.length) {
    console.log("\nConsole errors:");
    consoleErrors.forEach((e) => console.log("  " + e));
  }
  if (pageErrors.length) {
    console.log("\nPage errors:");
    pageErrors.forEach((e) => console.log("  " + e));
  }

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
