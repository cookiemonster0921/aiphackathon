import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    screenshot: "on",
    video: "on",
    trace: "on"
  }
});
