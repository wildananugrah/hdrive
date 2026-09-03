import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5183", trace: "on-first-retry" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5183",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
