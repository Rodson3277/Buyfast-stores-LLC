import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "kyc.spec.ts",
  timeout: 45_000,
  workers: 1,
  reporter: "list",
  outputDir: "/tmp/kyc-browser-results",
  use: {
    baseURL: process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000",
    browserName: "chromium",
    serviceWorkers: "block",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
});