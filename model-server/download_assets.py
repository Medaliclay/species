"""Run at Docker build time so the server starts fast (no 4 GB download on first request)."""
from huggingface_hub import hf_hub_download
import open_clip

for f in ["embeddings/txt_emb_species.npy", "embeddings/txt_emb_species.json"]:
    print("downloading", f, flush=True)
    hf_hub_download("imageomics/TreeOfLife-200M", f, repo_type="dataset")

print("downloading BioCLIP 2 weights", flush=True)
open_clip.create_model_from_pretrained("hf-hub:imageomics/bioclip-2")
print("all assets cached", flush=True)
