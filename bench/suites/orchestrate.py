"""Orchestration tasks on click 8.1.7: the session hands three of the click suite's edits to subagents, or runs them
as a workflow with a verifier, so the router has agents of different difficulty to seat. Uses the click suite's data
(python3 fetch.py click)."""
import json, shutil
from . import Task
from .click import TASKS, compiles

PARTS = ["rename-class", "getenv", "bool-states"]
ASKS = [TASKS[p][0] for p in PARTS]
SCRIPT = ("export const meta = { name: 'three-edits', description: 'three independent edits to click, then a check' }\n"
          "const done = await parallel([\n" + "".join(f"  () => agent({json.dumps(a)}, {{ label: {json.dumps(p)} }}),\n" for p, a in zip(PARTS, ASKS)) + "])\n"
          "const verdict = await agent('Adversarially verify, by reading the files, that each of these was done completely and nothing else changed: ' + "
          + json.dumps(" | ".join(ASKS)) + " + ' Answer confirmed or refuted per item, with one line of evidence each.', { label: 'verify' })\n"
          "return { done, verdict }\n")

PROMPTS = {
    "agents": ("Make these three independent changes by starting one subagent per change, all three at the same time (Agent tool, "
               "no model or effort parameter), giving each its change verbatim. Then say in one line each what was done.\n"
               + "".join(f"{i}. {a}\n" for i, a in enumerate(ASKS, 1)), ("Agent",)),
    "workflow": ("ultracode: use the Workflow tool to run exactly this script (pass it inline as `script`, unchanged), wait for it to "
                 "finish, then report each agent's answer in one line.\n\n" + SCRIPT, ("Workflow",)),
}


def tasks(data):
    click = data.parent / "click" / "src"
    setup = lambda d: shutil.copytree(click, d, dirs_exist_ok=True)
    check = lambda d: all(TASKS[p][1](d) for p in PARTS) and compiles(d)
    solve = lambda d: [TASKS[p][2](d) for p in PARTS]
    return [Task(id, prompt, setup, check, solve, tools) for id, (prompt, tools) in PROMPTS.items()]
