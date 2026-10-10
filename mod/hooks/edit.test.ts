import type { On } from 'claude-code'
import { type Engine, expect, test } from 'claude-code/testing'

const TOP = '/repo', READ = 'mcp__plusplus__read', EDIT = 'mcp__plusplus__edit'
const OFF = { codegraph: 'off', router: 'off', specs: 'off' }

/** The engine beneath the plugin: files in memory, the host's mkdir, mv and rm over them, and a Bash that only counts its runs. */
function world(on: On, seed: Record<string, string>) {
  const files = new Map(Object.entries(seed)), ran: string[] = [], bash: string[] = []
  /** `links`: a path that is a link, and where it leads ('' for nowhere); `locked`: a path no write lands on; `blind`: the disk tells no case apart. */
  const w = { files, ran, bash, turns: 1, host: true, stuck: '', locked: '', blind: false, links: new Map<string, string>() }
  /** Absolute, ".." folded, a link on the way followed, and on a blind disk the name as the disk has it. */
  const abs = (p: string, asNamed = false): string => {
    const parts: string[] = []
    for (const part of (p.startsWith('/') ? p : `${TOP}/${p}`).split('/')) part === '..' ? parts.pop() : part && part !== '.' && parts.push(part)
    let out = `/${parts.join('/')}`
    for (const [link, to] of w.links) if (to && (out === link || out.startsWith(`${link}/`))) out = to + out.slice(link.length)
    return (w.blind && !asNamed && [...files.keys()].find(k => k.toLowerCase() === out.toLowerCase())) || out
  }
  const isDir = (p: string) => p === '/' || [...files.keys()].some(k => k.startsWith(`${p}/`))
  const done = (exitCode = 0, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.cwd', () => ({ value: TOP }))
  on('session.root', () => ({ value: TOP }))
  on('session.turns', () => ({ value: w.turns }))
  on('fs.exists', (_$, e) => ({ value: files.has(abs(e.path)) || isDir(abs(e.path)) }))
  on('fs.stat', (_$, e) => {
    const p = abs(e.path)
    if (!files.has(p) && !isDir(p)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: isDir(p) ? ('dir' as const) : ('file' as const), size: files.get(p)?.length ?? 0, mtimeMs: 1, isLink: false, realPath: p } }
  })
  on('fs.list', (_$, e) => {
    const names = new Set([...files.keys(), ...w.links.keys()].filter(k => k.startsWith(`${abs(e.path)}/`)).map(k => k.slice(abs(e.path).length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: isDir(`${abs(e.path)}/${name}`) ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(abs(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    const p = abs(e.path), up = p.split('/').slice(0, -1).map((_x, i, all) => all.slice(0, i + 1).join('/')).find(d => files.has(d))
    if (p === w.locked) return Promise.reject(new Error(`EACCES: ${e.path}`))
    if (up) return Promise.reject(new Error(`EEXIST: ${up} is a file`))
    return files.set(p, e.text), { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv, at = args.slice(args.indexOf('--') + 1).map(p => abs(p))
    if (!w.host) throw new Error('process.run is not available on this host')
    ran.push(e.argv.join(' '))
    if (cmd === 'mv') {
      const from = at[0]!, to = abs(args.at(-1)!, true)
      if (to === w.stuck) return done(1, `mv: ${to}: Permission denied`)
      if (!files.has(from) && !isDir(from)) return done(1, `mv: ${from}: No such file or directory`)
      for (const [k, text] of [...files]) if (k === from || k.startsWith(`${from}/`)) files.delete(k), files.set(to + k.slice(from.length), text)
    } else if (cmd === 'rm') at.forEach(p => files.delete(p))
    return done() // true, mkdir, rmdir, and the syntax checkers: all is well
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => (bash.push(e.command), { result: { stdout: '', stderr: '', interrupted: false }, text: 'ran' }) as never)
  return w
}

type Answer = { result?: unknown; deny?: string; text?: string; isError?: boolean; context?: readonly string[] }
const call = ($: Engine, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never) as Promise<Answer>
const said = (r: Answer) => String(r.deny ?? r.text ?? r.result)
/** The ID a read or an edit result shows for the line holding `text`. */
const id = (shown: string, text: string) => shown.split('\n').find(l => l.includes(text))!.split('§')[0]!

test('a new file is created with its folders and comes back with IDs that edit it without a read', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/a.ts`]: 'export const a = 1\n' })
  const made = said(await call($, EDIT, { edits: [{ path: `${TOP}/src/deep/b.ts`, text: 'export const b = 1\nexport const c = 2' }] }))
  expect(made).toMatch(/^created \/repo\/src\/deep\/b\.ts\n\d+§export const b = 1\n\d+§export const c = 2$/)
  expect(w.files.get(`${TOP}/src/deep/b.ts`)).toBe('export const b = 1\nexport const c = 2\n')
  const next = said(await call($, EDIT, { path: `${TOP}/src/deep/b.ts`, edits: [{ from: id(made, 'c = 2'), text: 'export const c = 3' }] }))
  expect(next).toContain('§export const c = 3')
  expect(w.files.get(`${TOP}/src/deep/b.ts`)).toBe('export const b = 1\nexport const c = 3\n')
  expect(w.ran).toEqual([]) // creating needs no host command
  // onto a path that exists it refuses, and the file is as it was
  const again = await call($, EDIT, { path: `${TOP}/a.ts`, edits: [{ text: 'gone' }] })
  expect(again.deny).toBeDefined()
  expect(said(again)).toContain('/repo/a.ts: exists already')
  expect(said(again)).toContain('Nothing was changed.')
  expect(w.files.get(`${TOP}/a.ts`)).toBe('export const a = 1\n')
})

test('a file is deleted, and one that is not there fails the call', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/a.ts`]: 'a\n', [`${TOP}/b.ts`]: 'b\n' })
  expect(said(await call($, EDIT, { path: `${TOP}/a.ts`, edits: [{ delete: true }] }))).toBe('deleted /repo/a.ts')
  expect([...w.files.keys()]).toEqual([`${TOP}/b.ts`])
  expect(w.ran.map(c => c.split(' ')[0])).toEqual(['true', 'mv', 'rm']) // the host is asked whether it runs commands; then moved aside, then removed
  const miss = await call($, EDIT, { edits: [{ path: `${TOP}/b.ts`, find: 'b', replace: 'B' }, { path: `${TOP}/a.ts`, delete: true }] })
  expect(said(miss)).toBe('/repo/a.ts: no such file to delete\nNothing was changed.')
  expect(w.files.get(`${TOP}/b.ts`)).toBe('b\n')
})

test('a renamed file keeps its anchors under the new path, edits in the same call included', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/old.ts`]: 'one\ntwo\nthree\n', [`${TOP}/taken.ts`]: 'x\n' })
  const shown = said(await call($, READ, { path: `${TOP}/old.ts` })), two = id(shown, 'two'), three = id(shown, 'three')
  const out = said(await call($, EDIT, { edits: [{ path: `${TOP}/old.ts`, rename: `${TOP}/lib/new.ts`, from: two, text: 'TWO' }] }))
  expect(out).toContain('renamed /repo/old.ts to /repo/lib/new.ts')
  expect(out).toContain('§TWO')
  expect(w.files.get(`${TOP}/lib/new.ts`)).toBe('one\nTWO\nthree\n')
  expect(w.files.has(`${TOP}/old.ts`)).toBe(false)
  expect(w.ran).toEqual(['true', 'mkdir -p -- /repo/lib', 'mv -- /repo/old.ts /repo/lib/new.ts'])
  // the ID read under the old name still names its line
  expect(said(await call($, EDIT, { path: `${TOP}/lib/new.ts`, edits: [{ from: three, text: 'THREE' }] }))).toContain('§THREE')
  // a folder moves with the anchors of the files in it
  const inLib = id(said(await call($, READ, { path: `${TOP}/lib/new.ts` })), 'one')
  expect(said(await call($, EDIT, { path: `${TOP}/lib`, edits: [{ rename: `${TOP}/pkg` }] }))).toBe('renamed /repo/lib to /repo/pkg')
  expect(said(await call($, EDIT, { path: `${TOP}/pkg/new.ts`, edits: [{ from: inLib, text: 'ONE' }] }))).toContain('§ONE')
  for (const [path, rename, why] of [[`${TOP}/pkg/new.ts`, `${TOP}/taken.ts`, 'which exists'], [`${TOP}/nope.ts`, `${TOP}/x.ts`, 'no such file to rename']] as const) {
    const no = await call($, EDIT, { path, edits: [{ rename }] })
    expect(no.deny).toBeDefined()
    expect(said(no)).toContain(why)
  }
  expect(w.files.get(`${TOP}/taken.ts`)).toBe('x\n')
})

test('one call creates, renames, deletes and edits, or does none of it', { options: OFF }, async ($, on) => {
  const seed = { [`${TOP}/a.ts`]: 'alpha\n', [`${TOP}/b.ts`]: 'beta\n', [`${TOP}/c.ts`]: 'gamma\n' }
  const w = world(on, seed)
  const edits = [
    { path: `${TOP}/new.ts`, text: 'fresh' },
    { path: `${TOP}/a.ts`, rename: `${TOP}/moved.ts` },
    { path: `${TOP}/b.ts`, delete: true },
    { path: `${TOP}/c.ts`, find: 'gamma', replace: 'delta' },
  ]
  // a stale anchor in one file: nothing is created, moved or deleted
  await call($, READ, { path: `${TOP}/c.ts` })
  const bad = await call($, EDIT, { edits: [...edits, { path: `${TOP}/c.ts`, from: '999', text: 'x' }] })
  expect(said(bad)).toContain('unknown anchor "999"')
  expect(said(bad)).toContain('Nothing was changed in any file.')
  expect(Object.fromEntries(w.files)).toEqual(seed)
  expect(w.ran).toEqual([])
  // the host refuses one move: what was already moved goes back
  w.stuck = `${TOP}/moved.ts`
  const stuck = said(await call($, EDIT, { edits }))
  expect(stuck).toBe('/repo/a.ts: cannot rename: mv: /repo/moved.ts: Permission denied (deleting and renaming run mv and rm on the host)\nNothing was changed in any file.')
  expect(Object.fromEntries(w.files)).toEqual(seed)
  // a host that runs no commands: said, and nothing changed; creating and editing still work there
  w.stuck = '', w.host = false
  expect(said(await call($, EDIT, { edits }))).toMatch(/^\/repo\/b\.ts: cannot delete: .*process\.run.* \(deleting and renaming run mv and rm on the host\)\nNothing was changed in any file\.$/)
  expect(Object.fromEntries(w.files)).toEqual(seed)
  expect(said(await call($, EDIT, { edits: [edits[0]] }))).toContain('created /repo/new.ts')
  w.files.delete(`${TOP}/new.ts`)
  w.host = true
  const ok = said(await call($, EDIT, { edits }))
  expect(ok).toContain('deleted /repo/b.ts')
  expect(ok).toContain('renamed /repo/a.ts to /repo/moved.ts')
  expect(ok).toMatch(/created \/repo\/new\.ts\n\d+§fresh/)
  expect(ok).toMatch(/\/repo\/c\.ts\n\d+§delta/)
  expect(Object.fromEntries(w.files)).toEqual({ [`${TOP}/moved.ts`]: 'alpha\n', [`${TOP}/c.ts`]: 'delta\n', [`${TOP}/new.ts`]: 'fresh\n' })
})

test('a call that fails late has deleted and moved nothing: every write succeeds before a deleted file goes for good', { options: OFF }, async ($, on) => {
  const seed = { [`${TOP}/keep.txt`]: 'keep\n', [`${TOP}/README.md`]: 'readme\n', [`${TOP}/src/x.ts`]: 'one\n', [`${TOP}/c.ts`]: 'gamma\n' }
  const w = world(on, seed), same = () => expect(Object.fromEntries(w.files)).toEqual(seed)
  // a new file whose parent is a file: refused before anything runs
  const under = await call($, EDIT, { edits: [{ path: `${TOP}/keep.txt`, delete: true }, { path: `${TOP}/README.md/sub.txt`, text: 'x' }] })
  expect(said(under)).toBe('/repo/README.md/sub.txt: /repo/README.md is a file, not a folder\nNothing was changed.')
  expect(w.ran).toEqual([])
  same()
  const edits = [
    { path: `${TOP}/keep.txt`, delete: true },
    { path: `${TOP}/README.md`, rename: `${TOP}/docs/README.md` },
    { path: `${TOP}/src`, rename: `${TOP}/lib` },
    { path: `${TOP}/c.ts`, find: 'gamma', replace: 'delta' },
    { path: `${TOP}/first.ts`, text: 'first' },
    { path: `${TOP}/lib/last.ts`, text: 'last' }, // under the renamed folder: made after the rename, so it is the last write of all
  ]
  // each write in turn fails: a new file, an edited file, the new file that comes after the delete and both renames
  for (const [locked, why] of [[`${TOP}/first.ts`, 'create'], [`${TOP}/c.ts`, 'write'], [`${TOP}/lib/last.ts`, 'create']] as const) {
    w.locked = locked
    w.ran.length = 0
    const r = await call($, EDIT, { edits })
    expect(r.deny).toBeDefined()
    expect(said(r).split('\n')[0]).toMatch(new RegExp(`^${locked}: cannot ${why}: `))
    expect(said(r).split('\n')[1]).toBe('Nothing was changed in any file.')
    same()
    expect(w.ran.some(c => c.startsWith('rm -f -- /repo/keep.txt.deleted-'))).toBe(false) // the set-aside copy was never removed: it was moved back
  }
  expect(w.ran.filter(c => c.startsWith('mv')).length).toBe(6) // the last failure came after three moves, and undid each
  // the same call when nothing fails: the deleted file's copy is removed last of all
  w.locked = ''
  w.ran.length = 0
  expect(said(await call($, EDIT, { edits }))).toContain('created /repo/lib/last.ts')
  expect(Object.fromEntries(w.files)).toEqual({ [`${TOP}/docs/README.md`]: 'readme\n', [`${TOP}/lib/x.ts`]: 'one\n', [`${TOP}/c.ts`]: 'delta\n', [`${TOP}/first.ts`]: 'first\n', [`${TOP}/lib/last.ts`]: 'last\n' })
  expect(w.ran.at(-1)).toMatch(/^rm -f -- \/repo\/keep\.txt\.deleted-\w+$/)
})

test('create, delete and rename stay inside the project by real path, and leave .git alone; line edits keep their own rule', { options: OFF }, async ($, on) => {
  const seed = { [`${TOP}/a.ts`]: 'alpha\n', [`${TOP}/.git/config`]: '[core]\n', [`${TOP}/sub/.git`]: 'gitdir: x\n', '/elsewhere/victim.txt': 'mine\n', '/repo-other/b.ts': 'b\n' }
  const w = world(on, seed)
  w.links.set(`${TOP}/out`, '/elsewhere') // a folder that is a link out of the project
  w.links.set(`${TOP}/dangling.txt`, '') // a link that leads nowhere
  const OUT = 'is outside the project (/repo); edit creates, deletes and renames only inside it'
  for (const [edit, why] of [
    [{ path: `${TOP}/../escaped.txt`, text: 'x' }, `/repo/../escaped.txt: ${OUT}`],
    [{ path: '/elsewhere/new.txt', text: 'x' }, `/elsewhere/new.txt: ${OUT}`],
    [{ path: `${TOP}/sub/../../up/new.txt`, text: 'x' }, `/repo/sub/../../up/new.txt: ${OUT}`],
    [{ path: `${TOP}/out/new.txt`, text: 'x' }, `/repo/out/new.txt: ${OUT}`],
    [{ path: `${TOP}/dangling.txt`, text: 'x' }, '/repo/dangling.txt: /repo/dangling.txt is a link that leads nowhere'],
    [{ path: `${TOP}/../elsewhere/victim.txt`, delete: true }, `/repo/../elsewhere/victim.txt: ${OUT}`],
    [{ path: '/elsewhere/victim.txt', delete: true }, `/elsewhere/victim.txt: ${OUT}`],
    [{ path: `${TOP}/out/victim.txt`, delete: true }, `/repo/out/victim.txt: ${OUT}`],
    [{ path: '/repo-other/b.ts', delete: true }, `/repo-other/b.ts: ${OUT}`], // a sibling whose name begins as the project's does
    [{ path: `${TOP}/a.ts`, rename: `${TOP}/sub/../../escaped.ts` }, `/repo/sub/../../escaped.ts: ${OUT}`],
    [{ path: `${TOP}/a.ts`, rename: `${TOP}/out/a.ts` }, `/repo/out/a.ts: ${OUT}`],
    [{ path: '/elsewhere/victim.txt', rename: `${TOP}/taken.txt` }, `/elsewhere/victim.txt: ${OUT}`],
    [{ path: '/elsewhere', rename: `${TOP}/all` }, `/elsewhere: ${OUT}`],
    [{ path: TOP, rename: '/repo2' }, `/repo: ${OUT}`],
    [{ path: `${TOP}/.git/config`, delete: true }, '/repo/.git/config: is in a .git folder; edit deletes and renames nothing there'],
    [{ path: `${TOP}/.git`, rename: `${TOP}/git-away` }, '/repo/.git: is in a .git folder; edit deletes and renames nothing there'],
    [{ path: `${TOP}/sub/.git`, delete: true }, '/repo/sub/.git: is in a .git folder; edit deletes and renames nothing there'],
    [{ path: `${TOP}/a.ts`, rename: `${TOP}/.git/hooks/pre-commit` }, '/repo/.git/hooks/pre-commit: is in a .git folder; edit deletes and renames nothing there'],
  ] as const) {
    // alone, and beside an edit that could stand: the whole call is refused
    for (const edits of [[edit], [{ path: `${TOP}/a.ts`, find: 'alpha', replace: 'beta' }, edit]]) {
      const r = await call($, EDIT, { edits })
      expect(r.deny).toBeDefined()
      expect(said(r)).toBe(`${why}\nNothing was changed.`)
    }
  }
  expect(Object.fromEntries(w.files)).toEqual(seed)
  expect(w.ran).toEqual([])
  // a line edit of a file that is there is not asked where it is: as before
  expect(said(await call($, EDIT, { path: '/elsewhere/victim.txt', edits: [{ find: 'mine', replace: 'yours' }] }))).toContain('§yours')
  // and inside the project all three work, by a path that goes up and comes back too
  expect(said(await call($, EDIT, { edits: [{ path: `${TOP}/sub/new.ts`, text: 'x' }, { path: `${TOP}/sub/../a.ts`, rename: `${TOP}/sub/a.ts` }] }))).toContain('renamed /repo/sub/../a.ts to /repo/sub/a.ts')
  expect(w.files.get(`${TOP}/sub/a.ts`)).toBe('alpha\n')
  expect(w.files.get(`${TOP}/sub/new.ts`)).toBe('x\n')
})

test('a rename that only changes case moves the file on a disk that tells no case apart', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/lib/renamed.ts`]: 'x\n', [`${TOP}/lib/Other.ts`]: 'y\n' })
  w.blind = true
  expect(said(await call($, EDIT, { path: `${TOP}/lib/renamed.ts`, edits: [{ rename: `${TOP}/lib/Renamed.ts` }] }))).toBe('renamed /repo/lib/renamed.ts to /repo/lib/Renamed.ts')
  expect([...w.files.keys()].sort()).toEqual([`${TOP}/lib/Other.ts`, `${TOP}/lib/Renamed.ts`])
  // onto another file it is still refused, under any case
  expect(said(await call($, EDIT, { path: `${TOP}/lib/Renamed.ts`, edits: [{ rename: `${TOP}/lib/other.ts` }] }))).toContain('cannot rename to /repo/lib/other.ts, which exists')
  // where case is told apart, two names are two files
  w.blind = false
  w.files.set(`${TOP}/lib/renamed.ts`, 'z\n')
  expect(said(await call($, EDIT, { path: `${TOP}/lib/renamed.ts`, edits: [{ rename: `${TOP}/lib/Renamed.ts` }] }))).toContain('which exists')
})

