# 🔬 Species ID: BioCLIP 2 + Cloudflare

![tests](https://github.com/Medaliclay/species-id/actions/workflows/tests.yml/badge.svg)

Take a photo, and the app tells you the species with real scientific data from GBIF, iNaturalist, Wikipedia and the IUCN Red List.

## 📱 Test platform: Species Lens (GitHub Pages)

**Live page:** https://medaliclay.github.io/species-id/

Open it on a phone, point the camera at a plant or animal, and tap the shutter. BioCLIP 2 identifies it, and the page shows the classification, IUCN status, worldwide and Saudi records, a description and the top-5 guesses. You can also upload a photo or try one of the 8 sample photos.

- The page is a single static file, `docs/index.html`. It uses the **public BioCLIP 2 demo server** from the Imageomics Institute, so no setup is needed.
- If the public demo is busy, use **Duplicate this Space** on huggingface.co/spaces/imageomics/bioclip-2-demo, then open the page with `?space=your-name/bioclip-2-demo` at the end of the address.
- **One-time setup:** in the repo, go to **Settings → Pages → Source** and choose **GitHub Actions**. After that, every push to `main` tests the page and republishes it.
- The tests in `e2e/` use Playwright to check the camera, upload, results, the "unsure" fallback, errors, and that phones don't scroll sideways. A live test also runs the real BioCLIP 2.

## Full app (Cloudflare)

```
 Phone camera
     │  photo
     ▼
 Cloudflare Worker  ──────────────►  BioCLIP 2 model server  (Docker, FastAPI)
 (web app + API)    ◄── top-5 species   • Option A: Hugging Face Space (free)
     │                                  • Option B: Cloudflare Containers
     ├─► GBIF          verify name, full taxonomy, # of records, top countries, IUCN status
     ├─► iNaturalist   common name, reference photo, # of observations
     ├─► Wikipedia     description
     └─► Workers AI    (optional) short study notes written ONLY from those facts
```

**Why it's built this way:** BioCLIP 2 is a PyTorch model (about 1.7 GB, plus 2.7 GB of "Tree of Life" data covering about 950,000 species). Cloudflare Workers can't run PyTorch directly, so the model runs in a Docker container and the Worker calls it.

```
species-id/
├── model-server/          ← the AI (Python)
│   ├── app.py             POST /identify → top-5 species + genus guesses
│   ├── download_assets.py downloads the model at build time
│   ├── Dockerfile         same image works on Hugging Face AND Cloudflare
│   ├── README.md          Hugging Face Space settings (keep the header!)
│   └── tests/             fast API tests + real BioCLIP 2 accuracy test
├── worker/                ← the app (JavaScript, Cloudflare)
│   ├── src/index.js       API: identify + fact lookup
│   ├── src/container.js   only for Option B
│   ├── public/index.html  the web page (camera, species card)
│   ├── test/              Worker tests (node --test)
│   ├── wrangler.jsonc               Option A config
│   └── wrangler.containers.jsonc    Option B config
└── .github/workflows/tests.yml     ← automatic tests on GitHub
```

---

## Option A: free (Hugging Face Space + Cloudflare Worker) ⭐ start here

### Step 1: Put the model on Hugging Face (about 15 min)

1. Create a free account at huggingface.co.
2. Click **New → Space**. Name it `bioclip2-api`, choose **SDK: Docker**, keep the **CPU basic (free)** hardware, and set visibility to **Public**.
3. Upload `app.py`, `download_assets.py`, `Dockerfile`, `requirements.txt` and `README.md` from `model-server/`, using **Files → Add file → Upload files**.
4. Go to **Settings → Variables and secrets → New secret**. Set the name to `API_TOKEN` and the value to a long random password you make up. Write it down for step 2.
5. Wait for the build to finish. It takes about 10 minutes the first time because it downloads 4 GB. When the status turns **Running**, test it:

   ```bash
   curl https://YOUR-HF-USERNAME-bioclip2-api.hf.space/health
   # {"ok":true,"model":"bioclip-2"}

   curl -X POST --data-binary @butterfly.jpg \
        -H "Authorization: Bearer YOUR_API_TOKEN" \
        https://YOUR-HF-USERNAME-bioclip2-api.hf.space/identify
   ```

> Free Spaces go to sleep after 48 hours without visitors. The first request after that takes about 1–2 minutes while the Space wakes up, and the app shows a "waking up" message.

### Step 2: Deploy the Worker (about 5 min)

You need Node.js 18 or newer and a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login
```

1. Open `wrangler.jsonc` and replace `MODEL_URL` with your Space URL (`https://YOUR-HF-USERNAME-bioclip2-api.hf.space`).
2. Save the password from step 1 as a secret. It must never go in the code:
   ```bash
   npx wrangler secret put MODEL_TOKEN
   ```
3. Test it on your computer, then deploy:
   ```bash
   npx wrangler dev       # opens http://localhost:8787
   npx wrangler deploy    # gives you https://species-id.<you>.workers.dev
   ```

For local testing, also create `worker/.dev.vars` containing `MODEL_TOKEN=YOUR_API_TOKEN`.

Open the URL on a phone, take a photo of a plant or insect, and you're done 🎉

---

## Option B: all on Cloudflare (Cloudflare Containers)

Use this option when you want everything in one place and no sleeping Space.

**Requirements:** the Workers Paid plan ($5/month; container time beyond the included allowance is billed per use) and Docker Desktop running on your computer.

```bash
cd worker
npm install
npm run deploy:containers      # builds model-server/Dockerfile and uploads it
```

- This uses `wrangler.containers.jsonc`, which runs the same Docker image on a `standard-3` instance (2 vCPU, 8 GB RAM; BioCLIP 2 needs about 5 GB).
- You don't need `MODEL_URL` or `MODEL_TOKEN`, because the container is private to your Worker.
- The container sleeps after 15 minutes without requests, so you only pay while it's in use. Waking up takes about 1 minute.
- The first deploy uploads about 6 GB, so wait a few minutes before the first request works.

---

## What the API returns

`POST /api/identify` (form field `image`) returns:

```jsonc
{
  "identified": "Danaus plexippus",
  "rank": "species",            // becomes "genus" when BioCLIP is unsure (< 35%)
  "confident": true,
  "confidence": 0.82,
  "candidates": [ /* BioCLIP top-5 with scores */ ],
  "taxonomy": { "kingdom": "Animalia", "phylum": "Arthropoda", "class": "Insecta", ... },
  "facts": {
    "gbif":        { "scientificName": "Danaus plexippus (Linnaeus, 1758)", "occurrences": 812345, "topCountries": [...] },
    "iucn":        { "category": "LEAST CONCERN", "code": "LC" },
    "inaturalist": { "commonName": "Monarch", "photo": "...", "observations": 400000 },
    "wikipedia":   { "extract": "The monarch butterfly ...", "url": "..." }
  },
  "summary": "- study notes from Workers AI ..."
}
```

## 🧪 Automatic tests (GitHub Actions)

Push this folder to a **public** GitHub repo and the tests run on every push. Open the **Actions** tab to see them.

| Job | What it checks | Time |
|---|---|---|
| **Worker** | 15 tests: identifying, genus fallback, a data source failing, the model sleeping, bad uploads, the AI study notes, the Containers setup, and both Cloudflare configs | ~1 min |
| **Model server API** | 10 tests: password check, bad and huge images, PNG and transparent images, phone-photo rotation, result format | ~3 min |
| **BioCLIP 2 accuracy** | Downloads the **real** model and identifies 14 photos of known species. The build **fails** if any core species misses the top-5, or if top-5 accuracy drops below 80%. | ~10 min (~4 min when cached) |
| **Docker** | Builds the real image, starts it, and checks it recognises a monarch butterfly. Runs weekly, or from Actions → *Run workflow* → tick *docker*. | ~20 min |

The accuracy job posts a **visual report** (photo, expected answer, BioCLIP 2's answer, confidence) on the run's summary page. The test set includes a **monarch vs viceroy** pair: the viceroy mimics the monarch, so it makes a good discussion point in class.

To run the tests on your own computer:

```bash
cd worker && npm ci && npm test                         # Worker
cd model-server && pip install -r requirements.txt -r requirements-dev.txt
pytest -m "not model"                                   # fast
BIOCLIP_REAL=1 pytest -m model                          # real model (downloads 4.4 GB)
```

> Use a **public** repo. Its free runners have 16 GB RAM, while private-repo runners have 7 GB, which is too tight for BioCLIP 2.

## Good science rules built in

- **The AI only names the species.** Every scientific fact comes from GBIF, iNaturalist or Wikipedia, so nothing is made up.
- **It's honest when unsure.** Below 35% confidence, the app shows the genus instead of guessing a species.
- **Every name is checked.** GBIF verifies the name and swaps in the accepted name if BioCLIP used an old synonym.
- **External lookups are cached for 24 hours** at Cloudflare's edge, which keeps the app fast and polite to the free APIs.

## Ideas for next steps

1. Save observations (photo, species, GPS, date) with **R2** for photos and **D1** for the database, then build a "my field journal" page.
2. Add a **map** of where the species is found, using GBIF's free map tiles: `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey=KEY`.
3. Add a **Saudi Arabia filter**: "Is this species recorded in KSA?" using `occurrence/search?taxonKey=KEY&country=SA`.
4. Add an Arabic language toggle using iNaturalist's `locale=ar`.

## Credits and licences

- BioCLIP 2 by the Imageomics Institute (MIT). Tree of Life embeddings are CC0.
- The data comes from GBIF, iNaturalist and Wikipedia. Please keep the photo credits and links shown in the app.
