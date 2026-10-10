"""Aider's polyglot benchmark, the Python and JavaScript part: 82 Exercism practice exercises, each a one-file stub to implement
from the exercise text and graded by the exercise's own unit tests, which the agent never sees. The exercises come from
github.com/Aider-AI/polyglot-benchmark, which has no licence file of its own: they are copyright Exercism and MIT in the tracks
they were taken from. The prompt is the exercise text plus the addendum from aider's benchmark/prompts.py, and the check mirrors
its benchmark.py and npm-test.sh (github.com/Aider-AI/aider, Apache-2.0): pytest on Python 3.11, or jest with the xtest cases
switched on, 180 seconds either way. One attempt per task: aider's second try, which feeds the test output back once, is not
run. Left out: javascript/ledger, whose stub already passes, and the C++, Go, Java and Rust exercises. Needs uv, node and npm;
the first run installs jest into the data directory."""
import json, os, pathlib, re, shutil, signal, subprocess, tempfile
from . import Task

# Exercism's difficulty for each exercise, 1 (easiest) to 10: config.json of exercism/python @ 6105f6d and exercism/javascript @ 65a60ca
LEVELS = {
    "python": {
        1: "list-ops",
        2: "phone-number pig-latin proverb robot-name transpose",
        3: "beer-song bottle-song connect grade-school poker simple-linked-list tree-building wordy",
        4: "food-chain go-counting grep hangman scale-generator variable-length-quantity",
        5: "bowling dot-dsl forth zebra-puzzle",
        6: "affine-cipher react two-bucket zipper",
        7: "book-store dominoes paasio sgf-parsing",
        8: "rest-api",
        9: "pov",
    },
    "javascript": {
        2: "space-age",
        3: "phone-number scale-generator tournament transpose triangle",
        4: "affine-cipher binary complex-numbers food-chain grep house pig-latin queen-attack rectangles twelve-days",
        5: "beer-song book-store bottle-song go-counting grade-school killer-sudoku-helper ocr-numbers rational-numbers "
           "resistor-color-trio state-of-tic-tac-toe sum-of-multiples variable-length-quantity",
        6: "list-ops promises rest-api robot-name say two-bucket",
        7: "alphametics connect meetup palindrome-products parallel-letter-frequency poker wordy zebra-puzzle",
        8: "bowling forth react simple-linked-list word-search zipper",
    },
}
# per language, the 8 evenly spaced ranks by (level, name); ordered so that any prefix mixes both languages and both ends of the range
QUICK = ["python/list-ops", "javascript/zipper", "python/pov", "javascript/space-age",
         "python/variable-length-quantity", "javascript/grade-school", "python/grade-school", "javascript/alphametics",
         "python/affine-cipher", "javascript/queen-attack", "python/transpose", "javascript/wordy",
         "python/book-store", "javascript/binary", "python/food-chain", "javascript/variable-length-quantity"]
# aider's instructions_addendum, word for word
ADDENDUM = """
####

Use the above instructions to modify the supplied files: {}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.
"""
PYTEST = ["uv", "run", "--no-project", "--python", "3.11", "--with", "pytest==9.1.1", "pytest", "-p", "no:cacheprovider"]
JEST = ["jest@29.7.0", "@babel/core@7.25.2", "@exercism/babel-preset-javascript@0.2.1", "babel-jest@29.6.4", "core-js@3.37.1"]
SPOILERS = shutil.ignore_patterns(".meta", ".docs", ".approaches", ".articles")


def passes(argv, cwd):
    # its own process group, so that aider's 180 s limit also stops the test runner that uv or npm started
    p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        return p.wait(180) == 0
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait()
        return False


def check(ex, stubs, d, jest):
    v = pathlib.Path(tempfile.mkdtemp(prefix="ae-polyglot-")) / ex.name
    try:
        # the pristine exercise without its reference solution, then only the files the agent was given: nothing else it wrote counts
        shutil.copytree(ex, v, ignore=SPOILERS)
        for f in stubs:
            if (d / f).is_file(): shutil.copy(d / f, v / f)
        if not jest: return passes(PYTEST, v)
        for spec in v.glob("*.spec.js"):  # as npm-test.sh does: xit and test.skip cases stay skipped
            spec.write_text(re.sub(r"\bxtest\(", "test(", spec.read_text()))
        (v / "node_modules").symlink_to(jest)
        return passes(["npm", "run", "test"], v)
    except Exception:
        return False
    finally:
        shutil.rmtree(v.parent, ignore_errors=True)


def task(data, lang, name, level):
    ex = data / lang / "exercises/practice" / name
    files = json.loads((ex / ".meta/config.json").read_text())["files"]  # file names come from here, not from the exercise's name
    stubs, docs = files["solution"], [ex / ".docs" / n for n in ("introduction.md", "instructions.md", "instructions.append.md")]
    return Task(f"{lang}/{name}", "".join(p.read_text() for p in docs if p.exists()) + ADDENDUM.format(" ".join(stubs)),
                setup=lambda d: [shutil.copy(ex / f, d / f) for f in stubs],
                check=lambda d: check(ex, stubs, d, data / "npm-install/node_modules" if lang == "javascript" else None),
                solve=lambda d: [shutil.copy(ex / e, d / f) for f, e in zip(stubs, files["example"])], level=str(level))


def tasks(data):
    out = [task(data, lang, name, level) for lang, levels in LEVELS.items() for level, names in levels.items() for name in names.split()]
    # both toolchains once, up front: a missing one should stop the run, not be counted as wrong answers
    subprocess.run([*PYTEST, "--version"], check=True, stdout=subprocess.DEVNULL, timeout=600)
    if not (data / "npm-install/node_modules/.bin/jest").exists():  # one install shared by every exercise, as in aider's image
        subprocess.run(["npm", "install", "--prefix", str(data / "npm-install"), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", *JEST],
                       check=True, stdout=subprocess.DEVNULL, timeout=900)
    return out
