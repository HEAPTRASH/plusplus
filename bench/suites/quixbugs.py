"""QuixBugs, the Python half (github.com/jkoppel/QuixBugs, MIT): 40 classic algorithms from the Quixey Challenge, each with a one-line
defect. The agent gets the one buggy file, whose trailing docstring is the spec. The check runs upstream's own pytest file for that
program against the agent's copy, in a directory built afterwards, through uv (Python 3.12, pytest, pytest-timeout). Upstream has no
difficulty labels, so level stays empty: every task is the easy end, one read and one edit in a file of 17 to 64 lines."""
import os, pathlib, shutil, signal, subprocess, tempfile
from . import Task

NAMES = ("bitcount breadth_first_search bucketsort depth_first_search detect_cycle find_first_in_sorted find_in_sorted flatten gcd get_factors "
         "hanoi is_valid_parenthesization kheapsort knapsack kth lcs_length levenshtein lis longest_common_subsequence max_sublist_sum mergesort "
         "minimum_spanning_tree next_palindrome next_permutation pascal possible_change powerset quicksort reverse_linked_list rpn_eval "
         "shortest_path_length shortest_path_lengths shortest_paths shunting_yard sieve sqrt subsequences to_base topological_ordering wrap").split()
QUICK = NAMES[::3]  # 14 of 40: three of the nine graph programs, the longest file, and one that never returns until fixed (bitcount)
PROMPT = ("The file `{0}.py` implements `{0}`. The docstring at the end of the file describes what it should do. The implementation has a "
          "one-line defect: a single line is wrong or missing. Find the bug and fix it by editing `{0}.py`. Keep the function's name and "
          "signature and do not create other files.")
# -x so that a program that hangs costs one timeout, not one per case; 30 s because the correct levenshtein is exponential by design
PYTEST = ["uv", "run", "--no-project", "--python", "3.12", "--with", "pytest==9.1.1", "--with", "pytest-timeout==2.4.0",
          "pytest", "-q", "-x", "-p", "no:cacheprovider", "--timeout=30"]


def check(data, name, d):
    try:
        with tempfile.TemporaryDirectory(prefix="ae-quixbugs-", ignore_cleanup_errors=True) as v:  # upstream's layout, never inside d
            v = pathlib.Path(v)
            for sub in ("python_programs", "python_testcases", "json_testcases"): (v / sub).mkdir()
            shutil.copy(d / f"{name}.py", v / "python_programs")
            shutil.copy(data / "conftest.py", v)
            for f in ("load_testdata.py", "node.py", f"test_{name}.py"): shutil.copy(data / "python_testcases" / f, v / "python_testcases")
            cases = data / "json_testcases" / f"{name}.json"  # the nine graph programs have their cases in the test file instead
            if cases.exists(): shutil.copy(cases, v / "json_testcases")
            p = subprocess.Popen([*PYTEST, f"python_testcases/test_{name}.py"], cwd=v, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                return p.wait(300) == 0
            except subprocess.TimeoutExpired:  # a hang at import, which pytest-timeout does not cover
                os.killpg(p.pid, signal.SIGKILL); p.wait()  # the whole group: killing uv alone leaves its pytest running
                return False
    except Exception:
        return False


def tasks(data):
    if not shutil.which("uv"): raise SystemExit("quixbugs: uv must be on PATH, the checks run pytest through it")
    return [Task(n, PROMPT.format(n), lambda d, n=n: shutil.copy(data / "python_programs" / f"{n}.py", d),
                 lambda d, n=n: check(data, n, d), lambda d, n=n: shutil.copy(data / "correct_python_programs" / f"{n}.py", d))
            for n in NAMES]
