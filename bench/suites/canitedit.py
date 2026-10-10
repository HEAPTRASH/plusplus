"""CanItEdit (huggingface.co/datasets/nuprl/CanItEdit, MIT; arxiv.org/abs/2312.12450): edit one small Python file as instructed,
judged by hidden asserts. Each problem gives two tasks: "<n>_<name>" with the descriptive instruction and "<n>_<name>.lazy" with
the terse one. The check mirrors the official evaluator (github.com/nuprl/CanItEdit running MultiPL-E's evaluation/src, both BSD
3-Clause with a no-training clause): the edited file with the tests appended runs as one script, and exit status 0 within 15
seconds is a pass. It runs through uv on Python 3.14 with six pinned packages, which covers 98 of the 105 problems. The dataset
has no difficulty label, so level stays empty."""
import functools, json, os, pathlib, signal, subprocess, tempfile, threading
from . import Task

UV = ["uv", "run", "--quiet", "--no-project", "--python", "3.14"]
PINS = "numpy==2.5.3 pandas==3.0.6 scipy==1.18.1 scikit-learn==1.9.1 z3-solver==5.1.0.0 autograd==1.9.1"
PY = [*UV, *(arg for pin in PINS.split() for arg in ("--with", pin)), "python", "-I"]
# left out: four need torch, 78 needs vllm (Linux with a GPU) and flask, 47 and 60 assert a 10% speed-up that timing noise decides either way
SKIP = {26, 30, 41, 98, 78, 47, 60}
PROMPT = ("Edit the Python program in {name}.py as instructed. Edit that file in place; do not create other files, and do not add tests, "
          "example usage or an `if __name__ == \"__main__\":` block.\n\nInstruction:\n{instruction}")
# the five longest standard-library-only problems of each change kind, taking a bug fix, a new feature and a refactoring in turn
QUICK = ("114_grid_world_dp 56_interference_vars 53_minimax_to_alphabeta 85_dpll 97_nash_equilibrium 44_html_to_markdown 104_filesystem "
         "19_traffic_analysis 22_diff_format 120_summary_statistics 112_elliptic_curves 58_dependency_solver 106_conways_game 31_bookkeeping "
         "13_maze_solver").split()
lock = threading.Lock()


def rows(data):
    """The problems in number order. Reading parquet takes pyarrow, so uv converts the download once into a JSON cache beside it."""
    cache = data / "rows.json"
    if not cache.exists():
        dump = "import json, sys, pyarrow.parquet as pq; json.dump(pq.read_table(sys.argv[1]).to_pylist(), sys.stdout)"
        out = subprocess.run([*UV, "--with", "pyarrow==26.0.0", "python", "-I", "-c", dump, str(data / "data/test-00000-of-00001.parquet")],
                             stdout=subprocess.PIPE, text=True, check=True, timeout=900).stdout
        tmp = cache.with_suffix(".tmp"); tmp.write_text(out); tmp.replace(cache)
    return sorted(json.loads(cache.read_text()), key=lambda r: r["id"])


@functools.cache
def warm():
    """Builds the test environment with time to spare: a first uv run downloads some 270 MB, which must not eat a check's 15 seconds."""
    subprocess.run([*PY, "-c", "import numpy, pandas, scipy, sklearn, z3, autograd"], stdout=subprocess.DEVNULL, check=True, timeout=1800)


def passes(program, timeout=15):
    """Exit status 0 in time. The script gets its own process group, ended afterwards: killing uv alone leaves a hung script running."""
    p = subprocess.Popen([*PY, str(program)], cwd=program.parent, env={**os.environ, "UV_OFFLINE": "1"}, start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return p.wait(timeout) == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):  # SIGTERM first, so that uv removes its temporary environment
            try: os.killpg(p.pid, sig); p.wait(3)
            except (OSError, subprocess.TimeoutExpired): pass


def check(d, r):
    try:
        with tempfile.TemporaryDirectory(prefix="ae-check-", ignore_cleanup_errors=True) as tmp:  # the tests never enter the agent's directory
            program = pathlib.Path(tmp) / "program.py"
            # appended, not imported: some tests read their own module's source or walk the call stack
            program.write_text((d / f"{r['name']}.py").read_text("utf-8") + "\n" + r["tests"], "utf-8")
            return passes(program)
    except Exception:
        return False


def write(d, r, key):
    (d / f"{r['name']}.py").write_text(r[key] + "\n", "utf-8")  # the dataset's programs end without a newline


def setup(d, r):
    with lock: warm()  # here and not in check, so that a missing uv stops the run before a model is paid
    write(d, r, "before")


def tasks(data):
    return [Task(r["full_name"] + suffix, PROMPT.format(name=r["name"], instruction=r[key]),
                 lambda d, r=r: setup(d, r), lambda d, r=r: check(d, r), lambda d, r=r: write(d, r, "after"))
            for r in rows(data) if r["id"] not in SKIP for suffix, key in (("", "instruction_descriptive"), (".lazy", "instruction_lazy"))]
