"""Fast tests: check the HTTP API behaves correctly (uses a stub model, runs in seconds)."""
import io

from PIL import Image

RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]


def jpeg(w=640, h=480, color=(40, 160, 60), fmt="JPEG"):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, fmt)
    return buf.getvalue()


def test_health(client):
    assert client.get("/health").json() == {"ok": True, "model": "bioclip-2"}


def test_rejects_missing_token(client):
    assert client.post("/identify", content=jpeg()).status_code == 401


def test_rejects_wrong_token(client):
    r = client.post("/identify", content=jpeg(), headers={"authorization": "Bearer nope"})
    assert r.status_code == 401


def test_rejects_empty_body(client, auth):
    assert client.post("/identify", content=b"", headers=auth).status_code == 400


def test_rejects_non_image(client, auth):
    assert client.post("/identify", content=b"definitely not a jpeg", headers=auth).status_code == 400


def test_rejects_huge_upload(client, auth):
    assert client.post("/identify", content=b"0" * (11 * 1024 * 1024), headers=auth).status_code == 413


def test_identify_response_shape(client, auth):
    r = client.post("/identify?k=3", content=jpeg(), headers=auth)
    assert r.status_code == 200
    d = r.json()
    assert d["model"] == "bioclip-2"
    assert isinstance(d["ms"], int)
    assert 1 <= len(d["species"]) <= 3
    for s in d["species"]:
        assert set(RANKS) <= set(s), f"missing taxonomy ranks in {s}"
        assert 0.0 <= s["score"] <= 1.0
        assert len(s["species"].split()) == 2, "species must be 'Genus epithet'"
    scores = [s["score"] for s in d["species"]]
    assert scores == sorted(scores, reverse=True), "predictions must be sorted by score"
    assert d["genus"] and "genus" in d["genus"][0]


def test_k_is_clamped(client, auth):
    d = client.post("/identify?k=999", content=jpeg(), headers=auth).json()
    assert len(d["species"]) <= 10


def test_png_and_rgba_and_tiny_images(client, auth):
    buf = io.BytesIO()
    Image.new("RGBA", (12, 12), (255, 0, 0, 128)).save(buf, "PNG")
    assert client.post("/identify", content=buf.getvalue(), headers=auth).status_code == 200


def test_phone_rotation_exif_is_handled(client, auth):
    img = Image.new("RGB", (400, 200), (10, 10, 200))
    exif = img.getexif()
    exif[0x0112] = 6  # "rotate 90°" — what phones write for portrait photos
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    assert client.post("/identify", content=buf.getvalue(), headers=auth).status_code == 200
