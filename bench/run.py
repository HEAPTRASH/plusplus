"""Live benchmark runner: one public suite under headless Claude, several arms, every run checked without a model.
usage: python3 run.py <suite> [--arms standard,anchored,routed] [--model sonnet] [--effort E] [--reps 2]
                              [--tasks quick|all|N|id,id] [--jobs 3] [--tag v1] [--budget 2] [--timeout 900]
       python3 run.py <suite> --selftest   # no model: each task must fail untouched and pass with its reference solution
Suites are suites/<name>.py, each exposing tasks(data) -> [Task] and optionally QUICK (task ids); fetch.py downloads
their data into data/<name>. Arms: standard (built-in tools), anchored (the mod, router off), routed (router on, graded by
the session's small model), jev (router on, graded by TypeSafe's Jev)."""
import argparse, concurrent.futures as cf, importlib, json, pathlib, re, shutil, subprocess, sys, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
MOD = str(HERE.parent / "mod")
READ, EDIT = "mcp__plusplus__read", "mcp__plusplus__edit"
COMMON = ["--setting-sources", "project", "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]


def arms(extra, mod_dir):
    search = ["Grep", "Glob", *extra]
    mod = lambda router, grader="haiku": (["--tools", ",".join(search), "--plugin-dir", mod_dir, "--allowedTools", ",".join([*search, READ, EDIT])],
                                          {"codegraph": "off", "router": router, "routerGrader": grader, "specs": "off"})
    builtin = ",".join(["Read", "Edit", *search])
    return {"standard": (["--tools", builtin, "--allowedTools", builtin], None), "anchored": mod("off"), "routed": mod("on"),
            "jev": mod("on", "jev")}  # the router graded by TypeSafe's Jev: needs TYPESAFE_API_KEY in the environment


def workdir():
    d = pathlib.Path(tempfile.mkdtemp(prefix="ae-bench-")) / "work"
    d.mkdir()
    return d


def run(task, arm, rep, a, runs):
    d = workdir(); log = d.parent / "routes.json"  # where the router writes what it decided
    flags, options = arms(task.tools, a.mod)[arm]
    settings = ["--settings", json.dumps({"pluginConfigs": {"plusplus": {"options": dict(options, routerLog=str(log))}}})] if options else []
    argv = ["claude", "-p", task.prompt, "--model", a.model, *(["--effort", a.effort] if a.effort else []),
            "--max-budget-usd", str(a.budget), *COMMON, *flags, *settings]
    row, t0 = dict(task=task.id, arm=arm, **({"level": task.level} if getattr(task, "level", None) is not None else {})), time.time()
    try:
        task.setup(d)
        try:
            out = subprocess.run(argv, cwd=d, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=a.timeout)
        except subprocess.TimeoutExpired:
            return dict(row, ok=False, failed=f"no answer in {a.timeout}s")
        (runs / f"{re.sub(r'[^\w.-]', '_', task.id)}-{arm}-{rep}.jsonl").write_text(out.stdout)
        try:
            r = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")][-1]; u = r["usage"]
        except Exception:
            return dict(row, ok=False, failed=out.stdout[-300:] + out.stderr[-300:])
        routes = [f"{'main' if x['who'] == 'main' else 'agent'}:{x['cls']}>{x['model']} {x.get('effort', '')}".strip() for x in json.loads(log.read_text())["routes"]] if log.exists() else []
        return dict(row, ok=bool(task.check(d)), turns=r["num_turns"], out=u["output_tokens"],
                    inp=u["input_tokens"] + u["cache_creation_input_tokens"] + u["cache_read_input_tokens"], cost=r["total_cost_usd"],
                    secs=round(time.time() - t0), models={m: round(v.get("costUSD", 0), 4) for m, v in r.get("modelUsage", {}).items()},
                    **({"routes": routes} if routes else {}))
    except Exception as e:  # a bad task (setup or check blew up) costs its own row, not the run
        return dict(row, ok=False, failed=f"{type(e).__name__}: {e}")
    finally:
        shutil.rmtree(d.parent, ignore_errors=True)


def selftest(tasks):
    bad = 0
    for t in tasks:
        d = workdir(); t.setup(d); untouched = t.check(d); shutil.rmtree(d.parent, ignore_errors=True)
        solved = None
        if t.solve:
            d = workdir(); t.setup(d); t.solve(d); solved = t.check(d); shutil.rmtree(d.parent, ignore_errors=True)
        ok = not untouched and solved is not False
        bad += not ok
        print(f"{'ok  ' if ok else 'BAD '}{t.id:<40} untouched {'passes' if untouched else 'fails'}, "
              f"reference {'missing' if solved is None else 'passes' if solved else 'fails'}", flush=True)
    print(f"\n{len(tasks) - bad}/{len(tasks)} tasks discriminate")
    sys.exit(bad > 0)


def report(rows, tasks, names):
    done = [r for r in rows if "failed" not in r]
    print(f"\n{'task':<32}{'arm':<10}{'correct':>8}{'turns':>7}{'output tok':>11}{'input tok':>11}{'cost $':>8}")
    for t in tasks:
        for arm in names:
            rs = [r for r in done if r["task"] == t.id and r["arm"] == arm]
            if rs:
                avg = lambda k: sum(r[k] for r in rs) / len(rs)
                print(f"{t.id[:31]:<32}{arm:<10}{sum(r['ok'] for r in rs):>5}/{len(rs)}{avg('turns'):>7.1f}{avg('out'):>11.0f}{avg('inp'):>11.0f}{avg('cost'):>8.3f}")
    for arm in names:
        rs, lost = [r for r in done if r["arm"] == arm], sum(r["arm"] == arm for r in rows if "failed" in r)
        cost, solved = sum(r["cost"] for r in rs), sum(r["ok"] for r in rs)
        by_model = {}
        for r in rs:
            for m, c in r["models"].items(): by_model[m] = by_model.get(m, 0) + c
        # a run with no answer is a miss that cost nothing we can count: it lowers correct, not cost
        print(f"TOTAL {arm:<9} correct {solved}/{len(rs) + lost}  output {sum(r['out'] for r in rs)}  input {sum(r['inp'] for r in rs)}  "
              f"cost ${cost:.3f}  per solved ${cost / solved if solved else float('nan'):.3f}  "
              + " ".join(f"{m} ${c:.3f}" for m, c in sorted(by_model.items())))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("suite"); p.add_argument("--arms", default="standard,anchored"); p.add_argument("--model", default="sonnet")
    p.add_argument("--effort"); p.add_argument("--reps", type=int, default=2); p.add_argument("--tasks", default="quick")
    p.add_argument("--jobs", type=int, default=3); p.add_argument("--tag", default="v1"); p.add_argument("--budget", type=float, default=2.0)
    p.add_argument("--timeout", type=int, default=900); p.add_argument("--selftest", action="store_true")
    p.add_argument("--mod", default=MOD, help="the mod folder to load, when not this repo's")
    a = p.parse_args()
    suite = importlib.import_module(f"suites.{a.suite}")
    tasks = suite.tasks(HERE / "data" / a.suite)
    quick = getattr(suite, "QUICK", None)
    if a.tasks == "quick" and quick: tasks = [t for i in quick for t in tasks if t.id == i]
    elif a.tasks.isdigit(): tasks = ([t for i in quick for t in tasks if t.id == i] if quick else tasks)[:int(a.tasks)]
    elif a.tasks not in ("quick", "all"): tasks = [t for i in a.tasks.split(",") for t in tasks if t.id == i]
    if a.selftest: selftest(tasks)
    names = a.arms.split(",")
    runs = HERE / "runs" / f"{a.suite}-{a.model}-{a.tag}"; runs.mkdir(parents=True, exist_ok=True)
    rows = []
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        for row in ex.map(lambda j: run(*j, a, runs), [(t, arm, rep) for t in tasks for arm in names for rep in range(a.reps)]):
            rows.append(row); print(json.dumps(row), flush=True)
            (runs / "rows.json").write_text(json.dumps(rows, indent=1))  # after every row, so an interrupted run keeps its results
    report(rows, tasks, names)
