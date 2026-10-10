import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PlusPlusSetup } from '../types'
import { type Edit, type FileState, type Kind, type Ops, advice, ambiguous, apply, changed, created, flagged, fresh, inGit, inside, local, near, ops, render, search, shellEdit, split, sync, tidy, SEP } from './core'
import { setupPane, tableOf } from './panes'
import { type RouterOptions, routing } from './routing'
import { type SpecOptions, SECTION, TOOL, isOpen, note, specs, storeDir } from './specs'
import { type Tone, glyphs, say } from './ui'

// ponytail: module memory, so a reload forgets anchors and the model re-reads; $.state if that bites
const files = new Map<string, FileState>()

const READ = 'mcp__plusplus__read', EDIT = 'mcp__plusplus__edit'
const SETUP = 'codegraph-setup'
const MAX_HITS = 50 // SWE-agent's cap: past it, ask for a narrower search rather than flood the context
const SKIP_DIRS = /^(\.|node_modules$|__pycache__$|venv$|dist$|build$)/

// ---- code graph: CodeGraph, downloaded with consent, kept in sync with every change ----

// ponytail: one pinned release; bump VERSION and SHA256 together, from that release's SHA256SUMS
const VERSION = 'v1.6.2'
const SHA256: Record<string, string> = {
  'darwin-arm64': 'd74d1bfb4060db63ec3c2b72c4e17f76c31978af3bad6ace4370d1501ac0662e',
  'darwin-x64': '53d1a4d1a9af31d6cec11b346df2ae792087081e13f623f583e27783c1e7f9bc',
  'linux-arm64': 'c8c6be292be21d00dea26bad8b28d434731cf612fb8cc475dc10f5b3038b5b64',
  'linux-x64': 'ef0af416092128fb1ccc723786000b7edf4a6971fe604acd08bf966e4f37b828',
}
const RELEASES = 'https://github.com/colbymchenry/codegraph/releases/download'
// every call the mod makes runs with telemetry off; codegraph's own MCP server keeps its own setting
const ENV = { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' }

type Options = { codegraph?: string; codegraphMirror?: string; shellEdits?: string; icons?: string } & RouterOptions & SpecOptions

/** The person's answer to the setup dialog, kept across sessions: 'yes' or 'no'; unset until they answer. */
const CONSENT = 'codegraph.consent'
const ABOUT = { version: VERSION, size: '~60 MB', dir: '~/.local/share/plusplus/codegraph', source: 'github.com/colbymchenry/codegraph (MIT)' }

const DIALOG = { id: SETUP, title: 'plusplus: code graph setup', focus: true, closeOnEscape: true, holdToasts: true, rows: 9 } as const
/** How far the download is, kept by the host: what the setup pane draws from. */
const setup = atom({ plugin: 'plusplus', key: 'setup' } as const, { frame: 0, phase: 'ask', got: 0, of: 0, error: '' })
type Timer = { cancel: () => void }
/** The setup pane is up; the archive being downloaded; the timer that reads its size while the pane is up; the one that closes the pane after a success. */
let shown = false, fetching: string | undefined, poller: Timer | undefined, closing: Timer | undefined

let installing: Promise<string | undefined> | undefined

let locale: Promise<(string | undefined)[]> | undefined
/** The glyphs for a surface: the icons setting, else what the terminal's locale can draw. */
const icons = ($: EngineInterface, opts: Options, surface = 'terminal') =>
  (locale ??= Promise.all([$.env.get('LC_ALL'), $.env.get('LC_CTYPE'), $.env.get('LANG'), $.env.get('TERM')]).catch(() => [])).then(v => glyphs(opts.icons, surface, v))

/** A toast in the mod's look: a glyph for how it went, then the words. Said nowhere when there is no surface to say it on. */
const toast = ($: EngineInterface, opts: Options, tone: Tone | 'down' | 'to', text: string) => void icons($, opts).then(g => $.ui.toast(say(g, tone, text))).catch(() => undefined)

/** Notes how far the install is, for the pane. */
const tell = ($: EngineInterface, change: Partial<PlusPlusSetup>) => update($, setup, s => ({ ...s, ...change })).then(() => undefined, () => undefined)

/** The setup pane is going: its timers end. A download under way goes on, and says how it ended in a toast. */
const hush = () => (poller?.cancel(), closing?.cancel(), (poller = closing = undefined), (shown = false))

/** While the pane is up, reads the archive's size five times a second, which is also its spinner's clock; ends with the install or the pane. */
function follow($: EngineInterface) {
  const file = fetching
  if (!shown || !file || poller) return
  // before the archive is there (the server is still being asked its size) only the spinner moves
  poller = $.clock.every(200, () => void $.fs.stat(file).then(f => f.size, () => undefined).then(size => update($, setup, s => ({ ...s, frame: s.frame + 1, got: s.phase === 'download' && size !== undefined ? size : s.got }))).catch(() => undefined))
}

/** The pinned codegraph launcher, downloaded and checksum-verified once the person agreed; undefined when off, not agreed, unsupported or failed. */
function ensure($: EngineInterface, opts: Options): Promise<string | undefined> {
  return (installing ??= install($, opts)
    .catch(async err => {
      const why = String(err).replace(/^Error: /, '')
      await tell($, { phase: 'failed', error: `CodeGraph was not installed: ${why}` })
      if (!shown) toast($, opts, 'fail', `CodeGraph install failed: ${why}`)
      return undefined
    })
    .then(bin => {
      if (!bin) installing = undefined // not now is not forever: a later consent or retry runs again
      return bin
    }))
}

async function installed($: EngineInterface): Promise<boolean> {
  return $.fs.exists(`${(await $.env.get('HOME')) ?? ''}/.local/share/plusplus/codegraph/${VERSION}/bin/codegraph`)
}

async function install($: EngineInterface, opts: Options): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/.local/share/plusplus/codegraph/${VERSION}`, bin = `${dir}/bin/codegraph`
  if (home && (await $.fs.exists(bin))) return bin
  // nothing is downloaded without the person's yes in the setup dialog, and never when an admin turned it off
  if (!home || opts.codegraph === 'off' || (await $.store.get(CONSENT)) !== 'yes') return undefined
  // ponytail: macOS and Linux only; Windows ships zips with another layout, add when someone runs it there
  const [os = '', arch = ''] = (await $.process.run(['uname', '-sm'])).stdout.trim().split(/\s+/)
  const target = `${{ Darwin: 'darwin', Linux: 'linux' }[os] ?? os}-${{ arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64' }[arch] ?? arch}`
  const want = SHA256[target]
  if (!want) return undefined

  const run = async (argv: string[], timeoutMs = 60_000) => {
    const r = await $.process.run(argv, { timeoutMs })
    if (r.exitCode !== 0) throw new Error(`${argv[0]} failed: ${r.stderr.trim().slice(0, 200)}`)
    return r.stdout
  }
  const tmp = `${dir}.tmp-${crypto.randomUUID()}`
  // the pane shows the download while it is up; without it a toast says it began, and another how it ended
  if (!shown) toast($, opts, 'down', `downloading CodeGraph ${VERSION} (${ABOUT.size}) for the code graph`)
  try {
    await run(['mkdir', '-p', `${tmp}/x`])
    const url = `${(opts.codegraphMirror || RELEASES).replace(/\/$/, '')}/${VERSION}/codegraph-${target}.tar.gz`
    // the size the server announces, for the bar: the last one, past the redirects. Without one the pane counts megabytes
    fetching = `${tmp}/cg.tar.gz`
    follow($)
    const head = await $.process.run(['curl', '-fsSLI', url], { timeoutMs: 15_000 }).catch(() => undefined)
    const of = Number((head?.exitCode === 0 && [...head.stdout.matchAll(/^content-length:\s*(\d+)/gim)].at(-1)?.[1]) || 0)
    await tell($, { phase: 'download', got: 0, of, error: '' })
    await run(['curl', '-fsSL', '--retry', '2', url, '-o', `${tmp}/cg.tar.gz`], 600_000)
    await tell($, { phase: 'verify', ...(of ? { got: of } : {}) })
    // verify against the hash pinned here, not one fetched beside the archive
    const sum = (await $.process.run(['shasum', '-a', '256', `${tmp}/cg.tar.gz`])).stdout || (await run(['sha256sum', `${tmp}/cg.tar.gz`]))
    if (sum.split(/\s+/)[0] !== want) throw new Error(`checksum mismatch for ${url}; not installed`)
    await tell($, { phase: 'unpack' })
    await run(['tar', '-xzf', `${tmp}/cg.tar.gz`, '-C', `${tmp}/x`, '--strip-components=1'], 120_000)
    // rename into place: a session installing at the same moment either wins or finds it there
    if (!(await $.fs.exists(bin))) await $.process.run(['mv', `${tmp}/x`, dir])
  } finally {
    poller?.cancel(), (poller = fetching = undefined)
    await $.process.run(['rm', '-rf', tmp])
  }
  if (!(await $.fs.exists(bin))) throw new Error('archive had no bin/codegraph')
  await tell($, { phase: 'done' })
  // the pane says it is done and goes by itself after three seconds
  if (shown) closing = $.clock.after(3000, () => (hush(), void $.ui.close({ id: SETUP }).catch(() => undefined)))
  else toast($, opts, 'ok', `CodeGraph ${VERSION} installed`)
  return bin
}

const roots = new Map<string, string | null>()

/** The indexed project holding `path` (nearest folder with .codegraph/), or null. Indexing stays the person's call: never created here. */
async function rootOf($: EngineInterface, path: string): Promise<string | null> {
  const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? path
  let d = real.replace(/\/[^/]*$/, '')
  const seen: string[] = []
  for (; d && !roots.has(d); d = d.replace(/\/[^/]*$/, '')) {
    seen.push(d)
    if (await $.fs.exists(`${d}/.codegraph`)) { roots.set(d, d); break }
  }
  const root = d ? roots.get(d) ?? null : null
  for (const s of seen) roots.set(s, root)
  return root
}

const syncing = new Map<string, Promise<unknown>>()

/** Re-syncs the graph of the project holding `path` after a change; one sync per project at a time, the next queued behind it. */
async function changedFile($: EngineInterface, opts: Options, path: string): Promise<void> {
  // runs after other tools' calls: a failure here must never surface in theirs
  const root = await rootOf($, path).catch(() => null)
  if (!root) return
  const bin = await ensure($, opts)
  if (!bin) return
  const prev = syncing.get(root) ?? Promise.resolve()
  const next = prev.then(() => $.process.run([bin, 'sync', '-q', root], { env: ENV, timeoutMs: 120_000 })).catch(() => undefined)
  syncing.set(root, next)
  await next
}

// ---- anchored read/edit ----

async function load($: EngineInterface, path: string) {
  const key = (await $.fs.stat(path, { resolve: true })).realPath ?? path
  return { key, ...split(await $.fs.read(path)) }
}

/** The file's anchors as the model will see them now; re-anchored above everything minted once a number could be read as a line number. */
function anchored(key: string, lines: string[]): FileState {
  let st = sync(files.get(key), lines)
  if (ambiguous(st)) st = fresh(lines, Math.max(st.minted, lines.length + 1))
  files.set(key, st)
  return st
}

/** Text files under `dir` (relative paths), skipping hidden and dependency folders; `glob` matches the path, or the name when it has no "/". */
async function walk($: EngineInterface, dir: string, glob?: string): Promise<string[]> {
  const re = glob && new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$')
  const out: string[] = []
  const go = async (rel: string) => {
    for (const ent of await $.fs.list(rel ? `${dir}/${rel}` : dir)) {
      const p = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.kind === 'dir' && !SKIP_DIRS.test(ent.name)) await go(p)
      else if (ent.kind === 'file' && ent.size < 1_000_000 && (!re || re.test(glob!.includes('/') ? p : ent.name))) out.push(p)
    }
  }
  await go('')
  return out.sort()
}

const PY_CHECK = 'import ast,sys\ntry: ast.parse(sys.stdin.read())\nexcept SyntaxError as e: print(e.lineno or 0, e.msg); sys.exit(1)'

/** Parses the text: undefined when there is no checker for this kind of file, else the error (line, message) or null. */
async function parse($: EngineInterface, path: string, text: string): Promise<{ line: number; msg: string } | null | undefined> {
  try {
    if (/\.py$/.test(path)) {
      const r = await $.process.run(['python3', '-c', PY_CHECK], { stdin: text, timeoutMs: 10_000 })
      return r.exitCode === 0 ? null : { line: parseInt(r.stdout), msg: r.stdout.replace(/^\d+ /, '').trim() }
    }
    if (/\.(m|c)?js$/.test(path)) {
      const r = await $.process.run(['node', '--check', path], { timeoutMs: 10_000 }) // the file on disk, written already
      return r.exitCode === 0 ? null : { line: parseInt(/:(\d+)\n/.exec(r.stderr)?.[1] ?? '0'), msg: r.stderr.split('\n').find(l => /Error/.test(l)) ?? 'syntax error' }
    }
    if (/\.json$/.test(path)) {
      try { JSON.parse(text); return null } catch (err) { return { line: 0, msg: String(err) } }
    }
  } catch {
    // no interpreter on this machine: say nothing rather than guess
  }
  return undefined
}

/** "syntax ok", or the error the edit introduced pinned to its ID; nothing for an error that was there before, or no checker. */
async function syntax($: EngineInterface, path: string, before: string[], st: FileState): Promise<string | undefined> {
  const after = await parse($, path, st.lines.join('\n'))
  if (after === undefined) return undefined
  if (after === null) return 'syntax ok'
  if (!/\.(m|c)?js$/.test(path) && (await parse($, path, before.join('\n')))) return undefined
  const { line, msg } = after
  return `syntax error: ${msg}` + (line > 0 && line <= st.lines.length ? ` at ${render(st, line - 1, line)}` : '')
}

type Planned = { path: string; key: string; lines: string[]; eol: string; trailing: boolean; edits: Edit[]; cur: FileState; next: FileState; warnings: string[] }

/** Works out one file's edits without writing anything: the plan, or an error that changes nothing. */
async function planFile($: EngineInterface, path: string, edits: Edit[]): Promise<Planned | { error: string }> {
  const { key, lines, eol, trailing } = await load($, path)
  // find/replace needs no anchors, so it works on a file never read; anchored edits do need a read
  const prev = files.get(key) ?? (edits.every(x => x.find !== undefined && (x.from === undefined || /^\d+$/.test(x.from))) ? sync(undefined, lines) : undefined)
  if (!prev) return { error: `${path}: read it (or search it with pattern or symbol) first` }
  const cur = sync(prev, lines) // picks up changes made outside this tool
  files.set(key, cur)
  const out = apply(cur, edits)
  if (typeof out === 'string') {
    // hand back where the stale anchors' lines are now, so no re-read is needed
    const stale = [...new Set(edits.flatMap(x => [x.from, x.to, x.after, x.before]))]
      .filter((a): a is string => a !== undefined && !cur.anchors.includes(a.split(SEP)[0]!.trim()))
    const around = stale.map(a => near(prev, cur, a)).filter(Boolean)
    return { error: `${path}: ${out}.${around.length ? `\nThose lines now:\n${around.join('\n…\n')}` : ''}` }
  }
  return { path, key, lines, eol, trailing, edits, cur, next: sync(cur, out.lines), warnings: out.warnings }
}

/** A planned file's text as it was read, and as it will be written. */
const textOf = (p: Planned, lines: string[]) => lines.join(p.eol) + (p.trailing && lines.length ? p.eol : '')

/** Reports a planned file once it is written: its new lines, warnings and syntax check. */
async function report($: EngineInterface, p: Planned): Promise<string> {
  files.set(p.key, p.next)
  const check = await syntax($, p.path, p.lines, p.next)
  // find/replace lands where its text was, so only written lines need neighbours to show their placement
  const ctx = p.edits.every(x => x.find !== undefined) ? 0 : 1
  return [changed(p.cur, p.next, ctx) || 'ok', ...p.warnings.map(w => `warning: ${w}`), ...(check ? [check] : [])].join('\n')
}

/** Where a path lands: the key its anchors are kept under. */
const keyOf = async ($: EngineInterface, path: string) => (await $.fs.stat(path, { resolve: true })).realPath ?? path

/** `p` as it is named once the moves are done: a moved file's new path, or its place under a moved folder. */
const moved = (move: ReadonlyMap<string, string>, p: string) => {
  for (const [from, to] of move) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
  return p
}

const parent = (p: string) => p.replace(/\/?[^/]*$/, '')

/** The folders above `path` that are not there yet, deepest first: what making it will make, and undoing it must take away. */
async function absent($: EngineInterface, path: string): Promise<string[]> {
  const out: string[] = []
  for (let d = parent(path); d && !(await $.fs.exists(d)); d = parent(d)) out.push(d)
  return out
}

/**
 * Carries out one call all or nothing. Every line edit is planned first; then new files and planned files are written,
 * then deleted files are moved aside and renames done (mv on the host, no shell), and only when all of that has
 * succeeded are the set-aside files removed. A failure anywhere undoes what was done, newest first: files moved back,
 * old text written back, new files and folders taken away.
 */
async function editFiles($: EngineInterface, o: Ops): Promise<{ text: string } | { error: string }> {
  const many = o.groups.size + o.create.size + o.remove.length + o.move.size > 1
  const nothing = `\nNothing was changed${many ? ' in any file' : ''}.`
  const found = await Promise.all([...o.groups].map(([path, edits]) => planFile($, path, edits)))
  const errors = found.filter((p): p is { error: string } => 'error' in p)
  if (errors.length) return { error: errors.map(x => x.error).join('\n') + nothing }
  const plans = found as Planned[], hosted = o.remove.length + o.move.size > 0
  const was = new Map<string, string>()
  for (const p of [...o.remove, ...o.move.keys()]) was.set(p, await keyOf($, p))
  const aside = o.remove.map(p => [p, `${p}.deleted-${crypto.randomUUID().slice(0, 8)}`] as const)
  // a new file at or under a path a rename takes or leaves is made after the renames, where its path will be its own
  const late = (p: string) => [...o.move].some(pair => pair.some(m => p === m || p.startsWith(`${m}/`)))
  const undo: { what: string; back: () => Promise<unknown> }[] = []
  const host = async (argv: string[]) => {
    const r = await $.process.run(argv)
    if (r.exitCode !== 0) throw r.stderr.trim() || `${argv[0]} exited ${r.exitCode}`
  }
  const unmake = (path: string, dirs: string[]) => async () => {
    await host(['rm', '-f', '--', path])
    if (dirs.length) await $.process.run(['rmdir', '--', ...dirs]).catch(() => undefined)
  }
  const create = async (path: string, text: string) => {
    const dirs = await absent($, path), { lines } = split(text.replace(/\r?\n$/, ''))
    await $.fs.write(path, lines.length ? lines.join('\n') + '\n' : '')
    undo.push({ what: `remove ${path}`, back: unmake(path, dirs) })
  }
  let at = '', doing = 'create'
  try {
    // ponytail: one command that does nothing, so a host that runs none says so before a file is written
    if (hosted) (at = o.remove[0] ?? o.move.keys().next().value!), (doing = o.remove.length ? 'delete' : 'rename'), await host(['true'])
    doing = 'create'
    for (const [path, text] of o.create) if (!late(path)) (at = path), await create(path, text)
    doing = 'write'
    for (const p of plans) {
      at = p.path
      await $.fs.write(p.path, textOf(p, p.next.lines))
      undo.push({ what: `restore ${p.path}`, back: () => $.fs.write(p.path, textOf(p, p.lines)) })
    }
    for (const [from, to] of [...aside, ...o.move]) {
      ;(at = from), (doing = o.remove.includes(from) ? 'delete' : 'rename')
      const dirs = await absent($, to)
      if (dirs.length) undo.push({ what: `remove ${dirs.at(-1)}`, back: () => host(['rmdir', '--', ...dirs]) }), await host(['mkdir', '-p', '--', dirs[0]!])
      await host(['mv', '--', from, to])
      undo.push({ what: `move ${to} back to ${from}`, back: () => host(['mv', '--', to, from]) })
    }
    doing = 'create'
    for (const [path, text] of o.create) if (late(path)) (at = path), await create(path, text)
  } catch (err) {
    const stuck: string[] = []
    for (const { what, back } of undo.reverse()) await back().catch(() => stuck.push(what))
    const why = `${at}: cannot ${doing}: ${String(err).replace(/^(HooksError|Error): /, '')}${doing === 'delete' || doing === 'rename' ? ' (deleting and renaming run mv and rm on the host)' : ''}`
    return { error: why + (stuck.length ? `\nThe rest was put back as it was, but this could not be done: ${stuck.join('; ')}.` : nothing) }
  }
  // every write has succeeded: only now do the deleted files go for good
  const junk = aside.map(([, tmp]) => moved(o.move, tmp)), out: string[] = []
  const rm = junk.length ? await $.process.run(['rm', '-f', '--', ...junk]).catch(() => undefined) : { exitCode: 0 }
  for (const p of o.remove) files.delete(was.get(p)!), out.push(`deleted ${p}`)
  for (const [from, to] of o.move) {
    // the anchors go with the file, or with every file of a moved folder
    const old = was.get(from)!, key = await keyOf($, to)
    for (const [k, st] of [...files]) if (k === old || k.startsWith(`${old}/`)) files.delete(k), files.set(key + k.slice(old.length), st)
    for (const p of plans) if (p.key === old || p.key.startsWith(`${old}/`)) (p.key = key + p.key.slice(old.length)), (p.path = moved(o.move, p.path))
    out.push(`renamed ${from} to ${to}`)
  }
  if (rm?.exitCode !== 0) out.push(`warning: could not remove ${junk.join(', ')}`)
  for (const [path, text] of o.create) {
    const st = fresh(split(text.replace(/\r?\n$/, '')).lines)
    files.set(await keyOf($, path), st)
    const check = await syntax($, path, [], st)
    out.push(`created ${path}${st.lines.length ? `\n${created(st)}` : ''}${check ? `\n${check}` : ''}`)
  }
  for (const p of plans) out.push((many ? `${p.path}\n` : '') + (await report($, p)))
  return { text: out.join(many ? '\n\n' : '\n') }
}

/** What each path is now: a file, a directory, or nothing. */
async function kinds($: EngineInterface, paths: readonly string[]): Promise<Map<string, Kind>> {
  const out = new Map<string, Kind>()
  for (const p of new Set(paths)) out.set(p, await $.fs.stat(p).then(s => (s.kind === 'dir' ? 'dir' : 'file'), () => undefined))
  return out
}

/** Whether `to` is `from` under another case on a disk that tells no case apart: it stats, yet its folder lists no such name. */
async function sameFile($: EngineInterface, from: string, to: string): Promise<boolean> {
  if (to === from || to.toLowerCase() !== from.toLowerCase() || parent(to) !== parent(from)) return false
  const names = await $.fs.list(parent(to) || '.').then(l => l.map(x => x.name), () => undefined)
  return names !== undefined && !names.includes(to.slice(parent(to).length).replace(/^\//, ''))
}

/**
 * Where `path` lands with every link on the way followed: its real path, or for one not there yet its nearest folder's
 * real path and the rest. `why` instead when that cannot be said, so a guard refuses: a ".." past what exists, a file
 * where a folder is needed, a link that leads nowhere (writing through it would land wherever it points).
 */
async function landing($: EngineInterface, path: string): Promise<{ real: string } | { why: string }> {
  const look = (p: string) => $.fs.stat(p, { resolve: true }).catch(() => undefined)
  const own = await look(path)
  if (own) return own.realPath === undefined ? { why: 'cannot be resolved' } : { real: own.realPath }
  const rest: string[] = []
  for (let dir = path; dir !== '/' && dir !== '.'; ) {
    const cut = dir.lastIndexOf('/'), name = dir.slice(cut + 1)
    if (name === '..') return { why: 'goes up ("..") from a folder that is not there' }
    if (name && name !== '.') rest.unshift(name)
    dir = cut < 0 ? '.' : dir.slice(0, cut) || '/'
    const st = await look(dir)
    if (!st) continue
    if (st.kind !== 'dir' || st.realPath === undefined) return { why: `${dir} is a file, not a folder` }
    if ((await $.fs.list(dir).catch(() => [])).some(x => x.name === rest[0])) return { why: `${dir}/${rest[0]} is a link that leads nowhere` }
    return { real: `${st.realPath.replace(/\/$/, '')}/${rest.join('/')}` }
  }
  return { why: 'cannot be resolved' }
}

/**
 * Why a call's creates, deletes and renames may not run, if they may not: each must land inside the session's project
 * root by its real path (a link that leads outside is outside), and nothing in a .git folder is deleted or renamed.
 * Line edits are not asked: they keep the rule they had.
 */
async function confined($: EngineInterface, o: Ops): Promise<string | undefined> {
  const whole = [...[...o.create.keys()].map(p => [p, true] as const), ...[...o.remove, ...o.move.keys(), ...o.move.values()].map(p => [p, false] as const)]
  if (!whole.length) return undefined
  const top = await $.session.root()
  const root = (await $.fs.stat(top, { resolve: true }).catch(() => undefined))?.realPath ?? top
  for (const [p, making] of whole) {
    const at = await landing($, p)
    if ('why' in at) return `${p}: ${at.why}`
    if (!inside(at.real, root)) return `${p}: is outside the project (${root}); edit creates, deletes and renames only inside it`
    if (!making && (inGit(p) || inGit(at.real))) return `${p}: is in a .git folder; edit deletes and renames nothing there`
  }
  return undefined
}

const MAX_WARN = 3
/** How often each loop was told this turn to use edit, so a loop of sed calls is not nagged past three. */
const warned = new Map<string, { turn: number; n: number }>()

/** The line steering a Bash command that would edit a file by script toward edit; undefined for every other command. */
async function steer($: EngineInterface, command: string, refused: boolean): Promise<string | undefined> {
  const v = shellEdit(command)
  if (!v) return undefined
  const cwd = await $.session.cwd(), dirs = [cwd, await $.session.root()], there = new Set<string>()
  if (!v.certain) for (const p of local(v, cwd, dirs)) if (await $.fs.exists(p)) there.add(p)
  return flagged(v, cwd, dirs, p => there.has(p)) ? advice(v, EDIT, refused) : undefined
}

const MAX_REFS = 300 // reference lines are one short line each; past this, narrow with glob

/**
 * One call for a symbol: its definition (from the code graph when the project is indexed, else the first
 * declaration line found) and every line that mentions it, each carrying edit IDs, grouped by file.
 */
async function symbolRead($: EngineInterface, opts: Options, dir: string, sym: string, glob: string | undefined, context: number): Promise<string> {
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = new RegExp(`\\b${esc}\\b`)
  const decl = new RegExp(`\\b(function|def|class|interface|type|enum|const|let|var|fn|func|struct)\\s+${esc}\\b`)
  const base = (await $.fs.stat(dir, { resolve: true })).realPath ?? dir
  let def: { file: string; start: number; end: number } | undefined
  const root = await rootOf($, `${base}/.codegraph`) // a path inside the folder, so the folder itself is checked first
  const bin = root ? await ensure($, opts) : undefined // never downloads without consent
  if (root && bin) {
    const r = await $.process.run([bin, 'query', sym, '-p', root, '-j', '-l', '5'], { env: ENV, timeoutMs: 20_000 }).catch(() => undefined)
    try {
      const hit = (JSON.parse(r?.stdout ?? '[]') as { node: { name: string; kind: string; filePath: string; startLine: number; endLine: number } }[])
        .map(x => x.node).find(n => n.name === sym && n.kind !== 'import')
      if (hit) def = { file: `${root}/${hit.filePath}`, start: hit.startLine - 1, end: hit.endLine }
    } catch {
      // no usable graph answer: the declaration scan below stands in
    }
  }
  const refs: string[] = []
  let defText = '', count = 0, inFiles = 0, listed = 0
  for (const rel of await walk($, dir, glob)) {
    const abs = `${base}/${rel}`, text = await $.fs.read(abs)
    if (!word.test(text)) continue
    const { key, lines } = await load($, abs)
    const st = anchored(key, lines)
    if (!def) {
      const i = lines.findIndex(l => decl.test(l))
      if (i >= 0) def = { file: abs, start: i, end: i + 1 }
    }
    if (def?.file === abs) defText = `definition: ${rel}\n${render(st, def.start, Math.min(def.end, def.start + 120))}`
    // the definition is shown above: leave its own lines out of the references
    const found = def?.file === abs ? search(st, word, context, i => i < def!.start || i >= def!.end) : search(st, word, context)
    if (!found.hits) continue
    count += found.hits; inFiles++
    if (listed < MAX_REFS) refs.push(`${rel}\n${found.text}`), (listed += found.hits)
  }
  if (!defText && !count) return `no line mentions ${sym} under ${dir}`
  const more = listed < count ? ' (stopped listing; narrow with glob for the rest)' : ''
  return [defText || `definition: not found under ${dir}`, `references: ${count} lines in ${inFiles} files${more}`, ...refs].join('\n\n')
}

/** The pipeline the tools are built for, so the model spends as few turns and as little context as it can. */
const RULES = `# Editing pipeline (plusplus)
Spend as few turns as possible:
1. Locate once. For a function, class or variable, call read with symbol: its definition and every reference, already carrying edit IDs. For other text, read a directory with pattern. Don't follow up with Grep or Read on lines you already have.
2. Change everything in one edit call: all edits across all files, each with its own path.
3. Don't re-read to verify: edit results show the new lines, their neighbours and a syntax check; a failed edit changes nothing and says why.
4. Every file change goes through edit, new files, deletions and renames included; never a shell script (sed, python, a heredoc).`

/** Opens the setup pane as a dialog on where things stand: the question, a download under way, or the install that is there already. */
async function dialog($: EngineInterface) {
  if (!installing) await tell($, { phase: (await installed($).catch(() => false)) ? 'done' : 'ask', error: '' })
  const opened = await $.ui.open(DIALOG)
  shown = opened.isPlaced
  follow($)
  return opened
}

/** First run: ask once before downloading anything; the answer is kept across sessions. */
async function offerSetup($: EngineInterface, opts: Options) {
  await $.command.register({ name: SETUP, description: 'Set up the code graph (download CodeGraph)' })
  if (opts.codegraph !== 'off' && !(await installed($))) {
    const consent = await $.store.get(CONSENT)
    if (consent === undefined) {
      if (!(await dialog($)).isPlaced) toast($, opts, 'to', `run /${SETUP} to set up the code graph`)
    } else if (consent === 'yes') void ensure($, opts) // agreed before, binary missing (new machine, new version)
  }
}

export const register: Register = (on, options) => {
  const opts = options as Options

  routing(on, opts)
  specs(on, opts) // before the read and edit hooks below, so that its hook sees what they answer

  on('command.run', { command: SETUP }, async $ => {
    if (opts.codegraph === 'off') return { text: 'The code graph download is turned off by the codegraph setting.' }
    await dialog($)
    return { text: 'Code graph setup opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    shown = true
    const ui = $.ui.resolve(e), s = await read($, setup), g = await icons($, opts, e.surface)
    const shut = () => (hush(), $.ui.close({ id: SETUP }))
    // a download this module is not running was cut off by a reload: the question stands again
    const state: PlusPlusSetup = !installing && (s.phase === 'download' || s.phase === 'verify' || s.phase === 'unpack') ? { ...s, phase: 'ask' } : s
    return setupPane(tableOf(ui, e.surface), { g, w: Math.max(e.props.bodyColumns, 40), about: ABOUT, state }, {
      yes: async () => {
        await $.store.set(CONSENT, 'yes')
        closing?.cancel()
        await tell($, { phase: 'download', got: 0, of: 0, error: '' })
        // no launcher and no failure: there is no build for this system
        void ensure($, opts).then(async bin => {
          const { phase } = await read($, setup)
          if (bin === undefined && phase !== 'failed') await tell($, { phase: 'failed', error: 'CodeGraph has no download for this system' })
          if (bin !== undefined && phase !== 'done') await tell($, { phase: 'done' }) // it was there already
        })
        // answered: from here the pane only shows the download, and holds neither the toasts nor Escape
        shown = (await $.ui.open({ id: SETUP, title: DIALOG.title, rows: 4 })).isPlaced
      },
      later: shut,
      never: async () => {
        await $.store.set(CONSENT, 'no')
        await shut()
      },
      hide: shut,
    })
  })

  // the pane's timers end with the pane when the person closes it; the mod's own close (above) is not raised to its own hooks
  on('ui.close', { id: SETUP }, (_$, e, next) => {
    hush()
    return next(e)
  })

  // the graph follows every change: our edits, the built-in editors, and shell commands that write
  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const ran = await next(e)
    const file = e as unknown as { file_path?: string; notebook_path?: string }
    if (ran.deny === undefined && !ran.isError) void changedFile($, opts, file.file_path ?? file.notebook_path ?? '')
    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // judged before it runs: enforce refuses a scripted edit, warn lets it run and says so beside its result
    const mode = opts.shellEdits ?? 'warn', command = String((e as { command?: unknown }).command ?? '')
    const line = mode === 'off' ? undefined : await steer($, command, mode === 'enforce').catch(() => undefined)
    if (line && mode === 'enforce') return { deny: line }
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isReadOnly) void changedFile($, opts, `${await $.session.cwd()}/.codegraph`) // a path inside cwd, so cwd itself is checked first
    if (!line || ran.deny !== undefined) return ran
    const turn = await $.session.turns().catch(() => 0), loop = e.agentId ?? 'main', seen = warned.get(loop)
    const n = seen?.turn === turn ? seen.n + 1 : 1
    warned.set(loop, { turn, n })
    return n > MAX_WARN ? ran : { ...ran, context: [...(ran.context ?? []), line] }
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'read',
      isDeferred: false,
      description:
        `Read a file as "ID${SEP}code" lines. The ID names the line for edit and stays fixed across edits; it is not a line number. ` +
        `pattern: only matching lines plus context, enough to edit without a full read. With a directory path and pattern, searches every file in it ` +
        `(glob narrows, e.g. "*.py"). symbol: a name's definition plus every line that mentions it, across the directory. ` +
        `Use instead of Read/Grep: results carry IDs, so you can edit straight from them.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file, or directory to search with pattern' },
          pattern: { type: 'string', description: 'JS regex; only matching lines are returned' },
          symbol: { type: 'string', description: 'with a directory: a function, class or variable name; returns its definition and every reference' },
          glob: { type: 'string', description: 'with a directory: which files, e.g. "*.py"' },
          context: { type: 'integer', description: 'lines around each match (default 2)' },
          offset: { type: 'integer', description: '1-based first line' },
          limit: { type: 'integer', description: 'max lines (default 2000)' },
        },
        required: ['path'],
      },
    })
    await $.tool.register({
      name: 'edit',
      isDeferred: false,
      description:
        `Edit by the IDs from read (the number before ${SEP}, never a line number); batch all edits in one call (they all refer to the file as last read). ` +
        `{from, to?, text}: replace lines from..to (text "" deletes). {after|before, text}: insert. ` +
        `{find, replace, from?, to?}: substring replace in those lines (IDs, or line numbers from Grep), or the whole file without from; no read needed. ` +
        `With a directory path, find/replace edits apply to every file containing find (glob narrows): a multi-file rename in one call. ` +
        `{text} alone on a new path creates the file; {rename: newPath} moves it, IDs kept; {delete: true} removes it; these three only inside the project. ` +
        `text is raw code without IDs. Returns the new lines with their IDs and a syntax check.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'the file for every edit, or a directory for find/replace edits' },
          glob: { type: 'string', description: 'with a directory: which files, e.g. "*.py"' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'this edit\'s file, when one call edits several' },
                from: { type: 'string' }, to: { type: 'string' },
                after: { type: 'string' }, before: { type: 'string' },
                text: { type: 'string' },
                find: { type: 'string' }, replace: { type: 'string' },
                rename: { type: 'string' }, delete: { type: 'boolean' },
              },
            },
          },
        },
        required: ['edits'],
      },
    })
    await $.command.register({ name: 'router', description: 'Model router: what it decided and cost; "/router setup" for its dashboard, settings and the Jev key' })
    if (opts.specs !== 'off') {
      await $.command.register({ name: 'spec', description: 'Specs and decisions, kept like a git tree: /spec, init, browse, status, log, show <id>, diff [ref], accept, drop, export, compact, stats, help' })
      // the store is the git worktree's, else the session root's; one look, and with no store nothing more is read
      const cwd = await $.session.cwd()
      const git = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd, timeoutMs: 5000 }).catch(() => undefined)
      const [top = '', prefix = ''] = git?.exitCode === 0 ? git.stdout.split('\n') : []
      const at = top || (await $.session.root())
      if (note(at, cwd, prefix, await $.fs.exists(`${storeDir(at)}/store.json`), top !== '')) await $.tool.register(TOOL)
    }
    await offerSetup($, opts)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'plusplus:pipeline', text: RULES, scope: 'session' as const }, ...(isOpen() ? [SECTION] : [])] }
  })

  on('tool.call', { tool: READ }, async ($, e) => {
    const { path, pattern, symbol, glob, ...n } = e as unknown as { path: string; pattern?: string; symbol?: string; glob?: string; context?: unknown; offset?: unknown; limit?: unknown }
    // numbers can arrive as strings ("0"); coerce before doing arithmetic with them
    const context = Number(n.context ?? 2), offset = Number(n.offset ?? 1), limit = Number(n.limit ?? 2000)
    try {
      if (symbol) {
        const isDir = (await $.fs.stat(path)).kind === 'dir'
        return { result: await symbolRead($, opts, isDir ? path : path.replace(/\/[^/]*$/, '') || '.', symbol, isDir ? glob : path.split('/').pop(), Number(n.context ?? 0)) }
      }
      if ((await $.fs.stat(path)).kind === 'dir') {
        if (pattern === undefined) return { deny: `${path} is a directory: give a pattern to search it` }
        const re = new RegExp(pattern), parts: string[] = []
        let hits = 0, matched = 0, rels = await walk($, path, glob)
        for (const rel of rels) {
          const { lines } = split(await $.fs.read(`${path}/${rel}`))
          if (!lines.some(l => re.test(l))) continue
          const { key } = await load($, `${path}/${rel}`)
          const found = search(anchored(key, lines), re, context)
          matched++
          if (hits >= MAX_HITS) continue // keep counting files, show no more
          hits += found.hits
          parts.push(`${rel}\n${found.text}`)
        }
        if (!matched) return { result: `no line matches /${pattern}/ in ${rels.length} files` }
        const more = hits >= MAX_HITS ? ` (stopped after ${MAX_HITS} matching lines; narrow pattern or glob for the rest)` : ''
        return { result: `[${matched} files match${more}]\n${parts.join('\n\n')}` }
      }
      const { key, lines } = await load($, path)
      const st = anchored(key, lines)
      if (pattern !== undefined) {
        const { text, hits } = search(st, new RegExp(pattern), context)
        return { result: hits ? `[${hits} matching lines of ${lines.length}]\n${text}` : `no line matches /${pattern}/` }
      }
      const start = Math.max(0, offset - 1), end = Math.min(lines.length, start + limit)
      const head = start > 0 || end < lines.length ? `[lines ${start + 1}-${end} of ${lines.length}]\n` : ''
      return { result: head + render(st, start, end) }
    } catch (err) {
      return { deny: `${path}: ${err}` }
    }
  })

  on('tool.call', { tool: EDIT }, async ($, e) => {
    const { path = '', glob, edits } = e as unknown as { path?: string; glob?: string; edits: (Edit & { path?: string })[] }
    try {
      // one call, many files: the edits are sorted by file and everything is checked before anything changes
      let o: Ops = { create: new Map(), remove: [], move: new Map(), groups: new Map() }
      const whole = edits.some(x => x.path || x.rename !== undefined || x.delete)
      if (path && !whole && (await $.fs.stat(path).catch(() => undefined))?.kind === 'dir') {
        if (!edits.every(x => x.find && x.from === undefined)) return { deny: `${path} is a directory: only whole-file {find, replace} edits apply to a directory` }
        for (const rel of await walk($, path, glob)) {
          const text = await $.fs.read(`${path}/${rel}`)
          const mine = edits.filter(x => text.includes(x.find!)) // each file takes the edits whose find it holds
          if (mine.length) o.groups.set(`${path}/${rel}`, mine)
        }
        if (!o.groups.size) return { deny: `no file under ${path} contains ${edits.map(x => JSON.stringify(x.find)).join(' or ')}; nothing changed` }
      } else {
        const kind = await kinds($, edits.flatMap(x => [x.path ?? path, x.rename ?? '']).filter(Boolean).map(tidy))
        // a rename that only changes case: on a disk that tells no case apart the new name "exists", and is the file itself
        for (const x of edits) if (x.rename !== undefined && kind.get(tidy(x.rename)) && (await sameFile($, tidy(x.path ?? path), tidy(x.rename)))) kind.delete(tidy(x.rename))
        const sorted = ops(edits, path, p => kind.get(p))
        const no = typeof sorted === 'string' ? sorted : await confined($, sorted)
        if (typeof sorted === 'string' || no) return { deny: `${no}\nNothing was changed.` }
        o = sorted
      }
      const r = await editFiles($, o)
      if ('error' in r) return { deny: r.error }
      for (const p of new Set([...o.groups.keys(), ...o.create.keys(), ...o.remove, ...o.move.keys(), ...o.move.values()])) void changedFile($, opts, p)
      return { result: r.text }
    } catch (err) {
      return { deny: `${path}: ${err}` }
    }
  })
}
