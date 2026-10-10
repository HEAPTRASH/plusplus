# plusplus

A Claude Code mod that makes sessions cheaper in tokens, turns and dollars. Four parts, each usable by itself:

## Anchored read and edit

- **Stable line IDs.** `read` returns `ID§code` lines. The IDs are numeric, permuted, and always above the file's line count, so a line number is never mistaken for one. A Myers diff keeps them stable across edits made by any tool.
- **Locate once.** `read` has three modes: `pattern` (a regex over a file or directory), `symbol` (a definition plus every reference, with the definition found through the code graph), and ranges. Everything it returns carries IDs, so the agent edits straight from the results.
- **Edit once.** One `edit` call can change many files, and create, delete or rename them (those three only inside the project). Every part is checked first, and nothing is changed if any of them fails. Edits can replace or insert lines by ID, or do find/replace within a range, a file or a directory. Results show only the new lines plus their neighbours, a syntax check, and warnings for duplicated boundary lines and lost indentation.
- **Shell edits steered back.** Models often rewrite files with a `sed -i` or a Python one-liner. The `shellEdits` setting decides what happens then: `warn` (default) lets the command run and tells the model to use `edit` next time, `enforce` refuses it with the `edit` call to make instead, `off` does nothing. Detection reads the command's text, so it is best effort: on a 217-command test set it flagged no ordinary command and missed some rarer spellings.
- **Live code graph** via [CodeGraph](https://github.com/colbymchenry/codegraph):
  - It is downloaded only after you agree in a first-run dialog (`/codegraph-setup` reopens it), then pinned to v1.6.2 and SHA-256 verified.
  - It installs to `~/.local/share/plusplus/codegraph`.
  - It is re-synced after every change: this mod's edits, built-in Edit/Write, and Bash commands that write.
  - Projects are only synced if they already have a `.codegraph/` folder; the mod never indexes a project itself.

## Model router

Each task is graded for how much reasoning it needs (mechanical, routine, involved, hard) and sent to the cheapest model trusted with it: Haiku, Sonnet, Opus, or wherever you put the session for hard work. It never goes above your own model or effort.

- **Where it acts.** A thread picks its model once, as it starts, and afterwards only moves up: a model's prompt cache is its own, so moving a long conversation down would make the new model write the whole context again. Effort follows each task freely, since changing it costs no cache. The savings therefore come from threads that start fresh: one-shot runs, subagents, and the agents of a dynamic workflow (Ultracode), each graded by its own task while the orchestrating thread keeps your seat.
- **What it leaves alone.** An agent whose model or effort was set explicitly, a custom agent type, a fork, verdict stages (verify, judge, review), and any turn you ask to think hard.
- **The grader** is the session's own small model by default (two short requests per task, about $0.0001). `jev` uses [TypeSafe's Jev](https://typesafe.ai) instead, which sends each task's text to api.typesafe.ai and needs a key.
- **Controls.** `/router setup` opens the settings pane (mode, floor, grader, Jev key, live figures); `/router` prints what was routed and what it cost at list price; `/router on | shadow | off`; `/router redo` asks the last prompt again on your own model. `shadow` decides and reports without changing anything.
- **It can cost correctness.** On the RefactorBench quick subset one wide multi-file rename that Opus solved was sent to Haiku and failed. Use `shadow` or the `sonnet` floor where that matters.

## Spec and decision tracker

A per-project tree of records (areas, specs, decisions) that the model consults before it touches governed code and adds to when it makes a decision later sessions must respect. Nothing exists until you run `/spec init`.

- **Records surface on their own**: the first time a thread reads or edits a file, the records governing it are attached to the tool result, one line each.
- **The `spec` tool** reads the tree, looks up a file or an id, searches, and adds records. A record an agent adds is `proposed` until a person accepts it.
- **Storage** is `.plusplus/specs/` in the repository, made of immutable files named by the hash of their content. A change lands as a small text segment (one JSON line per change, readable in a pull request); `/spec compact` seals segments into compressed binary packs (raw DEFLATE; `mod/tools/aesp.py` reads them with nothing but Python). Files are only ever added or sealed, so branches merge through git without conflicts.
- **Commands** work like git's: `/spec status`, `/spec log [id]`, `/spec show <id>`, `/spec diff [git ref]`, plus `/spec accept`, `/spec drop`, `/spec export`, `/spec browse` (a tree browser) and `/spec stats`. Branches, commits and merges stay git's.
- **`/spec init`** asks the agent to survey the codebase and propose a first tree, or to interview you when the repository is empty; `/spec init --bare` does neither.

## Install

At a Claude Code prompt in a terminal:

```
/plugin install plusplus --marketplace HEAPTRASH/plusplus
```

Answer `y` to add the marketplace, then pick a scope.

Settings (in the config menu, or under `pluginConfigs` in managed settings):
- `codegraph`: `ask` or `off`. `off` means no prompt and no download.
- `codegraphMirror`: a URL to download releases from instead of GitHub.
- `shellEdits`: `warn`, `enforce` or `off`.
- `router`: `on`, `shadow` or `off`; `routerFloor`: the cheapest model it may use; `routerGrader`: `haiku` or `jev`.
- `specs`: `auto`, `read` (agents may read but not add) or `off`.

## Develop

```sh
claude --plugin-dir mod          # run a session with the mod loaded from this folder
claude plugin validate mod       # what the engine would refuse
claude plugin test mod           # hooks/*.test.ts
```

`mod/hooks/register.tsx` is the hooks module; it wires in `routing.tsx` (router), `specs.ts` (tracker) and the panes in `panes.tsx` and `ui.tsx`. The pure logic is in `core.ts` (Myers diff, IDs, edits, the shell-edit judge), `router.ts`, `spec.ts`, `pack.ts` and `deflate.ts`.

## Benchmarks (`bench/`)

`bench/run.py` runs one public suite under headless Claude, once per arm, and checks every run without a model.

```sh
python3 bench/fetch.py refactorbench            # download a suite's data into bench/data/, at a pinned revision
python3 bench/run.py refactorbench --selftest   # no model: each task must fail untouched and pass with its reference solution
python3 bench/run.py refactorbench --arms standard,anchored,routed
```

Main flags of `run.py`, with their defaults:
- `--arms standard,anchored`: which arms to compare (below).
- `--tasks quick`: the suite's fixed quick subset. Also `all`, a number `N` (the first N), or a comma-separated list of task ids.
- `--model sonnet`, `--effort` (unset), `--reps 2` (runs per task and arm), `--jobs 3` (runs in parallel).
- `--budget 2` (dollars per run), `--timeout 900` (seconds per run).
- `--tag v1`: names the output folder, `bench/runs/<suite>-<model>-<tag>/`, which gets one transcript per run and `rows.json`.

Arms:
- `standard`: the built-in Read and Edit.
- `anchored`: the mod, router off.
- `routed`: the mod with the router on, graded by the session's small model.
- `jev`: the router graded by TypeSafe's Jev. Needs `TYPESAFE_API_KEY` in the environment.

Every arm also gets Grep and Glob, plus any built-in tool a task needs.

Suites (`bench/suites/`):
- `click`: 5 hand-written edit tasks on [click](https://github.com/pallets/click) 8.1.7 (renames, replacements and two small changes). A pass is the task's own Python check, and every file still compiles.
- `orchestrate`: 2 tasks that hand three of the click edits to subagents, or run them as a workflow with a verifier, so the router has agents to seat. A pass is all three edits passing their click checks. Uses the click data.
- `quixbugs`: 40 classic algorithms from [QuixBugs](https://github.com/jkoppel/QuixBugs) (Python half), each with a one-line defect; 14 in the quick subset. A pass is upstream's pytest file for that program.
- `canitedit`: [CanItEdit](https://huggingface.co/datasets/nuprl/CanItEdit), edit one small Python file as instructed. 98 of the 105 problems, each as two tasks (descriptive and terse instruction); 15 in the quick subset. A pass is the edited file with the hidden tests appended exiting 0 within 15 seconds.
- `polyglot`: the Python and JavaScript part of [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark), 82 Exercism exercises to implement from a one-file stub; 16 in the quick subset. A pass is the exercise's own unit tests (pytest or jest), which the agent never sees, in one attempt.
- `refactor`: [Aider's refactoring benchmark](https://github.com/Aider-AI/refactor-benchmark), 88 tasks that move a method out of its class into a top-level function in one real Python file of 91 to 22,390 lines; 16 in the quick subset. A pass is upstream's syntax-tree node-count test, plus a check that the method was moved rather than copied and the file compiles.
- `refactorbench`: [RefactorBench](https://github.com/microsoft/RefactorBench), 100 multi-file refactorings of nine Python repositories; 18 in the quick subset. A pass is the authors' test, which parses the edited source for the expected shape, and no rewritten file has stopped compiling.
- `swebench`: [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified), real GitHub issues from Python projects, without the `psf/requests` ones; 10 in the quick subset. A pass is "resolved" from the official harness in Docker. Every instance pulls its own image of about 1 GB, so run the quick subset or named ids, not `all`.

The checks of `quixbugs`, `canitedit`, `polyglot`, `refactorbench` and `swebench` run through `uv`; `polyglot` also needs node and npm, and `swebench` needs git and a running Docker.

Also in `bench/`:
- `static.ts`: replays real commits through both edit formats and counts tokens. It uses o200k as a proxy tokenizer, not Claude's.
- `tokprobe/`: a small mod that measures token counts with Claude's real tokenizer (via `model.complete` usage).

Downloaded data (`bench/data/`) and agent transcripts (`bench/runs/`) are not committed.

### Results

RefactorBench quick subset: 18 multi-file refactoring tasks, one run per arm. Logs are in `bench/results/`.

| Session model | Built-in tools | The mod | Mod + router | Mod + router graded by Jev |
|---|---|---|---|---|
| Sonnet 5.5 | 13/18 for $1.36 | 14/18 for $0.77 | 13/18 for $0.61 | not run |
| Opus 5.5 | 15/18 for $2.48 | 15/18 for $1.82 | 14/18 for $1.14 | 13/18 for $1.03 |

- The mod alone is 43% (Sonnet) and 27% (Opus) cheaper than the built-in tools at the same or a better score.
- The router takes a further 21% to 37% off and lost one task in each run: a multi-file rename sent to Haiku that the session's own model solves.
- This is a single repetition, so a one-task difference between arms is noise; three tasks fail on every arm.
- The earlier click runs (`bench/results/live-*.log`) predate the router.
