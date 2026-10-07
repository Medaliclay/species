// Tests the Cloudflare Containers entry point (Option B).
// @cloudflare/containers only runs inside Cloudflare, so we replace it with a tiny fake.
// Run with:  node --test --experimental-test-module-mocks test/
import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("@cloudflare/containers", {
  namedExports: {
    Container: class {},
    getContainer: (ns, name) => ns.get(name),
  },
});
const { default: containerEntry, BioclipContainer } = await import("../src/container.js");

test("container class listens on the same port as the Hugging Face Space", () => {
  const c = new BioclipContainer();
  assert.equal(c.defaultPort, 7860);
  assert.equal(c.sleepAfter, "15m");
});

test("model calls go to the container (not MODEL_URL) and wait for the 4 GB model to load", async () => {
  let waited = 0, hit;
  const stub = {
    startAndWaitForPorts: async (o) => { waited = o.cancellationOptions.portReadyTimeoutMS; },
    fetch: async (req) => {
      hit = req.url;
      return new Response(JSON.stringify({
        model: "bioclip-2", ms: 1,
        species: [{ kingdom: "Animalia", genus: "Danaus", species: "Danaus plexippus", score: 0.9 }],
        genus: [{ genus: "Danaus", score: 0.95 }],
      }));
    },
  };
  globalThis.fetch = async () => new Response("{}", { status: 404 }); // external lookups: nothing found
  const env = { BIOCLIP: { get: () => stub }, ASSETS: { fetch: () => new Response("") } };

  const fd = new FormData();
  fd.append("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "a.jpg");
  const res = await containerEntry.fetch(new Request("https://app/api/identify", { method: "POST", body: fd }), env, {});

  assert.equal(res.status, 200);
  assert.equal(hit, "http://bioclip/identify?k=5");
  assert.ok(waited >= 60_000, `start timeout ${waited}ms is too short for a cold start`);
  assert.equal((await res.json()).identified, "Danaus plexippus");
});
