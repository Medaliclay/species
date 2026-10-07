// Worker tests — run with:  node --test test/
// All network calls (model server, GBIF, iNaturalist, Wikipedia) are faked, so these run offline in ~1s.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const MONARCH = { kingdom: "Animalia", genus: "Danaus", species: "Danaus plexippus", common_name: "Monarch" };
const GBIF_MATCH = {
  usageKey: 5133088, scientificName: "Danaus plexippus (Linnaeus, 1758)", rank: "SPECIES", status: "ACCEPTED",
  confidence: 100, matchType: "EXACT", kingdom: "Animalia", phylum: "Arthropoda", class: "Insecta",
  order: "Lepidoptera", family: "Nymphalidae", genus: "Danaus", species: "Danaus plexippus",
};

let calls, model, fail;
beforeEach(() => {
  calls = [];
  fail = new Set(); // names of sources to break: "wikipedia", "gbif", ...
  model = { status: 200, score: 0.82 };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || (typeof input === "string" ? {} : input.headers));
    calls.push({ url, headers });
    if (url.includes("/identify")) {
      if (model.status !== 200) return new Response("down", { status: model.status });
      return J({
        model: "bioclip-2", ms: 900,
        species: [{ ...MONARCH, score: model.score }, { ...MONARCH, species: "Danaus gilippus", common_name: "Queen", score: 0.1 }],
        genus: [{ kingdom: "Animalia", genus: "Danaus", score: 0.93 }],
      });
    }
    if (url.includes("/health")) return J({ ok: true });
    for (const src of fail) if (url.includes(src)) return new Response("boom", { status: 500 });
    if (url.includes("/species/match")) return J(GBIF_MATCH);
    if (url.includes("iucnRedListCategory")) return J({ category: "LEAST_CONCERN", code: "LC" });
    if (url.includes("occurrence/search"))
      return J({ count: 812345, facets: [{ counts: [{ name: "US", count: 500000 }, { name: "MX", count: 90000 }] }] });
    if (url.includes("inaturalist"))
      return J({ results: [{ id: 48662, preferred_common_name: "Monarch", iconic_taxon_name: "Insecta",
        observations_count: 400000, default_photo: { medium_url: "https://x/p.jpg", attribution: "(c) someone" } }] });
    if (url.includes("wikipedia"))
      return J({ extract: "The monarch butterfly is a milkweed butterfly.", content_urls: { desktop: { page: "https://w" } } });
    throw new Error("unexpected fetch " + url);
  };
});

const env = (extra = {}) => ({
  MODEL_URL: "https://me-bioclip2-api.hf.space/",
  MODEL_TOKEN: "tok",
  ASSETS: { fetch: () => new Response("static page") },
  ...extra,
});

function upload(bytes = [0xff, 0xd8, 0xff], type = "image/jpeg") {
  const fd = new FormData();
  fd.append("image", new Blob([new Uint8Array(bytes)], { type }), "photo.jpg");
  return new Request("https://app/api/identify", { method: "POST", body: fd });
}

test("identifies a species and builds the full species card", async () => {
  const res = await worker.fetch(upload(), env(), {});
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.identified, "Danaus plexippus");
  assert.equal(d.rank, "species");
  assert.equal(d.confident, true);
  assert.equal(d.taxonomy.family, "Nymphalidae");
  assert.equal(d.facts.gbif.occurrences, 812345);
  assert.deepEqual(d.facts.gbif.topCountries[0], { code: "US", count: 500000 });
  assert.equal(d.facts.iucn.code, "LC");
  assert.equal(d.facts.inaturalist.commonName, "Monarch");
  assert.match(d.facts.wikipedia.extract, /monarch/);
  assert.equal(d.candidates.length, 2);
});

test("sends the secret token to the model server and trims the trailing slash", async () => {
  await worker.fetch(upload(), env(), {});
  const call = calls.find((c) => c.url.includes("/identify"));
  assert.equal(call.url, "https://me-bioclip2-api.hf.space/identify?k=5");
  assert.equal(call.headers.get("authorization"), "Bearer tok");
});

test("falls back to the GENUS when BioCLIP 2 is unsure (no made-up species)", async () => {
  model.score = 0.2;
  const d = await (await worker.fetch(upload(), env(), {})).json();
  assert.equal(d.rank, "genus");
  assert.equal(d.identified, "Danaus");
  assert.equal(d.confident, false);
  assert.ok(calls.some((c) => c.url.includes("match?name=Danaus&rank=GENUS")));
});

test("one data source failing does not break the result", async () => {
  fail.add("wikipedia");
  fail.add("inaturalist");
  const res = await worker.fetch(upload(), env(), {});
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.facts.wikipedia, null);
  assert.equal(d.facts.inaturalist, null);
  assert.equal(d.facts.gbif.key, 5133088);
});

test("model sleeping → friendly 503 'waking up' message", async () => {
  model.status = 503;
  const res = await worker.fetch(upload(), env(), {});
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /waking up/);
});

test("missing photo → 400", async () => {
  const req = new Request("https://app/api/identify", { method: "POST", body: new FormData() });
  const res = await worker.fetch(req, env(), {});
  assert.equal(res.status, 400);
});

test("photo over 10 MB → 413", async () => {
  const res = await worker.fetch(upload(new Array(10 * 1024 * 1024 + 1).fill(0)), env(), {});
  assert.equal(res.status, 413);
});

test("missing MODEL_URL config → clear 500 error", async () => {
  const res = await worker.fetch(upload(), env({ MODEL_URL: undefined }), {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /MODEL_URL/);
});

test("Workers AI study notes are added when the AI binding exists", async () => {
  let prompt;
  const AI = { run: async (_m, input) => ((prompt = input.messages[1].content), { response: "- Monarchs migrate" }) };
  const d = await (await worker.fetch(upload(), env({ AI }), {})).json();
  assert.equal(d.summary, "- Monarchs migrate");
  assert.match(prompt, /Nymphalidae/, "summary must be grounded in the fetched facts");
});

test("Workers AI failure is ignored (summary = null)", async () => {
  const AI = { run: async () => { throw new Error("quota"); } };
  const res = await worker.fetch(upload(), env({ AI }), {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, null);
});

test("health endpoint reports the model state", async () => {
  const d = await (await worker.fetch(new Request("https://app/api/health"), env(), {})).json();
  assert.equal(d.model, "awake");
});

test("other paths serve the web app", async () => {
  const res = await worker.fetch(new Request("https://app/"), env(), {});
  assert.equal(await res.text(), "static page");
});

test("web app page exists and posts to /api/identify", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /fetch\("\/api\/identify"/);
  assert.match(html, /capture="environment"/, "should open the phone's back camera");
});
