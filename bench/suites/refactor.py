"""Aider's refactoring benchmark (github.com/Aider-AI/refactor-benchmark, Apache-2.0): in one real Python file of 91 to
22,390 lines, taken from Django, PyTorch, Ansible and six other projects, move a named method out of its class into a
top-level function and update its `self.` call sites. 88 of the 89 tasks, each with aider's own prompt, word for word.
The benchmark ships no solutions and its tests import aider, so neither is used here. lax() mirrors verify_refactor in
aider's benchmark/refactor_tools.py (Apache-2.0), which compares syntax-tree node counts; check also fails what that
test lets through, a method that was copied rather than moved; solve is a scripted move. Nothing downloaded is run or
imported: both checks only parse the edited file."""
import ast, re, shutil
from . import Task

# its file already has a top-level bind_symbols and upstream tests the first one, so only deleting that wrapper passes
SKIP = {"symbolic_shapes_ShapeEnv_bind_symbols"}
# 16 tasks on distinct files, evenly spaced through the 71 by length. Listed every fourth by length, then the gaps, so
# --tasks 4 and --tasks 8 each span the range (91, 355, 560, 1453 lines, then 274, 447, 885, 3222); the 22,390-line outlier is last.
QUICK = ["diffsettings_Command_output_hash", "weather_NWSWeather__forecast", "schema_DatabaseSchemaEditor_quote_value", "doc_DocCLI_get_role_man_text",
         "config_AppConfig__path_from_module", "feedgenerator_Atom1Feed_add_item_elements",
         "onnxfunction_dispatcher_OnnxFunctionDispatcher__get_aten_name", "triton_TritonScheduling_generate_node_schedule",
         "cuda_cpp_scheduling_CUDACPPScheduling__can_fuse_epilogue_impl", "inspectdb_Command_normalize_col_name",
         "operations_DatabaseOperations_bulk_insert_sql", "galaxy_GalaxyCLI_execute_list_collection",
         "finders_FileSystemFinder_check", "grpc_debug_server_EventListenerBaseServicer__process_tensor_event_in_chunks",
         "kernel_SpyderKernel_get_fault_text", "common_methods_invocations_foreach_inputs_sample_func__sample_rightmost_arg"]
# the 12 longest distinct files, 1,687 lines and up, shortest first: run with --tasks id,id,...
LARGE = ["builtin_BuiltinVariable_call_setattr", "autodetector_MigrationAutodetector_check_dependency", "galaxy_GalaxyCLI_execute_list_collection",
         "text_CountVectorizer__limit_features", "dataframeeditor_DataFrameView_next_index_name", "options_ModelAdmin_message_user",
         "triton_TritonScheduling_generate_node_schedule", "figure_FigureBase_colorbar", "codeeditor_CodeEditor___get_brackets",
         "patches__Curve__get_arrow_wedge", "common_utils_TestCase_genSparseTensor",
         "common_methods_invocations_foreach_inputs_sample_func__sample_rightmost_arg"]
# what aider appends to each task's instructions (instructions_addendum in its benchmark/prompts.py)
ADDENDUM = ("\n####\n\nUse the above instructions to modify the supplied files: {}\n"
            "Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\n"
            "Only use standard libraries, don't suggest installing any packages.\n")
# the five values each task's test file hands to upstream's checker; the test file itself is never run, nor shown to the agent
SPEC = re.compile(r'/ "(?P<file>[\w.]+)"\s+method = "(?P<method>\w+)"\s+method_children = (?P<m>\d+)\s+class_name = "(?P<cls>\w+)"\s+class_children = (?P<c>\d+)')
SPECS = {}  # task id: (file, method, its node count, class, its node count), filled by tasks()


def self_ref(n, method):
    return isinstance(n, ast.Attribute) and n.attr == method and isinstance(n.value, ast.Name) and n.value.id == "self"


