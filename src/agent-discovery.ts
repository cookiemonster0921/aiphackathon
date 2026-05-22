import { chromium, Page } from "@playwright/test";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";

const targetUrl = requiredEnv("TARGET_URL");
const goal = process.env.QA_GOAL || "Test the website like a real user.";
const maxSteps = Number(process.env.MAX_STEPS || 12);
const apiKey = requiredEnv("GEMINI_API_KEY");

const ai = new GoogleGenAI({ apiKey });

const outDir = path.join(process.cwd(), "site");
const screenshotDir = path.join(outDir, "screenshots");
fs.mkdirSync(screenshotDir, { recursive: true });

type AgentAction =
  | { action: "goto"; url: string; reason: string }
  | { action: "click"; selector: string; reason: string }
  | { action: "fill"; selector: string; value: string; reason: string }
  | { action: "press"; selector: string; key: string; reason: string }
  | { action: "wait"; ms: number; reason: string }
  | { action: "finish"; verdict: "pass" | "partial" | "fail" | "uncertain"; reason: string };

type StepRecord = {
  step: number;
  action: string;
  reason: string;
  url: string;
  status: "passed" | "failed" | "warning";
  notes: string;
  screenshot: string;
};

const rows: StepRecord[] = [];
const consoleErrors: string[] = [];
const networkErrors: string[] = [];

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function safeName(text: string) {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 70);
}

async function capture(page: Page, action: string, reason: string, status: StepRecord["status"], notes = "") {
  const step = rows.length + 1;
  const file = `${String(step).padStart(2, "0")}-${safeName(action)}.png`;
  const filePath = path.join(screenshotDir, file);

  await page.screenshot({ path: filePath, fullPage: true });

  rows.push({
    step,
    action,
    reason,
    url: page.url(),
    status,
    notes,
    screenshot: `screenshots/${file}`
  });
}

async function getPageSnapshot(page: Page) {
  const title = await page.title().catch(() => "");
  const url = page.url();

  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const clippedText = text.replace(/\s+/g, " ").slice(0, 5000);

  const elements = await page.locator("a, button, input, textarea, select, [role='button']").evaluateAll((els) =>
    els.slice(0, 80).map((el: any, index) => ({
      index,
      tag: el.tagName?.toLowerCase(),
      role: el.getAttribute("role"),
      text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 120),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.id,
      testId: el.getAttribute("data-testid"),
      href: el.href,
      selectorHint:
        el.getAttribute("data-testid")
          ? `[data-testid="${el.getAttribute("data-testid")}"]`
          : el.id
            ? `#${el.id}`
            : undefined
    }))
  ).catch(() => []);

  return {
    title,
    url,
    visibleText: clippedText,
    interactiveElements: elements,
    recentConsoleErrors: consoleErrors.slice(-5),
    recentNetworkErrors: networkErrors.slice(-5)
  };
}

