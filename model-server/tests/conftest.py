"""
Two test modes:

  pytest -m "not model"          fast: swaps BioCLIP 2 for a tiny random model (no download)
  BIOCLIP_REAL=1 pytest -m model  slow: loads the real BioCLIP 2 + Tree-of-Life embeddings
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # so `import app` works
os.environ.setdefault("API_TOKEN", "test-token")
REAL = os.environ.get("BIOCLIP_REAL") == "1"

FAKE_TAXA = [
    [["Animalia", "Arthropoda", "Insecta", "Lepidoptera", "Nymphalidae", "Danaus", "plexippus"], "Monarch"],
    [["Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Panthera", "onca"], "Jaguar"],
    [["Plantae", "Tracheophyta", "Magnoliopsida", "Caryophyllales", "Cactaceae", "Carnegiea", "gigantea"], "Saguaro"],
]


def _install_stub():
    """Replace the 4 GB model with a random ViT-B-32 and 3 fake species."""
    import open_clip
    import torch
    from bioclip.predict import TreeOfLifeClassifier

    def fake_init(self, **kwargs):
        torch.nn.Module.__init__(self)
        self.device, self.recorder = "cpu", None
        self.model, _, self.preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained=None)
        self.model.eval()
        self.txt_names = FAKE_TAXA
        emb = torch.nn.functional.normalize(torch.randn(len(FAKE_TAXA), 512), dim=-1)
        self.txt_embeddings = emb.T.contiguous()
        self._subset_txt_embeddings = self._subset_txt_names = None

    TreeOfLifeClassifier.__init__ = fake_init


def pytest_collection_modifyitems(config, items):
    for item in items:
        if "model" in item.keywords and not REAL:
            item.add_marker(pytest.mark.skip(reason="set BIOCLIP_REAL=1 to run the real model"))
        if "model" not in item.keywords and REAL:
            item.add_marker(pytest.mark.skip(reason="fast tests run without BIOCLIP_REAL"))


@pytest.fixture(scope="session")
def server():
    if not REAL:
        _install_stub()
    import app  # loads the classifier once for the whole session
    return app


@pytest.fixture(scope="session")
def client(server):
    from fastapi.testclient import TestClient
    return TestClient(server.app)


@pytest.fixture(scope="session")
def auth():
    return {"authorization": f"Bearer {os.environ['API_TOKEN']}"}
