"""RefactorBench (Microsoft, ICLR 2025; github.com/microsoft/RefactorBench): 100 multi-file refactorings of nine Python
repositories (renames, signature changes, code moved between modules). A task is the authors' descriptive instruction on
their static copy of the repository. It passes when their standard-library test, which parses the edited source for the
expected shape without running it, exits 0 and no file the agent rewrote has stopped compiling. Upstream withholds the
solutions: --selftest downloads them once from the authors' forks (github.com/dhruvji/<project>_refactor), one pinned
commit per task, into reference_patches/ beside the data."""
import ast, filecmp, shutil, subprocess, urllib.request
from . import Task

UV = ["uv", "run", "-q", "--no-project", "--python", "3.11"]  # some tests use ast.Str and ast.NameConstant, gone in 3.12
# Per project: the fork's default-branch commit, then one entry per task in sorted id order: the commit holding the
# reference solution, how many source files that touches, + if it adds a file and - if it removes one.
REFS = {
    "ansible": "68515abf97 b59cec7879:3 c3d24df9df:3 02fdfff6d3:7- 13c861634b:3+- 66e5783520:6- 575a7d7aa8:3+ 935d76e7f3:3 6c85785ffa:13+ d900a89f79:10 744c338a94:3+- 0456b36387:2",
    "celery": "78ac69cfed 055136874d:2 e282408773:3 52fc56bc85:2+ d70e674e7b:6+- cc6f3164d0:4 f66afaa44c:2 5673314ddf:4 55e86e3579:2 41c5e43b0e:2 e04361ae4a:1 f5fdf451d7:3 f6d60feea5:7",
    "django": "81b368bf7a 07c48f7b0e:7 02d888ce27:11 9198ba5255:4 bab02d1c13:3 b94fd7acad:4- 67f2342692:14+- f609b665b9:3 11619f6f8b:7 40f5020d2c:3 d781467c9b:5 "
              "c4ff327d59:3 0d7814984f:2+ 89827a62c8:2+ c9dd2d2260:2+ 04b8bb96dc:4- 731f59bce1:22- db6d4efc0a:5 9b51134449:3",
    "fastapi": "d0ce9d2bdf 077c6344af:2 cc170c8452:10+- 053cc596c4:3 681ca34e03:7+- 34ae3232bf:9+- 2ef679df97:2",
    "flask": "8a6cdf1e2a 8d12ca00fa:4 347327860a:2 130a0ecded:4 3e44150273:4 1c5f345cce:8 1fe29b1453:2",
    "requests": "79b74ef704 52211d01ab:3 fbf7dbefc2:2 4936831218:2 4b07ac084c:4 0f1e3e1c2d:7- 8e677661a7:5- f86537ff87:7 0cc7c5f2e1:3 93e1a821ac:3 57ad62520f:4+",
    "salt": "246d066457 1b5cb628bf:2 140e3ffe79:2 55d026d011:2 250f957605:3 2b1653a21a:3+- 6568f51031:3 9a65f40020:3 ae2b651c42:1 "
            "c12f29e253:4 ec3129e4c1:2- f871722d25:3 31aa23e4b6:2 162b00c9df:1 5bb8b7434f:9 65714a061a:2",
    "scrapy": "b9ef1326a5 b9023ba6be:3 15b9fcbcaa:4 0b9f6f47cd:2 921e348d32:2 9f0dc267bb:2+ bce3a06c51:3+ 4c0f638ce1:6 32afc00712:6 d0141fbac9:5 65d9acc0e5:17 8be774612c:6 66b70168fc:5 7e2f5952f4:4",
    "tornado": "1f8b2d78fe 9e13ade1d1:4+ 2966ffbec5:6+ 11b86ac54f:3 feab29c1db:31+ ec432c928b:2- 52558cde74:5 d2f6db07de:2 1cb1a2ae48:13+ f095d54be2:7+",
}
# per project, of the tasks that need no file added or removed: the one whose reference touches the fewest files, and the most
QUICK = ("ansible/sort-groups-to-group-sort ansible/parse_key_value celery/object-mro-lookup celery/truncate-text "
         "django/add-none-handling-duration-string django/add-log-parameter-get-resolver fastapi/add-log-parameter-generate-option-id-for-path "
         "fastapi/get-auth-scheme-param flask/add-log-parameter-get-flashed-messages flask/render-template-str "
         "requests/add-log-parameter-resolve-proxies requests/new-cookie-utils-class salt/exactly-n-boto-mod salt/pem-fingerprint "
         "scrapy/add-log-parameter-xmliter scrapy/rename-description-commands tornado/rename-to-camel-case tornado/rename-http1connection").split()
