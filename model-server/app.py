"""
BioCLIP 2 species-identification server.

POST /identify   body = raw image bytes (jpeg/png/webp)
                 header Authorization: Bearer <API_TOKEN>   (if API_TOKEN is set)
                 query  ?k=5
GET  /health     -> {"ok": true, "model": "bioclip-2"}

The same Docker image runs on Hugging Face Spaces (free) or Cloudflare Containers.
"""
import io
import os
import time

import torch
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, ImageOps, UnidentifiedImageError

from bioclip import TreeOfLifeClassifier, Rank

API_TOKEN = os.environ.get("API_TOKEN", "")
MAX_BYTES = 10 * 1024 * 1024  # 10 MB
torch.set_num_threads(max(1, os.cpu_count() or 1))

app = FastAPI(title="BioCLIP 2 Species ID")

# Loads the model (~1.7 GB) and the Tree-of-Life text embeddings (~2.7 GB, ~950k taxa).
# This happens once when the server starts. The Dockerfile pre-downloads both files.
print("Loading BioCLIP 2 ...", flush=True)
_t = time.time()
classifier = TreeOfLifeClassifier(device="cpu")
print(f"BioCLIP 2 ready in {time.time() - _t:.1f}s", flush=True)

RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]


def _check_auth(request: Request):
    if not API_TOKEN:
        return
    if request.headers.get("authorization", "") != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid or missing token")


def _load_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)  # fix phone-camera rotation
        img = img.convert("RGB")
        img.thumbnail((1024, 1024))          # model only needs 224px; keeps RAM low
        return img
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="Not a valid image")


def _clean(pred: dict) -> dict:
    out = {r: pred.get(r) for r in RANKS if pred.get(r)}
    out["common_name"] = pred.get("common_name") or None
    out["score"] = round(float(pred["score"]), 4)
    return out


@app.get("/health")
def health():
    return {"ok": True, "model": "bioclip-2"}


@app.post("/identify")
async def identify(request: Request, k: int = 5):
    _check_auth(request)
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Send the image bytes as the request body")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")

    img = _load_image(data)
    k = max(1, min(k, 10))
    t = time.time()

    # Encode the image once, then read off both species- and genus-level answers.
    probs = classifier.create_batched_probabilities_for_images(
        [img], classifier.get_txt_embeddings(), batch_size=1
    )
    key = classifier.make_key(img, 0)
    p = probs[key].cpu()
    species = classifier.format_species_probs(key, p, k)
    genus = classifier.format_grouped_probs(key, p, Rank.GENUS, k=3)

    return {
        "model": "bioclip-2",
        "ms": int((time.time() - t) * 1000),
        "species": [_clean(x) for x in species],
        "genus": [_clean(x) for x in genus],
    }
