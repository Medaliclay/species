/**
 * Species ID — Cloudflare Worker
 *
 *  POST /api/identify   form-data field "image"  ->  species card JSON
 *  GET  /api/health                              ->  is the model awake?
 *  everything else                               ->  static files in /public
 *
 * Flow: photo -> BioCLIP 2 (model server) -> GBIF (verify name + taxonomy + IUCN + where found)
 *       -> iNaturalist (common name, photo) -> Wikipedia (description)
 *       -> optional Workers AI summary written ONLY from those facts.
 */

const UA = "SpeciesID-StudentProject/1.0 (Lamba Vibe with AI studio)";
const MAX_UPLOAD = 10 * 1024 * 1024;
const LOW_CONFIDENCE = 0.35; // below this we show the genus instead of claiming a species

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/identify" && request.method === "POST") {
        return await identify(request, env);
      }
      if (url.pathname === "/api/health") {
        const r = await callModel(env, "/health", { method: "GET" });
        return json({ model: r.ok ? "awake" : "sleeping", status: r.status });
      }
      return env.ASSETS.fetch(request); // serve the web app
    } catch (err) {
      if (!err.status || err.status >= 500) console.error(err);
      return json({ error: err.message || "Something went wrong" }, err.status || 500);
    }
  },
};

/* ---------------------------------------------------------------- identify */

async function identify(request, env) {
  const form = await request.formData();
  const file = form.get("image");
  if (!file || typeof file === "string") throw httpError(400, "Attach a photo in the 'image' field");
  if (file.size > MAX_UPLOAD) throw httpError(413, "Photo is too large (max 10 MB)");

  // 1) Ask BioCLIP 2 what it sees
  const modelRes = await callModel(env, "/identify?k=5", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  if (modelRes.status === 503 || modelRes.status === 502 || modelRes.status === 504) {
    throw httpError(503, "The AI model is waking up (this takes ~1 minute). Try again shortly.");
  }
  if (!modelRes.ok) throw httpError(502, `Model error ${modelRes.status}: ${await modelRes.text()}`);
  const model = await modelRes.json();

  const top = model.species[0];
  const confident = top.score >= LOW_CONFIDENCE;
  const name = confident ? top.species : model.genus[0]?.genus || top.genus;
  const rank = confident ? "species" : "genus";

  // 2) Look up real scientific data (in parallel)
  const facts = await getFacts(name, rank, top.kingdom);

  // 3) Optional: a short, student-friendly summary grounded in the facts above
  let summary = null;
  if (env.AI && (facts.wikipedia || facts.gbif)) summary = await summarize(env, name, facts);

  return json({
    identified: name,
    rank,
    confident,
    confidence: confident ? top.score : model.genus[0]?.score,
    candidates: model.species, // top-5 from BioCLIP 2
    taxonomy: facts.taxonomy,
    facts,
    summary,
    model: { name: "BioCLIP 2", ms: model.ms },
  });
}

/* ------------------------------------------------------------- model call */

// Works for both hosting options:
//  - Hugging Face Space: MODEL_URL + MODEL_TOKEN secret
//  - Cloudflare Containers: src/container.js injects env.MODEL_FETCHER
async function callModel(env, path, init) {
  const headers = new Headers(init.headers || {});
  if (env.MODEL_TOKEN) headers.set("authorization", `Bearer ${env.MODEL_TOKEN}`);
  if (env.MODEL_FETCHER) {
    return env.MODEL_FETCHER.fetch(new Request(`http://bioclip${path}`, { ...init, headers }));
  }
  if (!env.MODEL_URL) throw httpError(500, "MODEL_URL is not configured");
  return fetch(env.MODEL_URL.replace(/\/$/, "") + path, { ...init, headers });
}

/* ------------------------------------------------------------ fact lookup */

async function getFacts(name, rank, kingdom) {
  const match = await getJSON(
    `https://api.gbif.org/v1/species/match?name=${enc(name)}&rank=${rank.toUpperCase()}` +
      (kingdom ? `&kingdom=${enc(kingdom)}` : "")
  );
  const key = match?.usageKey && match.matchType !== "NONE" ? match.acceptedUsageKey || match.usageKey : null;

  const [iucn, occ, inat, wiki] = await Promise.all([
    key ? getJSON(`https://api.gbif.org/v1/species/${key}/iucnRedListCategory`) : null,
    key
      ? getJSON(`https://api.gbif.org/v1/occurrence/search?taxonKey=${key}&limit=0&facet=country&facetLimit=8`)
      : null,
    getJSON(`https://api.inaturalist.org/v1/taxa?q=${enc(name)}&rank=${rank}&per_page=1`),
    getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(name.replace(/ /g, "_"))}`),
  ]);

  const t = inat?.results?.[0];
  return {
    gbif: key
      ? {
          key,
          scientificName: match.scientificName, // includes author + year
          status: match.status,
          matchConfidence: match.confidence,
          url: `https://www.gbif.org/species/${key}`,
          occurrences: occ?.count ?? null,
          topCountries: occ?.facets?.[0]?.counts?.map((c) => ({ code: c.name, count: c.count })) ?? [],
        }
      : null,
    taxonomy: key
      ? pick(match, ["kingdom", "phylum", "class", "order", "family", "genus", "species"])
      : null,
    iucn: iucn?.category ? { category: iucn.category.replace(/_/g, " "), code: iucn.code } : null,
    inaturalist: t
      ? {
          id: t.id,
          commonName: t.preferred_common_name || null,
          group: t.iconic_taxon_name || null,
          observations: t.observations_count,
          photo: t.default_photo?.medium_url || null,
          photoCredit: t.default_photo?.attribution || null,
          url: `https://www.inaturalist.org/taxa/${t.id}`,
        }
      : null,
    wikipedia: wiki?.extract
      ? { extract: wiki.extract, url: wiki.content_urls?.desktop?.page, image: wiki.thumbnail?.source }
      : null,
  };
}

async function summarize(env, name, facts) {
  try {
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content:
            "You write short study notes for biology students. Use ONLY the facts given. " +
            "If a fact is missing, do not invent it. Max 5 bullet points.",
        },
        { role: "user", content: `Species: ${name}\nFacts (JSON):\n${JSON.stringify(facts).slice(0, 6000)}` },
      ],
      max_tokens: 300,
    });
    return r.response;
  } catch (e) {
    console.warn("summary failed", e);
    return null;
  }
}

/* ---------------------------------------------------------------- helpers */

// Edge-cached GET: the same species is only looked up once a day per data center.
async function getJSON(url) {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // one source failing should never break the whole card
  }
}

const enc = encodeURIComponent;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
