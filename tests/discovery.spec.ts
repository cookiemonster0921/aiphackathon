import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const targetUrl = process.env.TARGET_URL!;
const goal = process.env.QA_GOAL || "Explore the website from a user perspective";
const depth = process.env.QA_DEPTH || "normal";

const outDir = path.join(process.cwd(), "site");
const screenshotDir = path.join(outDir, "screenshots");

fs.mkdirSync(screenshotDir, { recursive: true });

const visited = new Set<string>();
const rows: Array<{
  step: number;
  action: string;
  url: string;
  status: string;
  notes: string;
  screenshot: string;
}> = [];

function safeName(text: string) {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
}

async function capture(page: Page, action: string, status = "passed", notes = "") {
  const step = rows.length + 1;
  const file = `${String(step).padStart(2, "0")}-${safeName(action)}.png`;
  const filePath = path.join(screenshotDir, file);

  await page.screenshot({ path: filePath, fullPage: true });

  rows.push({
    step,
    action,
    url: page.url(),
    status,
    notes,
    screenshot: `screenshots/${file}`
  });
}

function writeReport() {
  const tableRows = rows.map((r) => `
    <tr>
      <td>${r.step}</td>
      <td>${r.status}</td>
      <td>${escapeHtml(r.action)}</td>
      <td><a href="${r.url}">${escapeHtml(r.url)}</a></td>
      <td>${escapeHtml(r.notes)}</td>
      <td><img src="${r.screenshot}" style="max-width:360px;border-radius:8px;border:1px solid #ddd;" /></td>
    </tr>
  `).join("");

  fs.writeFileSync(path.join(outDir, "index.html"), `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>QA Discovery Report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; background: #fafafa; color: #111; }
    h1 { margin-bottom: 8px; }
    .meta { color: #555; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { padding: 12px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
    th { text-align: left; background: #f3f3f3; position: sticky; top: 0; }
    td { word-break: break-word; }
    img { cursor: zoom-in; }
  </style>
</head>
<body>
  <h1>QA Discovery Report</h1>
  <div class="meta">
    <strong>Target:</strong> ${escapeHtml(targetUrl)}<br />
    <strong>Goal:</strong> ${escapeHtml(goal)}<br />
    <strong>Depth:</strong> ${escapeHtml(depth)}
  </div>

  <table>
    <thead>
      <tr>
        <th>Step</th>
        <th>Status</th>
        <th>Action</th>
        <th>URL</th>
        <th>Notes</th>
        <th>Screenshot</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  <script>
    document.querySelectorAll("img").forEach(img => {
      img.onclick = () => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;";
        overlay.innerHTML = '<img src="' + img.src + '" style="max-width:95vw;max-height:92vh;object-fit:contain;border-radius:10px;background:white;" />';
        overlay.onclick = () => overlay.remove();
        document.body.appendChild(overlay);
      };
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") document.querySelectorAll("body > div[style*='position:fixed']").forEach(el => el.remove());
    });
  </script>
</body>
</html>
`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]!));
}

test("browser-first discovery workflow", async ({ page }) => {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  page.on("response", (res) => {
    if (res.status() >= 500) networkErrors.push(`${res.status()} ${res.url()}`);
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await capture(page, "Open target URL");

    await expect(page.locator("body")).toBeVisible();
    await capture(page, "Verify body rendered");

    const title = await page.title();
    await capture(page, "Capture page title", "passed", `Title: ${title}`);

    const linkLimit = depth === "smoke" ? 3 : depth === "deep" ? 12 : 6;

    const links = await page.locator("a[href]").evaluateAll((els) =>
      els.map((a: any) => ({
        text: (a.innerText || a.textContent || "").trim(),
        href: a.href
      }))
    );

    for (const link of links) {
      if (visited.size >= linkLimit) break;
      if (!link.href.startsWith(new URL(targetUrl).origin)) continue;
      if (visited.has(link.href)) continue;

      visited.add(link.href);

      await page.goto(link.href, { waitUntil: "domcontentloaded" });
      await capture(page, `Visit link: ${link.text || link.href}`);
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const buttons = await page.locator("button, input[type='submit'], [role='button']").count();
    await capture(page, "Inspect clickable UI", "passed", `Found ${buttons} clickable elements`);

    const inputs = await page.locator("input, textarea, select").count();
    await capture(page, "Inspect form fields", "passed", `Found ${inputs} fields`);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);

    if (scrollWidth > viewportWidth + 5) {
      await capture(page, "Check horizontal overflow", "warning", `scrollWidth=${scrollWidth}, viewportWidth=${viewportWidth}`);
    } else {
      await capture(page, "Check horizontal overflow", "passed", "No horizontal overflow detected");
    }

    if (consoleErrors.length) {
      await capture(page, "Console error check", "failed", consoleErrors.join("; "));
    } else {
      await capture(page, "Console error check", "passed", "No console errors detected");
    }

    if (networkErrors.length) {
      await capture(page, "Network error check", "failed", networkErrors.join("; "));
    } else {
      await capture(page, "Network error check", "passed", "No 500-level responses detected");
    }
  } finally {
    writeReport();
  }
});
