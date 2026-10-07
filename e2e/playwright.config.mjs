import { defineConfig, devices } from "@playwright/test";

const LIVE = !!process.env.LIVE; // LIVE=1 → talk to the real BioCLIP 2 server and real APIs

export default defineConfig({
  testDir: ".",
  timeout: LIVE ? 180_000 : 30_000,
  retries: LIVE ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "on",
    trace: "retain-on-failure",
    launchOptions: {
      // a fake webcam so the camera flow can be tested on a server with no camera
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
    permissions: ["camera"],
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // live mode only runs once (be polite to the free public BioCLIP 2 server)
    ...(LIVE ? [] : [{ name: "phone", use: { ...devices["Pixel 7"] } }]),
  ],
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1 --directory ../docs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