async function askGemini(snapshot: unknown, history: StepRecord[]): Promise<AgentAction> {
  const prompt = `
You are a UX/UI QA agent controlling a browser.

Goal:
${goal}

You must test the site like a real user.

Return ONLY valid JSON. No markdown.

Allowed actions:
1. {"action":"goto","url":"...","reason":"..."}
2. {"action":"click","selector":"...","reason":"..."}
3. {"action":"fill","selector":"...","value":"...","reason":"..."}
4. {"action":"press","selector":"...","key":"Enter","reason":"..."}
5. {"action":"wait","ms":1000,"reason":"..."}
6. {"action":"finish","verdict":"pass|partial|fail|uncertain","reason":"..."}

Rules:
- Prefer stable selectors from data-testid, id, label, visible text, role.
- Do not use destructive actions on real production websites.
- Do not attempt bypassing login, CAPTCHA, paywalls, or anti-bot systems.
- Test navigation, forms, buttons, console/network errors, and layout issues.
- If enough evidence is gathered, finish.
- If a flow is broken, capture evidence then finish with partial/fail.

Current page snapshot:
${JSON.stringify(snapshot, null, 2)}

Previous steps:
${JSON.stringify(history.slice(-8), null, 2)}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt
  });

  const text = response.text?.trim() || "{}";
  const jsonText = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  return JSON.parse(jsonText) as AgentAction;
}

async function runAction(page: Page, action: AgentAction) {
  switch (action.action) {
    case "goto":
      await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "click":
      await page.locator(action.selector).first().click({ timeout: 10000 });
      return;
    case "fill":
      await page.locator(action.selector).first().fill(action.value, { timeout: 10000 });
      return;
    case "press":
      await page.locator(action.selector).first().press(action.key, { timeout: 10000 });
      return;
    case "wait":
      await page.waitForTimeout(Math.min(action.ms, 5000));
      return;
    case "finish":
      return;
  }
}

function writeReport(finalVerdict: string, finalReason: string) {
  const tableRows = rows.map((r) => `
<tr>
  <td>${r.step}</td>
  <td>${escapeHtml(r.status)}</td>
  <td>${escapeHtml(r.action)}</td>
  <td>${escapeHtml(r.reason)}</td>
  <td><a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a></td>
  <td>${escapeHtml(r.notes)}</td>
  <td><img src="${r.screenshot}" /></td>
</tr>`).join("");

  fs.writeFileSync(path.join(outDir, "index.html"), `
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>AI QA MCP Discovery Report</title>
<style>
body{font-family:system-ui,sans-serif;margin:32px;background:#fafafa;color:#111}
.card{background:white;border:1px solid #e5e5e5;border-radius:14px;padding:20px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;background:white}
th,td{padding:12px;border-bottom:1px solid #e5e5e5;vertical-align:top;word-break:break-word}
th{text-align:left;background:#f3f3f3}
img{max-width:360px;border-radius:8px;border:1px solid #ddd;cursor:zoom-in}
pre{white-space:pre-wrap;background:#111;color:#fff;padding:16px;border-radius:12px;overflow:auto}
</style>
</head>
<body>
<h1>AI QA MCP Discovery Report</h1>

<div class="card">
  <p><strong>Target:</strong> ${escapeHtml(targetUrl)}</p>
  <p><strong>Goal:</strong> ${escapeHtml(goal)}</p>
  <p><strong>Final verdict:</strong> ${escapeHtml(finalVerdict)}</p>
  <p><strong>Reason:</strong> ${escapeHtml(finalReason)}</p>
</div>

<div class="card">
  <h2>Console errors</h2>
  <pre>${escapeHtml(consoleErrors.join("\\n") || "None")}</pre>
  <h2>Network errors</h2>
  <pre>${escapeHtml(networkErrors.join("\\n") || "None")}</pre>
</div>

<table>
<thead>
<tr>
<th>Step</th>
<th>Status</th>
<th>Action</th>
<th>Reason</th>
<th>URL</th>
<th>Notes</th>
<th>Screenshot</th>
</tr>
</thead>
<tbody>${tableRows}</tbody>
</table>

<script>
document.querySelectorAll("img").forEach(img=>{
  img.onclick=()=>{
    const overlay=document.createElement("div");
    overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px";
    overlay.innerHTML='<img src="'+img.src+'" style="max-width:95vw;max-height:92vh;object-fit:contain;background:white" />';
    overlay.onclick=()=>overlay.remove();
    document.body.appendChild(overlay);
  };
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape") document.querySelectorAll("body > div[style*='position:fixed']").forEach(el=>el.remove());
});
</script>
</body>
</html>`);
}

function escapeHtml(value: string) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]!));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  page.on("response", (res) => {
    if (res.status() >= 500) networkErrors.push(`${res.status()} ${res.url()}`);
  });

  let finalVerdict = "uncertain";
  let finalReason = "Max steps reached.";

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await capture(page, "open-target-url", "Initial load", "passed");

    for (let i = 0; i < maxSteps; i++) {
      const snapshot = await getPageSnapshot(page);
      const action = await askGemini(snapshot, rows);

      if (action.action === "finish") {
        finalVerdict = action.verdict;
        finalReason = action.reason;
        await capture(page, "finish", action.reason, "passed", `Verdict: ${action.verdict}`);
        break;
      }

      try {
        await runAction(page, action);
        await page.waitForTimeout(800);
        await capture(page, action.action, action.reason, "passed", JSON.stringify(action));
      } catch (error: any) {
        await capture(page, action.action, action.reason, "failed", error?.message || String(error));
      }
    }
  } finally {
    writeReport(finalVerdict, finalReason);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
