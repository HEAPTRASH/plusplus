"""SWE-bench Verified: real GitHub issues from Python projects, each with a human time-to-fix label, graded in Docker by
the official harness. Data: huggingface.co/datasets/SWE-bench/SWE-bench_Verified (no licence declared; every instance is
code from a project under its own licence). Harness: swebench 5.0.2 from PyPI (github.com/SWE-bench/SWE-bench, MIT), run
through uv and not copied here. A pass is the harness's "resolved": the hidden tests the fix must turn green pass and the
ones that passed before still do. Needs git, uv and a running Docker; every instance pulls its own linux/amd64 image of
about 1 GB (4 GB on disk), so run QUICK or named ids, not all."""
import json, pathlib, shutil, subprocess, tempfile, uuid
from . import Task

UV = ["uv", "run", "-q", "--no-project", "--python", "3.12"]
PARQUET = "data/test-00000-of-00001.parquet"
KEEP = ["instance_id", "repo", "base_commit", "problem_statement", "patch", "difficulty", "image"]
DUMP = "import json, sys, pyarrow.parquet as pq; json.dump(pq.read_table(sys.argv[1], columns=sys.argv[2:]).to_pylist(), sys.stdout)"
MODEL = "plusplus"  # the harness files its logs under this name
# One instance of each level per round, so --tasks 4 spans all four labels; within a level, the instances that the
# published runs of small and large models disagree on come first.
QUICK = ["sphinx-doc__sphinx-8621", "pylint-dev__pylint-6386", "sympy__sympy-12489", "sympy__sympy-13878",
         "astropy__astropy-7166", "pytest-dev__pytest-5631", "pytest-dev__pytest-5787",
         "pallets__flask-5014", "sphinx-doc__sphinx-8035", "pylint-dev__pylint-8898"]
PROMPT = """You are in a checkout of the GitHub repository {repo} at commit {base_commit}. Resolve the issue below by editing the repository's source files.

Rules:
- Change only non-test source files; do not add, edit or delete tests. Hidden tests from the project's own test suite decide whether the issue is resolved.
- You cannot execute code here. Find the relevant code by reading and searching, then make the smallest correct change.
- When you are done, stop. Your edits on disk are the answer.

<issue>
{issue}
</issue>"""


def rows(data):
    cache = data / "rows.json"
    if not cache.exists():  # the parquet needs pyarrow, which the runner's own python lacks: read it once through uv
        out = subprocess.run([*UV, "--with", "pyarrow", "python", "-I", "-c", DUMP, str(data / PARQUET), *KEEP], check=True, capture_output=True, timeout=600)
        cache.write_bytes(out.stdout)
    return json.loads(cache.read_text())


def checkout(data, row, d):
    repo = data / "repos" / row["instance_id"]
    if not repo.exists():  # fetched once and copied from then on; depth 1 keeps the fixing commit out of the history
        repo.parent.mkdir(exist_ok=True); tmp = pathlib.Path(tempfile.mkdtemp(dir=repo.parent))
        try:
            for argv in (["init", "-q"], ["fetch", "-q", "--depth", "1", f"https://github.com/{row['repo']}.git", row["base_commit"]], ["checkout", "-q", "FETCH_HEAD"]):
                subprocess.run(["git", "-C", str(tmp), *argv], check=True, capture_output=True, timeout=600)
            tmp.rename(repo)
        except OSError: pass  # another job got there first
        finally: shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(repo, d, dirs_exist_ok=True, symlinks=True)


def check(data, row, d):
    try:
        iid, image = row["instance_id"], row["image"]
        git = lambda *argv: subprocess.run(["git", "-C", str(d), *argv], check=True, capture_output=True, timeout=300).stdout
        git("add", "-A")  # the flags below keep the user's own git settings out of the patch; bytes, so CRLF lines survive
        patch = git("diff", "--cached", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "HEAD").decode(errors="replace")
        if not patch.strip(): return False  # the harness calls an empty patch unresolved without starting a container
        run = f"{iid}.{uuid.uuid4().hex[:8]}"  # unique, because the harness reuses any report it finds under the same run id
        out = data / "eval" / run; out.mkdir(parents=True)  # kept, to tell a wrong patch from a broken Docker afterwards
        (out / "preds.jsonl").write_text(json.dumps({"instance_id": iid, "model_name_or_path": MODEL, "model_patch": patch}) + "\n")
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=60).returncode:
            # the images are amd64 only and the harness's own pull does not ask for that, so it fails on an arm64 host
            subprocess.run(["docker", "pull", "-q", "--platform", "linux/amd64", image], check=True, capture_output=True, timeout=3600)
        log = subprocess.run([*UV, "--with", "swebench==5.0.2", "--directory", str(out), "python", "-I", "-m", "swebench.harness.run_evaluation",
                              "-d", str(data / PARQUET), "-s", "test", "-i", iid, "-p", "preds.jsonl", "--run_id", run, "--max_workers", "1", "--timeout", "900"],
                             capture_output=True, timeout=1500)
        (out / "harness.log").write_bytes(log.stdout + log.stderr)
        return json.loads((out / "logs/run_evaluation" / run / MODEL / iid / "report.json").read_text())[iid]["resolved"] is True
    except Exception:
        return False  # no Docker, no image, a patch that does not apply, a timeout: none of them is a resolved issue


def solve(row, d):
    subprocess.run(["git", "-C", str(d), "apply"], input=row["patch"].encode(), check=True, capture_output=True, timeout=60)


def tasks(data):
    data = data.resolve()  # the harness runs in another directory
    # psf/requests is left out: its tests call httpbin.org, so a verdict would depend on the network
    return [Task(r["instance_id"], PROMPT.format(issue=r["problem_statement"].replace("\r\n", "\n"), **r), lambda d, r=r: checkout(data, r, d),
                 lambda d, r=r: check(data, r, d), lambda d, r=r: solve(r, d), level=r["difficulty"])
            for r in rows(data) if r["repo"] != "psf/requests"]
