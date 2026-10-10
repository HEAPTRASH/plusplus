"""Benchmark suites. Each module exposes tasks(data) -> [Task], and QUICK (task ids) when a short run should use a fixed subset."""
import dataclasses, pathlib, typing


@dataclasses.dataclass
class Task:
    id: str
    prompt: str
    setup: typing.Callable[[pathlib.Path], None]  # fills the empty directory the agent works in
    check: typing.Callable[[pathlib.Path], bool]  # pass/fail on that directory afterwards
    solve: typing.Callable[[pathlib.Path], None] | None = None  # applies the reference solution, for --selftest
    tools: tuple[str, ...] = ()  # built-in tools beyond search and edit, e.g. ("Bash",)
    level: str = ""  # the suite's own difficulty label, when it has one
