"""Break run.py's rows down by the suite's own difficulty level, and set the router's grade against it.
usage: python3 levels.py <rows.json>...
Prints, per arm and per level, runs, correct and cost; then, for each arm whose rows carry routes, the class the router
gave the main thread (the first "main:<class>><model> <effort>" route) against the suite's level, as correct/runs, so one
can see whether the grades track the benchmark's labels and where routed-down tasks fail. Rows without a level go under "-";
a run with no answer counts as a miss that cost nothing."""
import json, sys


def level(r):
    return "-" if r.get("level") is None else str(r["level"])


def cls(r):
    main = [x for x in r.get("routes", []) if x.startswith("main:")]
    return main[0][5:].split(">")[0] if main else "(none)"


def tally(rs):
    return f"{sum(bool(r.get('ok')) for r in rs)}/{len(rs)}"


def report(rows):
    order = lambda xs: sorted(set(xs), key=lambda x: (x == "-", not x.isdigit(), int(x) if x.isdigit() else x))
    names, levels = list(dict.fromkeys(r["arm"] for r in rows)), order(level(r) for r in rows)
    print(f"{'arm':<10}{'level':<12}{'runs':>6}{'correct':>9}{'cost $':>9}{'per run $':>11}")
    for arm in names:
        for lv in [*levels, "all"]:
            rs = [r for r in rows if r["arm"] == arm and lv in (level(r), "all")]
            if rs:
                cost = sum(r.get("cost", 0) for r in rs)
                print(f"{arm:<10}{lv[:11]:<12}{len(rs):>6}{tally(rs):>9}{cost:>9.3f}{cost / len(rs):>11.3f}")
    for arm in names:
        rs = [r for r in rows if r["arm"] == arm]
        if not any(r.get("routes") for r in rs): continue
        cols = [lv for lv in levels if any(level(r) == lv for r in rs)]
        print(f"\n{arm}: main-thread class (rows) against level (columns), correct/runs")
        print(f"{'class':<14}" + "".join(f"{lv[:9]:>10}" for lv in [*cols, "all"]))
        for c in [*sorted({cls(r) for r in rs}, key=lambda c: (c == "(none)", c)), "all"]:
            mine = [r for r in rs if c in (cls(r), "all")]
            cell = lambda lv: tally(sel) if (sel := [r for r in mine if lv in (level(r), "all")]) else "."
            print(f"{c[:13]:<14}" + "".join(f"{cell(lv):>10}" for lv in [*cols, "all"]))


if __name__ == "__main__":
    if len(sys.argv) < 2: sys.exit(__doc__)
    report([r for f in sys.argv[1:] for r in json.load(open(f))])
