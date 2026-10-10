"""Hand-written edit tasks on click 8.1.7 (github.com/pallets/click): renames, replacements and two small changes."""
import shutil, subprocess, sys
from . import Task


def py(d, code):
    return subprocess.run([sys.executable, "-c", code], cwd=d, capture_output=True).returncode == 0


def compiles(d):
    return subprocess.run([sys.executable, "-m", "py_compile", *map(str, d.rglob("*.py"))], capture_output=True).returncode == 0


def sub(d, file, *pairs):
    p = d / file; s = p.read_text()
    for old, new in pairs: s = s.replace(old, new)
    p.write_text(s)


def rename_everywhere(d):
    sub(d, "click/globals.py", ("def get_current_context(", "def current_context("))
    with open(d / "click/globals.py", "a") as f: f.write("\n\nget_current_context = current_context\n")
    for name in ("core", "decorators"): sub(d, f"click/{name}.py", ("get_current_context", "current_context"))


# id: (prompt, check, reference solution)
TASKS = {
    "rename-class": ("In click/types.py rename the class FuncParamType to FunctionParamType, updating every reference in that file.",
                     lambda d: "FuncParamType" not in (d / "click/types.py").read_text() and (d / "click/types.py").read_text().count("FunctionParamType(") == 2,
                     lambda d: sub(d, "click/types.py", ("FuncParamType", "FunctionParamType"))),
    "getenv": ("In click/core.py replace every os.environ.get( call with os.getenv( (same arguments).",
               lambda d: "os.environ.get(" not in (d / "click/core.py").read_text() and "os.getenv(" in (d / "click/core.py").read_text(),
               lambda d: sub(d, "click/core.py", ("os.environ.get(", "os.getenv("))),
    "ctx-param": ("In click/core.py add a keyword parameter `strict: bool = False` as the last parameter of Context.__init__, "
                  "store it as self.strict, and document it in the Context class docstring like the other parameters.",
                  lambda d: py(d, "import click; c = click.Context(click.Command('x')); assert c.strict is False and click.Context(click.Command('x'), strict=True).strict is True; "
                                  "assert 'strict' in click.Context.__doc__"),
                  lambda d: sub(d, "click/core.py", ("        show_default: t.Optional[bool] = None,\n    ) -> None:",
                                                     "        show_default: t.Optional[bool] = None,\n        strict: bool = False,\n    ) -> None:\n        self.strict = strict"),
                                    ("    :param show_default: Show the default value", "    :param strict: Reserved.\n    :param show_default: Show the default value"))),
    "multi-rename": ("Rename the function get_current_context to current_context throughout the click package: its definition in "
                     "click/globals.py and every use in click/core.py and click/decorators.py. Keep get_current_context available as an "
                     "alias in click/globals.py.",
                     lambda d: py(d, "import click.globals as g, click.core, click.decorators, pathlib; assert callable(g.current_context) and callable(g.get_current_context); "
                                     "assert not [f for f in ('core', 'decorators') if 'get_current_context' in pathlib.Path(f'click/{f}.py').read_text()]"),
                     rename_everywhere),
    "bool-states": ("Make click's boolean parameter type also accept \"enabled\" and \"disabled\" (case-insensitive, like its other values).",
                    lambda d: py(d, "import click; c = click.BOOL.convert; assert c('Enabled', None, None) is True and c('disabled', None, None) is False and c('yes', None, None) is True"),
                    lambda d: sub(d, "click/types.py", ('"on"}', '"on", "enabled"}'), ('"off"}', '"off", "disabled"}'))),
}


def tasks(data):
    setup = lambda d: shutil.copytree(data / "src", d, dirs_exist_ok=True)
    return [Task(id, prompt, setup, lambda d, ok=ok: ok(d) and compiles(d), solve) for id, (prompt, ok, solve) in TASKS.items()]
