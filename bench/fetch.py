"""Downloads the public benchmarks into data/<name>, each at a pinned revision.
usage: python3 fetch.py [name ...]   # no names: every source; a data/<name> that already holds files is left alone"""
import pathlib, shutil, subprocess, sys, urllib.request

DATA = pathlib.Path(__file__).resolve().parent / "data"
# name: ("git", url, commit) or ("hf", dataset, revision, [files])
SOURCES = {
    "click": ("git", "https://github.com/pallets/click.git", "874ca2bc1c30d93a4ac6e36a15ed685eafe89097"),
    "refactorbench": ("git", "https://github.com/microsoft/RefactorBench.git", "210b2d15a373ad265aa721f70199c9962d7de069"),
    "refactor": ("git", "https://github.com/Aider-AI/refactor-benchmark.git", "c90dfb67d829f4da2759955a69111fc5f3b0e0fd"),
    "polyglot": ("git", "https://github.com/Aider-AI/polyglot-benchmark.git", "7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f"),
    "quixbugs": ("git", "https://github.com/jkoppel/QuixBugs.git", "4257f44b0ff1181dedaedee6a447e133219fcebf"),
    "canitedit": ("hf", "nuprl/CanItEdit", "3c07f38b1f9385f3214fcea94d4664c79df0d36a", ["data/test-00000-of-00001.parquet"]),
    "swebench": ("hf", "SWE-bench/SWE-bench_Verified", "78f471bf655a3137b2e8a75af1501690ec009ec3", ["data/test-00000-of-00001.parquet"]),
}


def git(dest, url, commit):
    run = lambda *argv: subprocess.run(["git", "-C", str(dest), *argv], check=True)
    run("init", "-q"); run("remote", "add", "origin", url)
    run("fetch", "-q", "--depth", "1", "origin", commit); run("checkout", "-q", "FETCH_HEAD")


def hugging_face(dest, dataset, revision, files):
    for f in files:
        out = dest / f; out.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"https://huggingface.co/datasets/{dataset}/resolve/{revision}/{f}") as r, open(out, "wb") as w:
            shutil.copyfileobj(r, w)


if __name__ == "__main__":
    for name in sys.argv[1:] or SOURCES:
        kind, *args = SOURCES[name]; dest = DATA / name
        if dest.exists() and any(dest.iterdir()): print(f"{name}: already in {dest}"); continue
        dest.mkdir(parents=True, exist_ok=True)
        {"git": git, "hf": hugging_face}[kind](dest, *args)
        print(f"{name}: {dest}")
