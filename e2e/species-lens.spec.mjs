/**
 * End-to-end tests for the Species Lens test page (docs/index.html).
 *
 *   npm test        → fast: BioCLIP 2 + science APIs are faked, runs offline
 *   npm run test:live → slow: real BioCLIP 2 demo server + real GBIF/iNaturalist/Wikipedia
 */
import { test, expect } from "@playwright/test";

const LIVE = !!process.env.LIVE;

/* --------------------------- fake backends (offline mode) --------------------------- */
const VICEROY = [
  ["Animalia Arthropoda Insecta Lepidoptera Nymphalidae Limenitis archippus (Viceroy)", 0.71],
  ["Animalia Arthropoda Insecta Lepidoptera Nymphalidae Danaus plexippus (Monarch)", 0.19],
  ["Animalia Arthropoda Insecta Lepidoptera Nymphalidae Danaus gilippus (Queen)", 0.05],
  ["Animalia Arthropoda Insecta Lepidoptera Nymphalidae Limenitis arthemis", 0.03],
  ["Animalia Arthropoda Insecta Lepidoptera Nymphalidae Danaus eresimus (Soldier)", 0.02],
];
// 1x1 green PNG used for every image download
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function fakeBackends(page, { predictions = VICEROY, modelError = null } = {}) {
  // fake @gradio/client module → returns our fixed predictions
  await page.route("**/@gradio/client@*/dist/browser.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        export function handle_file(b) { return b; }
        export class Client {
          static async connect(space) {
            window.__connectedTo = space;
            return { predict: async (endpoint, args) => {
              window.__predictCall = { endpoint, rank: args.rank, isBlob: args.img instanceof Blob, size: args.img.size };
              ${modelError ? `throw new Error(${JSON.stringify(modelError)});` : ""}
              return { data: [ { label: "x", confidences: ${JSON.stringify(predictions.map(([label, confidence]) => ({ label, confidence })))} },
                               { url: "https://example.org/sample.png" }, "" ] };
            } };
          }
        }`,
    }),
  );
  await page.route(/huggingface\.co\/.*\.(jpe?g|png)$|example\.org|static\.inaturalist|wikimedia/, (r) =>
    r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("https://api.gbif.org/**", (route) => {
    const u = route.request().url();
    if (u.includes("/species/match")) {
      const genusOnly = u.includes("rank=GENUS");
      return route.fulfill({ json: {
        usageKey: genusOnly ? 1919 : 5130929, matchType: "EXACT", status: "ACCEPTED",
        scientificName: genusOnly ? "Limenitis Fabricius, 1807" : "Limenitis archippus (Cramer, 1775)",
        kingdom: "Animalia", phylum: "Arthropoda", class: "Insecta", order: "Lepidoptera", family: "Nymphalidae",
        genus: "Limenitis", ...(genusOnly ? {} : { species: "Limenitis archippus" }) } });
    }
    if (u.includes("iucnRedListCategory")) return route.fulfill({ json: { category: "LEAST_CONCERN", code: "LC" } });
    if (u.includes("country=SA")) return route.fulfill({ json: { count: 0 } });
    if (u.includes("occurrence/search"))
      return route.fulfill({ json: { count: 152340, facets: [{ counts: [{ name: "US", count: 120000 }, { name: "CA", count: 20000 }] }] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://api.inaturalist.org/**", (r) => r.fulfill({ json: { results: [{
    id: 48505, preferred_common_name: "Viceroy", iconic_taxon_name: "Insecta", observations_count: 98000,
    default_photo: { medium_url: "https://static.inaturalist.org/p.jpg", attribution: "(c) tester" } }] } }));
  await page.route("https://en.wikipedia.org/**", (r) => r.fulfill({ json: {
    type: "standard", extract: "The viceroy is a North American butterfly that mimics the monarch.",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Viceroy_(butterfly)" } } } }));
}

test.beforeEach(async ({ page }) => {
  if (!LIVE) await fakeBackends(page);
});

/* ------------------------------------ tests ------------------------------------ */

test("page loads with camera controls and sample photos", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Species Lens" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  await expect(page.locator("#samples .chip")).toHaveCount(8);
});

test("sample photo → BioCLIP 2 → full species card", async ({ page }) => {
  await page.goto("/");
  await page.locator("#samples .chip", { hasText: "Viceroy" }).click();
  const card = page.locator("#resultCard");
  await expect(card.locator(".sci")).toContainText("Limenitis", { timeout: LIVE ? 150_000 : 10_000 });
  await expect(card).toContainText("Classification");
  await expect(card).toContainText("Lepidoptera");
  await expect(card.locator(".bar")).toHaveCount(5);
  await expect(card.locator(".links a").first()).toBeVisible();
  if (!LIVE) {
    await expect(card.locator(".common")).toHaveText("Viceroy");
    await expect(card).toContainText("IUCN: Least concern");
    await expect(card).toContainText("North American butterfly");
    const call = await page.evaluate(() => window.__predictCall);
    expect(call).toMatchObject({ endpoint: "/lambda", rank: "Species", isBlob: true });
  }
  await page.screenshot({ path: `test-results/result-${test.info().project.name}.png`, fullPage: true });
});

test("live camera → take photo → result", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator("#video")).toBeVisible();
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0);
  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.locator("#shot")).toBeVisible();
  // the fake webcam shows a test pattern, so in live mode we only check that BioCLIP answered
  await expect(page.locator("#resultCard .sci")).not.toBeEmpty({ timeout: LIVE ? 150_000 : 10_000 });
  await expect(page.getByRole("button", { name: "Take another photo" })).toBeVisible();
});

test("upload a photo from the device", async ({ page }) => {
  test.skip(LIVE, "covered by the sample test in live mode");
  await page.goto("/");
  await page.locator("#file").setInputFiles({ name: "bug.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#resultCard .sci")).toHaveText("Limenitis archippus");
  await expect(page.locator("#historyCard")).toBeVisible();
});

test("unsure → shows the GENUS, not a made-up species", async ({ page }) => {
  test.skip(LIVE);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await fakeBackends(page, { predictions: VICEROY.map(([l], i) => [l, [0.2, 0.18, 0.15, 0.12, 0.1][i]]) });
  await page.goto("/");
  await page.locator("#samples .chip").first().click();
  await expect(page.locator("#resultCard .sci")).toHaveText("Limenitis");
  await expect(page.locator("#resultCard")).toContainText("Unsure of exact species");
});

test("model server error → friendly message, page keeps working", async ({ page }) => {
  test.skip(LIVE);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await fakeBackends(page, { modelError: "Space is sleeping (503)" });
  await page.goto("/");
  await page.locator("#samples .chip").first().click();
  await expect(page.locator("#resultCard .err")).toContainText("waking up");
  await expect(page.getByRole("button", { name: /take another photo|start camera/i })).toBeEnabled();
});

test("label parser handles full and short BioCLIP 2 labels", async ({ page }) => {
  test.skip(LIVE);
  await page.goto("/");
  const r = await page.evaluate(() => [
    window.__speciesLens.parseLabel("Animalia Chordata Mammalia Carnivora Felidae Panthera onca (Jaguar)", 0.9),
    window.__speciesLens.parseLabel("Fungi Basidiomycota Agaricomycetes Agaricales Cortinariaceae Cortinarius austroalbidus", 0.1),
    window.__speciesLens.parseLabel("Oryx gazella", 0.5),
  ]);
  expect(r[0]).toMatchObject({ species: "Panthera onca", genus: "Panthera", family: "Felidae", common: "Jaguar" });
  expect(r[1]).toMatchObject({ species: "Cortinarius austroalbidus", kingdom: "Fungi", common: "" });
  expect(r[2]).toMatchObject({ species: "Oryx gazella", genus: "Oryx" });
});

test("no sideways scrolling on a phone", async ({ page }) => {
  test.skip(LIVE);
  await page.goto("/");
  await page.locator("#samples .chip").first().click();
  await expect(page.locator("#resultCard .sci")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("page has no JavaScript errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#samples .chip").first().click();
  await expect(page.locator("#resultCard")).toBeVisible({ timeout: LIVE ? 150_000 : 10_000 });
  expect(errors).toEqual([]);
});