# argv is new old new old ...: exits 1 when a file stopped compiling (one that never compiled is not held against the agent)
COMPILES = """import sys
def ok(path):
    try: compile(open(path, "rb").read(), path, "exec"); return True
    except (SyntaxError, ValueError): return False
    except OSError: return None
sys.exit(any(ok(new) is False and ok(old) is not False for new, old in zip(sys.argv[1::2], sys.argv[2::2])))"""


def check(d, start, test):
    try:
        py = [(f, start / f.relative_to(d)) for f in d.rglob("*.py") if f.is_file() and not f.is_symlink()]
        changed = [str(x) for new, old in py if not (old.is_file() and filecmp.cmp(new, old)) for x in (new, old)]
        (d / "task_test").mkdir(exist_ok=True); shutil.copy(test, d / "task_test")  # the tests open ../<path in the repository>
        uv = lambda *argv: subprocess.run([*UV, *argv], capture_output=True, timeout=120).returncode == 0
        return uv("python", "-I", "-c", COMPILES, *changed) and uv("--directory", str(d / "task_test"), "python", "-I", test.name)
    except Exception:
        return False


def solve(d, patch, url):
    if not patch.exists():
        patch.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as r: part = patch.with_suffix(".part"); part.write_bytes(r.read())
        part.replace(patch)
    # the solution branch also carries the instruction and the test, which are not part of the solution
    for argv in (["init", "-q"], ["apply", "--whitespace=nowarn", "--exclude=task.txt", "--exclude=task_test/*", str(patch)]):
        subprocess.run(["git", *argv], cwd=d, check=True, capture_output=True, timeout=120)


def tasks(data, problems="descriptive"):  # or "base" / "lazy": the same tasks with the authors' terser instructions
    root = data / "RefactorBench" if (data / "RefactorBench").is_dir() else data  # fetch.py checks out into data itself
    # test path: problem path, both written as ../<path>; test file names do not always follow the task's
    mapping = ast.literal_eval(ast.parse((root / "scripts" / f"{problems}_mapping.py").read_text()).body[0].value)

    def task(name, base, id, test, problem, ref):
        repo = f"{name}_refactor"; start = root / "repositories" / repo; sha, files = ref.rstrip("+-").split(":")
        patch, url = data / "reference_patches" / repo / f"{id}.diff", f"https://github.com/dhruvji/{repo}/compare/{base}...{sha}.diff"
        prompt = (f"{(root / problem).read_text().strip()}\n\nThe current directory is the root of the {name} source repository. "
                  "Apply this refactoring by editing the files in place. Do not run the test suite and do not commit.")
        return Task(f"{name}/{id}", prompt, lambda d: shutil.copytree(start, d, symlinks=True, dirs_exist_ok=True),
                    lambda d: check(d, start, root / test), lambda d: solve(d, patch, url),
                    tuple(tool for flag, tool in (("+", "Write"), ("-", "Bash")) if flag in ref),  # edit tools cannot create or delete a file
                    "1-2 files" if int(files) < 3 else "3-5 files" if int(files) < 6 else "6+ files")

    out = []
    for name, (base, *refs) in ((name, refs.split()) for name, refs in REFS.items()):
        mine = sorted((problem.rsplit("/", 1)[1].removesuffix("-task.txt"), test[3:], problem[3:])
                      for test, problem in mapping.items() if f"/{name}_refactor/" in test)
        out += [task(name, base, *row, ref) for row, ref in zip(mine, refs, strict=True)]
    return out
