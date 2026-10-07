# BioCLIP 2 species-ID server — works on Hugging Face Spaces AND Cloudflare Containers
FROM python:3.11-slim

# Hugging Face Spaces runs containers as user 1000
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    HF_HOME=/home/user/.cache/huggingface \
    PYTHONUNBUFFERED=1
WORKDIR /home/user/app

# CPU-only PyTorch (much smaller than the default CUDA build)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

USER user
# Bake model weights (~1.7 GB) + Tree-of-Life embeddings (~2.7 GB) into the image
COPY --chown=user download_assets.py .
RUN python download_assets.py

COPY --chown=user app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