def judge(d, file, method, m, cls, c, strict=True):
    try:
        tree = ast.parse((d / file).read_bytes())
        top = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == method]
        kept = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == cls)
        near = lambda node, want: abs(sum(1 for _ in ast.walk(node)) - want) * 10 < want
        # upstream's whole test: the first top-level function of that name, and the class, are each within 10% of the node
        # count they should now have. A method copied out and never removed passes it in 34 of the 89 tasks.
        if not (top and near(top[0], m) and near(kept, c - m)): return False
        if not strict: return True
        if (len(top) > 1 or [a.arg for a in top[0].args.posonlyargs + top[0].args.args][:1] == ["self"]
                or any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == method for n in kept.body)
                or any(self_ref(n, method) for n in ast.walk(kept))): return False
        compile(tree, file, "exec", dont_inherit=True)  # raises on what parsing alone accepts, such as a return outside a function
        return True
    except Exception:  # no file, or one that does not parse or compile
        return False


def lax(d, task_id):
    """Upstream's pass signal alone, the one aider's published scores count, for a task that tasks() has loaded."""
    return task_id in SPECS and judge(d, *SPECS[task_id], strict=False)


def move(raw, cls, method):
    """The reference answer, on bytes because ast columns count UTF-8 bytes."""
    tree, lines = ast.parse(raw), raw.splitlines(keepends=True)
    first = lambda n: min(x.lineno for x in [n, *getattr(n, "decorator_list", [])])  # decorators travel with what they decorate
    top, kept, f = next((top, k, f) for top in tree.body for k in ast.walk(top) if isinstance(k, ast.ClassDef) and k.name == cls
                        for f in k.body if isinstance(f, ast.FunctionDef) and f.name == method)
    start, end, a = first(f), f.end_lineno, f.args.args[0]
    block = lines[start - 1:end]; i = a.lineno - start
    line = block[i][:a.col_offset] + re.sub(rb"^\s*,[ \t]*", b"", block[i][a.end_col_offset:])  # the self parameter goes
    block[i] = line if line.strip() else b""  # it had a line to itself
    pad = lines[f.lineno - 1][:f.col_offset]
    new = b"".join(l.removeprefix(pad) for l in block) + b"\n\n"
    # (line, column, end line, end column, replacement), applied bottom-up so that earlier positions stay valid
    edits = [(n.lineno, n.col_offset, n.end_lineno, n.end_col_offset, method.encode()) for n in ast.walk(kept)
             if self_ref(n, method) and not start <= n.lineno <= end]
    # a top-level function already using the name is replaced: only the task in SKIP has one
    edits += [(first(n), 0, n.end_lineno + 1, 0, b"") for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == method]
    while end < len(lines) and not lines[end].strip() and not lines[start - 2].strip(): end += 1  # blank lines after the method go with it
    edits += [(start, 0, end + 1, 0, b""), (first(top), 0, first(top), 0, new)]
    for l1, c1, l2, c2, text in sorted(edits, reverse=True):
        lines[l1 - 1:l2] = [lines[l1 - 1][:c1] + text + (lines[l2 - 1][c2:] if l2 <= len(lines) else b"")]
    return b"".join(lines)


def tasks(data):
    out = []
    for test in sorted((data / "refactor-benchmark").glob("*/*_test.py")):
        home, g = test.parent, SPEC.search(test.read_text())
        if home.name in SKIP: continue
        s = SPECS[home.name] = (g["file"], g["method"], int(g["m"]), g["cls"], int(g["c"]))
        out.append(Task(home.name, (home / ".docs/instructions.md").read_text() + ADDENDUM.format(s[0]),
                        lambda d, src=home / s[0]: shutil.copy(src, d),  # the one file: the test would give the node counts away
                        lambda d, s=s: judge(d, *s),
                        lambda d, s=s: (d / s[0]).write_bytes(move((d / s[0]).read_bytes(), s[3], s[1]))))
    return out
