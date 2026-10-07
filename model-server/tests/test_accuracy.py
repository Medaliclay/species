"""
Real-model test: does BioCLIP 2 recognise photos of species we already know?

Photos come from the official BioCLIP 2 demo (huggingface.co/spaces/imageomics/bioclip-2-demo),
so the test never depends on a random website. Each case says what the right answer is and
at which rank we check it (species, genus or family).

A "core" case MUST be in the top-5 or the build fails.
A "stretch" case is reported but allowed to miss (hard photos, recent taxonomy changes).
"""
import os
import time
from pathlib import Path

import pytest
from huggingface_hub import hf_hub_download

DEMO_SPACE = "imageomics/bioclip-2-demo"
MIN_TOP5 = float(os.environ.get("MIN_TOP5_ACCURACY", "0.80"))
MAX_SECONDS = float(os.environ.get("MAX_SECONDS_PER_IMAGE", "15"))

#        file in the demo Space        rank       expected answer             level      why it's interesting
CASES = [
    ("examples/monarch.jpg",             "species", "Danaus plexippus",          "core",    "classic butterfly"),
    ("examples/viceroy.jpg",             "species", "Limenitis archippus",       "core",    "MIMICS the monarch!"),
    ("examples/cheetah.jpg",             "species", "Acinonyx jubatus",          "core",    "spotted big cat #1"),
    ("examples/leopard.jpg",             "species", "Panthera pardus",           "core",    "spotted big cat #2"),
    ("examples/jaguar.jpg",              "species", "Panthera onca",             "core",    "spotted big cat #3"),
    ("examples/Ursus-arctos.jpeg",       "species", "Ursus arctos",              "core",    "brown bear"),
    ("examples/house-finch.jpeg",        "species", "Haemorhous mexicanus",      "core",    "small songbird"),
    ("examples/Carnegiea-gigantea.png",  "species", "Carnegiea gigantea",        "core",    "saguaro cactus (plant)"),
    ("examples/Carcharhinus-melanopterus.jpg", "species", "Carcharhinus melanopterus", "core", "blacktip reef shark"),
    ("examples/Bovidae-Oryx.jpg",        "genus",   "Oryx",                      "core",    "desert antelope (Arabian oryx's genus)"),
    ("examples/Solanales-Petunia.png",   "genus",   "Petunia",                   "stretch", "garden flower"),
    ("examples/Asparagales-Orchidaceae.jpg", "family", "Orchidaceae",            "stretch", "orchid family"),
    ("examples/Cebidae-Cebus.jpg",       "genus",   "Cebus",                     "stretch", "capuchin (genus was split in 2012)"),
    ("examples/Cortinarius-austroalbidus.jpg", "species", "Cortinarius austroalbidus", "stretch", "fungus — very hard"),
]

RESULTS = []  # filled by the tests, written to the report at the end


def _download(path):
    return Path(hf_hub_download(DEMO_SPACE, path, repo_type="space")).read_bytes()


@pytest.mark.model
@pytest.mark.parametrize("path,rank,expected,level,note", CASES, ids=[c[0].split("/")[-1] for c in CASES])
def test_known_species(client, auth, path, rank, expected, level, note):
    t = time.time()
    r = client.post("/identify?k=5", content=_download(path), headers=auth)
    seconds = time.time() - t
    assert r.status_code == 200, r.text

    top5 = r.json()["species"]
    answers = [(c.get(rank) or "").lower() for c in top5]
    hit_top1 = answers[0] == expected.lower()
    hit_top5 = expected.lower() in answers

    RESULTS.append({
        "path": path, "rank": rank, "expected": expected, "level": level, "note": note,
        "top1": top5[0]["species"], "top1_common": top5[0].get("common_name") or "",
        "score": top5[0]["score"], "hit_top1": hit_top1, "hit_top5": hit_top5, "seconds": seconds,
    })

    assert seconds < MAX_SECONDS, f"too slow: {seconds:.1f}s"
    if not hit_top5:
        msg = f"expected {rank} '{expected}' in top-5, got {[c['species'] for c in top5]}"
        if level == "stretch":
            pytest.xfail(msg)
        pytest.fail(msg)


@pytest.mark.model
def test_overall_accuracy_and_report():
    """Runs last: checks the overall score and writes a Markdown report (shown on GitHub)."""
    assert RESULTS, "no cases ran"
    n = len(RESULTS)
    top1 = sum(r["hit_top1"] for r in RESULTS) / n
    top5 = sum(r["hit_top5"] for r in RESULTS) / n
    avg_s = sum(r["seconds"] for r in RESULTS) / n

    img = "https://huggingface.co/spaces/{}/resolve/main/{}".format
    lines = [
        "## 🔬 BioCLIP 2 accuracy test",
        "",
        f"| Top-1 | Top-5 | Avg time / photo | Photos |",
        f"|---|---|---|---|",
        f"| **{top1:.0%}** | **{top5:.0%}** (min {MIN_TOP5:.0%}) | {avg_s:.1f}s | {n} |",
        "",
        "| Photo | Expected | BioCLIP 2 top answer | Confidence | Result |",
        "|---|---|---|---|---|",
    ]
    for r in RESULTS:
        icon = "✅" if r["hit_top1"] else ("🟡 top-5" if r["hit_top5"] else ("⚠️ stretch" if r["level"] == "stretch" else "❌"))
        lines.append(
            f"| <img src=\"{img(DEMO_SPACE, r['path'])}\" width=\"90\"> | "
            f"*{r['expected']}* ({r['rank']})<br><sub>{r['note']}</sub> | "
            f"*{r['top1']}*<br><sub>{r['top1_common']}</sub> | {r['score']:.0%} | {icon} |"
        )
    lines += ["", "✅ correct first guess · 🟡 right answer in top-5 · ⚠️ hard case missed (allowed) · ❌ failure"]
    report = "\n".join(lines) + "\n"

    Path("accuracy-report.md").write_text(report, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(report)
    print("\n" + report)

    assert top5 >= MIN_TOP5, f"top-5 accuracy {top5:.0%} is below the {MIN_TOP5:.0%} minimum"