const SED = `sed -i 's/alpha/beta/g' a.ts`, LINE = `files with ${EDIT}, not sed -i: {path: "a.ts", edits: [{find: "alpha", replace: "beta"}]}`

test('enforce refuses a scripted edit before it runs and names the edit call', { options: { ...OFF, shellEdits: 'enforce' } }, async ($, on) => {
  const w = world(on, { [`${TOP}/a.ts`]: 'alpha\n' })
  const no = await call($, 'Bash', { command: SED })
  expect(no.deny).toBeDefined()
  expect(said(no)).toBe(`Not run: edit ${LINE}`)
  expect((await call($, 'Bash', { command: 'echo x >> a.ts' })).deny).toBeDefined()
  expect(w.bash).toEqual([])
  // what is no scripted edit runs untouched: a formatter, a redirect into a new file
  for (const command of ['prettier --write .', 'echo x > new.txt', 'git commit -m "sed -i"']) expect((await call($, 'Bash', { command })).context).toBeUndefined()
  expect(w.bash.length).toBe(3)
})

test('warn lets it run and says so beside the result, three times a loop a turn at most', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/a.ts`]: 'alpha\n' })
  for (let i = 0; i < 3; i++) {
    const r = await call($, 'Bash', { command: SED })
    expect(r.text).toBe('ran')
    expect(r.context).toEqual([`Next time edit ${LINE}`])
  }
  expect((await call($, 'Bash', { command: SED })).context).toBeUndefined()
  expect((await call($, 'Bash', { command: 'ls' })).context).toBeUndefined()
  // another loop has its own three, and so has the next turn
  expect((await call($, 'Bash', { command: SED, agentId: 'a1' })).context?.length).toBe(1)
  w.turns++
  expect((await call($, 'Bash', { command: SED })).context?.length).toBe(1)
  expect(w.bash.length).toBe(7)
})

test('off leaves every command alone', { options: { ...OFF, shellEdits: 'off' } }, async ($, on) => {
  const w = world(on, { [`${TOP}/a.ts`]: 'alpha\n' })
  expect((await call($, 'Bash', { command: SED })).context).toBeUndefined()
  expect(w.bash).toEqual([SED])
})
