import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { unpack } from './pack'
import { HELP, INTERVIEW, SURVEY, TOOL, rooted } from './specs'

const TOP = '/repo', DIR = `${TOP}/.plusplus/specs`, SPEC = 'mcp__plusplus__spec'
const OFF = { codegraph: 'off', router: 'off' }
const enc = new TextEncoder(), dec = new TextDecoder()
const b64 = (b: Uint8Array) => btoa(Array.from(b, c => String.fromCharCode(c)).join(''))
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

/** The engine beneath the plugin: a file system in memory, the few commands the tracker runs, a clock, and tools that answer. */
function world(on: On, seed: Record<string, string> = { [`${DIR}/store.json`]: '{"format":1}\n' }) {
  const files = new Map<string, Uint8Array>(Object.entries(seed).map(([p, t]) => [p, enc.encode(t)]))
  const ran: string[] = [], listed: string[] = [], tools: string[] = [], submitted: string[] = [], toasts: string[] = [], lots: number[] = []
  // what git has: the store's files as the last commit holds them, the paths it was told of, and the ways it is made to fail
  const git = { head: undefined as Map<string, Uint8Array> | undefined, known: new Set<string>(), locked: false, flood: false, turns: 1, busy: false }
  const ok = (stdout = '', cut = false) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: cut, isStderrTruncated: false } })
  const fail = (exitCode: number, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  const inStore = () => [...files.keys()].filter(p => p.startsWith(`${DIR}/`))
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.turns', () => ({ value: git.turns }))
  on('prompt.submit', (_$, e) => {
    if (git.busy) throw new Error('the session is busy')
    return submitted.push(e.text), { text: e.text }
  })
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }) as never)
  on('session.cwd', () => ({ value: TOP }))
  on('session.root', () => ({ value: TOP }))
  on('session.model', () => ({ value: 'claude-test-1' }))
  on('tool.register', (_$, e) => (tools.push((e as unknown as { name: string }).name), { value: undefined } as never))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_$, e) => ({ value: { kind: [...files.keys()].some(p => p.startsWith(`${e.path}/`)) ? ('dir' as const) : ('file' as const), size: files.get(e.path)?.length ?? 0, mtimeMs: 1, isLink: false, realPath: e.path } }))
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    return { value: [...files].filter(([p]) => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/')).map(([p, b]) => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: b.length, mtimeMs: 1 })) } as never
  })
  on('fs.read', (_$, e) => {
    const b = files.get(e.path)
    if (!b) throw new Error(`ENOENT ${e.path}`)
    return { value: e.as === 'bytes' ? { base64: b64(b) } : dec.decode(b) }
  })
  on('fs.write', (_$, e) => (files.set(e.path, enc.encode(e.text)), { value: undefined }))
  on('process.run', (_$, e) => {
    const a = e.argv, cmd = a.slice(0, 2).join(' ')
    ran.push(a.join(' '))
    if (cmd === 'git rev-parse' && a[2] === '--verify') return git.head ? ok(`${'c0ffee'.repeat(7).slice(0, 40)}\n`) : fail(1)
    if (cmd === 'git rev-parse') return ok(`${TOP}\n\n`)
    if (cmd === 'git symbolic-ref') return ok('main\n')
    if (cmd === 'git check-ignore') return fail(1)
    if (cmd === 'git ls-tree') return ok([...(git.head ?? [])].map(([p, b]) => `100644 blob ${'0'.repeat(40)} ${String(b.length).padStart(7)}\t${p.slice(TOP.length + 1)}`).join('\0'))
    if (cmd === 'git status') {
      const rows = inStore().filter(p => !git.head?.has(p)).map(p => `${git.known.has(p) ? ' A' : '??'} ${p.slice(TOP.length + 1)}`)
      return ok([...rows, ...[...(git.head?.keys() ?? [])].filter(p => !files.has(p)).map(p => ` D ${p.slice(TOP.length + 1)}`)].join('\0'))
    }
    if (cmd === 'git add' && git.locked) return fail(128, "fatal: Unable to create '/repo/.git/index.lock': File exists.")
    if (cmd === 'git add') return (a[2] === '-A' ? inStore() : a.slice(a.indexOf('--') + 1)).forEach(p => git.known.add(p.startsWith('/') ? p : `${TOP}/${p}`)), ok()
    // a commit's files from one `git cat-file --batch`: a header line, the bytes and a newline for each name on stdin, all as base64
    if (cmd === 'sh -c' && a[2]!.includes('cat-file --batch')) {
      const names = (e.init?.stdin ?? '').split('\n').filter(Boolean), parts: Uint8Array[] = []
      lots.push(names.length)
      for (const name of names) {
        const b = git.head?.get(`${TOP}/${name.slice(name.indexOf(':') + 1)}`)
        parts.push(enc.encode(b ? `${'0'.repeat(40)} blob ${b.length}\n` : `${name} missing\n`), ...(b ? [b, enc.encode('\n')] : []))
      }
      const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
      let at = 0, bin = ''
      for (const x of parts) out.set(x, at), (at += x.length)
      for (let i = 0; i < out.length; i += 0x6000) bin += `${btoa(String.fromCharCode(...out.subarray(i, i + 0x6000)))}\n` // lines, as GNU base64 wraps
      return ok(bin, bin.length > 4 << 20)
    }
    if (cmd === 'git config') return ok('Test Person\n')
    if (cmd === 'git ls-files') return ok([...files.keys()].filter(p => !p.includes('/.plusplus/')).map(p => p.slice(TOP.length + 1)).join('\0'), git.flood)
    if (a[0] === 'mkdir') return ok()
    if (cmd === 'mv -f') return files.set(a[3]!, files.get(a[2]!)!), files.delete(a[2]!), ok()
    if (cmd === 'sh -c') return files.set(a[4]!, unb64(e.init?.stdin ?? '')), ok() // the atomic binary write
    if (cmd === 'rm -f') return a.slice(3).forEach(f => files.delete(`${e.init?.cwd}/${f}`)), ok()
    return { value: { exitCode: 127, stdout: '', stderr: `no ${a[0]}`, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the built-in Read, as core answers it
  on('tool.call', { tool: 'Read' }, () => ({ result: 'text', text: 'text' }) as never)
  on('session.compact', (_$, e) => ({ messages: e.messages }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  const stored = (ext: string) => [...files.keys()].filter(p => p.startsWith(`${DIR}/`) && p.endsWith(ext)).map(p => p.slice(DIR.length + 1))
  /** A commit: git has the store as it stands. */
  const commit = () => void (git.head = new Map(inStore().map(p => [p, files.get(p)!])))
  /** A loose segment as another writer left it: these lines, under the name their bytes hash to. */
  const segment = async (lines: readonly string[], inHead = false) => {
    const bytes = enc.encode(lines.join('\n') + '\n'), sum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
    const name = `${Array.from(sum.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('')}.jsonl`
    ;(inHead ? (git.head ??= new Map()) : files).set(`${DIR}/${name}`, bytes)
    return name
  }
  return { files, ran, listed, tools, stored, submitted, toasts, lots, clock, git, commit, segment }
}

type Answer = { result?: unknown; deny?: string; text?: string; isError?: boolean; context?: readonly string[] }
const call = ($: Engine, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never) as Promise<Answer>
const said = (r: Answer) => String(r.deny ?? r.text ?? r.result)
const spec = async ($: Engine, args: string) => (await $.command.run({ command: 'spec', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)).text ?? ''

const COMPOSE = { model: 'claude-test-1', promptModel: 'claude-test-1', surfaces: [], tools: [], outputStyle: null, traits: [] }

const MONEY = { title: 'Amounts are integer cents', why: 'Floats lost a cent on refunds; decimals were turned down as slower.', refs: ['src/money.ts'] }

test('add writes one segment named by its hash, and the tool reads it back', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'export const cents = 1\n' })
  const added = await call($, SPEC, { add: [MONEY, { title: 'Billing', kind: 'area', refs: ['src/billing/'] }] })
  expect(said(added)).toMatch(/^added [a-z2-7]{6} decision!proposed Amounts are integer cents\nadded [a-z2-7]{6} area!proposed Billing$/)
  const [file] = w.stored('.jsonl')
  expect(w.stored('.jsonl').length).toBe(1)
  const bytes = w.files.get(`${DIR}/${file}`)!, sum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
  expect(file).toBe(`${Array.from(sum.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('')}.jsonl`)
  const lines = dec.decode(bytes).trimEnd().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => [l.by, l.via, l.status, l.kind])).toEqual([['Test Person', 'agent claude-test-1', 'proposed', 'decision'], ['Test Person', 'agent claude-test-1', 'proposed', 'area']])
  expect(lines[0].writer).toMatch(/^[0-9a-f]{12}$/)
  expect(w.ran.some(c => c === `git add -N -- ${DIR}/${file}`)).toBe(true)
  expect(w.ran.some(c => c.startsWith('git ls-files') && c.endsWith('-- . :(exclude).plusplus'))).toBe(true)
  expect(w.files.has(`${DIR}/${file}.tmp`)).toBe(false)

  const all = said(await call($, SPEC))
  expect(all).toMatch(/^2 records: 2 proposed, 1 area, 0 stale\n/)
  expect(all).toContain('Amounts are integer cents')
  const one = said(await call($, SPEC, { id: lines[0].id.slice(0, 6) }))
  expect(one).toContain('why: Floats lost a cent')
  expect(one).toContain('refs: src/money.ts')
  expect(one).toContain(`${lines[0].id} proposed, by Test Person via agent claude-test-1, 2025-10-09`)
  expect(one).toMatch(/\nhistory:\n [a-z2-7]{6} 2025-10-09 Test Person via agent claude-test-1: created decision, title "Amounts are integer cents", why, \+src\/money\.ts$/)
  expect(one).toBe(await spec($, `show ${lines[0].id.slice(0, 6)}`))
  expect(said(await call($, SPEC, { path: `${TOP}/src/money.ts` }))).toMatch(/^[a-z2-7]{6} decision!proposed Amounts are integer cents$/)
  expect(said(await call($, SPEC, { path: 'src/billing/tax/vat.ts' }))).toContain('Billing')
  expect(said(await call($, SPEC, { find: 'integer  CENTS' }))).toMatch(/^1 match\n/)
  expect(said(await call($, SPEC, { find: 'cents amounts' }))).toMatch(/^1 match\n/) // the words, in any order
  expect(said(await call($, SPEC, { find: 'a.*b' }))).toContain('no record mentions')
})

test('one refused add keeps the whole call out, and says which and why', { options: OFF }, async ($, on) => {
  const w = world(on)
  const r = await call($, SPEC, { add: [MONEY, { title: 'Fixed the rounding bug', why: 'x', refs: ['src/money.ts'] }, { title: 'No ref here', why: 'y' }] })
  expect(said(r)).toContain('nothing was recorded')
  expect(said(r)).toContain('add[0] "Amounts are integer cents": fine')
  expect(said(r)).toContain('add[1] "Fixed the rounding bug": the title opens with "Fixed"')
  expect(said(r)).toContain('add[2] "No ref here": a decision needs a ref')
  expect(w.stored('.jsonl')).toEqual([])
  expect(said(await call($, SPEC))).toMatch(/^0 records/)
  // the same record twice is answered with the one that exists
  await call($, SPEC, { add: [MONEY] })
  expect(said(await call($, SPEC, { add: [{ ...MONEY, title: 'amounts are integer cents.' }] }))).toContain('exists: ')
  expect(w.stored('.jsonl').length).toBe(1)
})

test('a loop adds ten records in a turn, each loop its own ten, and the count starts again with the next prompt', { options: OFF }, async ($, on) => {
  const w = world(on)
  const rule = (i: number | string) => ({ ...MONEY, title: `Rule number ${i} holds` })
  for (let i = 0; i < 4; i++) expect(said(await call($, SPEC, { add: [rule(i), rule(`${i}b`)] }))).toMatch(/^added /)
  expect(said(await call($, SPEC, { add: [rule(8), rule(9), rule(10)] }))).toBe('nothing was recorded: this loop may add 2 more records this turn (10 a turn, 8 added) and this call holds 3. Send the ones that matter most, and tell the person what else you would record: the count starts again with their next prompt.')
  expect(said(await call($, SPEC, { add: [rule(8), rule(9)] }))).toMatch(/^added /)
  expect(said(await call($, SPEC, { add: [rule(10)] }))).toContain('may add 0 more records this turn (10 a turn, 10 added) and this call holds 1. Tell the person')
  expect(w.stored('.jsonl').length).toBe(5)
  // a subagent is another loop: it has its own count, and its records say what wrote them
  expect(said(await call($, SPEC, { add: [rule('sub')], agentId: 'a1' }))).toMatch(/^added /)
  const last = dec.decode([...w.files].filter(([p]) => p.endsWith('.jsonl')).map(([, b]) => b).at(-1)).trimEnd().split('\n').map(l => JSON.parse(l))
  expect(last.map(l => [l.title, l.via])).toEqual([['Rule number sub holds', 'agent claude-test-1 (subagent)']])
  w.git.turns++
  expect(said(await call($, SPEC, { add: [rule(10)] }))).toMatch(/^added /)
})

test('a batch names its own parents by key, and is written whole or not at all', { options: OFF }, async ($, on) => {
  const w = world(on)
  const batch = [{ title: 'Billing', kind: 'area', refs: ['src/billing/'], key: 'billing' }, { ...MONEY, refs: ['src/billing/money.ts'], under: 'billing' }]
  expect(said(await call($, SPEC, { add: [batch[1], batch[0]] }))).toContain('add[0] "Amounts are integer cents": under "billing" is add[1], which comes after this one: put the parent first')
  expect(w.stored('.jsonl')).toEqual([])
  expect(said(await call($, SPEC, { add: batch }))).toMatch(/^added \S+ area!proposed \+1 Billing\nadded \S+ decision!proposed Amounts are integer cents$/)
  expect(await spec($, '')).toMatch(/^2 records: 2 proposed, 1 area, 1 stale\n\S+ area!proposed Billing\n \S+ decision!stale Amounts are integer cents\n\n\/spec \| status/)
  // whatever is handed in is read, never trusted
  expect(said(await call($, SPEC, { add: [{ title: 7, refs: 'x' }, null] }))).toContain('add[0] "": the title is not text')
})

test('the read setting answers questions and refuses adds', { options: { ...OFF, specs: 'read' } }, async ($, on) => {
  const w = world(on)
  expect(said(await call($, SPEC, { add: [MONEY] }))).toContain('read-only')
  expect(said(await call($, SPEC))).toMatch(/^0 records/)
  expect(w.stored('.jsonl')).toEqual([])
})

test('records governing a file are shown beside its first read in a loop, and again after a compaction', { options: OFF }, async ($, on) => {
  world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'export const cents = 1\n', [`${TOP}/src/tax.ts`]: 'export const vat = 21\n' })
  const rules = ['Amounts are integer cents', 'Rounding is half-even', 'Currency is ISO 4217', 'Negative amounts are refunds'].map(title => ({ ...MONEY, title }))
  await call($, SPEC, { add: [...rules, { title: 'VAT is charged at the buyer rate', why: 'EU rule; seller rate was turned down.', refs: ['src/tax.ts'] }] })

  const first = await call($, 'Read', { file_path: `${TOP}/src/money.ts` })
  expect(first.result).toBe('text')
  expect(first.context?.length).toBe(1)
  const lines = first.context![0]!.split('\n')
  expect(lines.length).toBe(4)
  expect(lines[0]).toMatch(/^spec [a-z2-7]{6} decision!proposed Amounts are integer cents$/)
  expect(lines[3]).toBe('+1 more: spec {path: "src/money.ts"}')
  // the one left over comes with the next read, and then nothing more does
  expect((await call($, 'Read', { file_path: 'src/money.ts' })).context?.[0]).toMatch(/^spec \S+ decision!proposed Negative amounts are refunds$/)
  expect((await call($, 'Read', { file_path: 'src/money.ts' })).context).toBeUndefined()
  expect((await call($, 'Read', { file_path: `${TOP}/README.md` })).context).toBeUndefined()

  // the mod's own read answers without `next`: the hook above it still sees its result
  const own = await call($, 'mcp__plusplus__read', { path: `${TOP}/src/tax.ts` })
  expect(said(own)).toContain('export const vat = 21')
  expect(own.context?.[0]).toMatch(/^spec \S+ decision!proposed VAT is charged at the buyer rate$/)

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect((await call($, 'Read', { file_path: 'src/tax.ts' })).context?.[0]).toContain('VAT is charged')
})

test('a file that is not what its name says is set aside and reported, and the rest still load', { options: OFF }, async ($, on) => {
  const w = world(on)
  await call($, SPEC, { add: [MONEY] })
  w.files.set(`${DIR}/00000000deadbeef.jsonl`, enc.encode('{"id":"not a change"}\n'))
  w.files.set(`${DIR}/notes.jsonl`, enc.encode('hello\n'))
  w.files.set(`${DIR}/ffffffffffffffff.aesp`, new Uint8Array([0x41, 0x45, 0x53, 0x50, 0, 9]))
  const all = said(await call($, SPEC))
  expect(all).toContain('Amounts are integer cents')
  expect(all).toMatch(/\n\(3 store files are set aside as unreadable: \/spec stats names them\)$/)
  const stats = await spec($, 'stats')
  expect(stats).toContain('set aside: 3')
  expect(stats).toContain('00000000deadbeef.jsonl: its bytes do not hash to its name')
  expect(stats).toContain('notes.jsonl: its name is not the hash of its bytes')
  expect(stats).toContain('files: 1 loose segments')
  expect(await spec($, 'compact')).toContain('Not sealing while 3 files are set aside')
  // taken away, they are forgotten
  for (const f of ['00000000deadbeef.jsonl', 'notes.jsonl', 'ffffffffffffffff.aesp']) w.files.delete(`${DIR}/${f}`)
  expect(await spec($, 'stats')).toContain('set aside: none')
})

test('without a store there is no tool and nothing is read; /spec init makes one', { options: OFF }, async ($, on) => {
  const w = world(on, {})
  await $.session.start({ cwd: TOP, surface: null, isInteractive: false })
  expect(w.tools).toEqual(['read', 'edit'])
  expect((await $.prompt.compose(COMPOSE)).sections.some(s => s.id === 'plusplus:specs')).toBe(false)
  expect(said(await call($, SPEC))).toContain('no spec store')
  expect((await call($, 'Read', { file_path: 'src/money.ts' })).context).toBeUndefined()
  expect(await spec($, '')).toContain('/spec init creates one')
  expect(await spec($, 'help')).toBe(HELP)
  expect(HELP).toContain('branch and merge it with git')
  expect(w.listed).toEqual([])
  expect(w.files.size).toBe(0)

  expect(await spec($, 'init --bare')).toBe(`Created the store ${DIR}. Commit the folder to share it. Agents add records with the spec tool; /spec shows them.`)
  await w.clock.advance(5000)
  expect(w.submitted).toEqual([])
  expect(await spec($, 'init')).toBe(`There is a store already: ${DIR}. Nothing was changed; /spec shows it.`)
  expect(dec.decode(w.files.get(`${DIR}/store.json`))).toBe('{"format":1}\n')
  expect(dec.decode(w.files.get(`${DIR}/.gitattributes`))).toBe('*.aesp binary\n*.jsonl text eol=lf\n')
  expect(dec.decode(w.files.get(`${DIR}/.gitignore`))).toBe('*.tmp*\n')
  expect(w.tools).toEqual(['read', 'edit', 'spec'])
  expect((await $.prompt.compose(COMPOSE)).sections.some(s => s.id === 'plusplus:specs')).toBe(true)
  expect(await spec($, '')).toBe(`0 records: 0 proposed, 0 areas, 0 stale\nNo records yet.\n\n${HELP}`)
  expect(await spec($, 'branch x')).toBe(`/spec has no "branch".\n${HELP}`)
})

test('/spec init hands the model the first tree: a survey where there is code, an interview where there is none', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/README.md`]: '# x\n', [`${TOP}/.gitignore`]: 'node_modules\n', [`${TOP}/package.json`]: '{}\n' })
  await $.session.start({ cwd: TOP, surface: null, isInteractive: false })
  const made = await spec($, 'init')
  expect(made).toContain(`Created the store ${DIR}`)
  expect(made).toContain('The repository has 1 source file: the agent is asked to interview you for the first tree.')
  // the prompt is not the command's to submit: it goes once the command has answered
  expect(w.submitted).toEqual([])
  await w.clock.advance(300)
  expect(w.submitted).toEqual([rooted(INTERVIEW, TOP)])
  expect(w.submitted[0]).toContain('\n\nThe repository root is /repo: the store covers what is under it and nothing else. Stay inside it')
  expect(made).toContain('It is asked once the session is idle; a one-shot headless run (claude -p) ends before that, so there ask the agent directly.')
  expect(INTERVIEW).toContain('AskUserQuestion')
  for (const text of [INTERVIEW, SURVEY]) expect(text.startsWith('/')).toBe(false) // a text that opens with a slash is refused as a command
  // the first tree is more than a turn's ten: init grants the session eighty on top, once
  const tree = [{ title: 'Core', kind: 'area', refs: ['src/'], key: 'core' }, ...Array.from({ length: 39 }, (_, i) => ({ ...MONEY, title: `Rule ${i} of the first tree`, under: 'core' }))]
  expect(said(await call($, SPEC, { add: tree })).split('\n').length).toBe(40)
  expect(said(await call($, SPEC, { add: tree.slice(1).map(a => ({ ...a, title: `${a.title} again`, under: undefined })) }))).toMatch(/^added /)
  w.git.turns++
  expect(said(await call($, SPEC, { add: tree.slice(1, 22).map(a => ({ ...a, title: `${a.title} thrice`, under: undefined })) }))).toMatch(/^added /)
  expect(said(await call($, SPEC, { add: [{ ...MONEY, title: 'One more than the allowance' }] }))).toContain('may add 0 more records this turn')
})

test('/spec init surveys a repository that has code, and asks nothing of an agent that may not add', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/src/a.ts`]: 'a\n', [`${TOP}/src/b.ts`]: 'b\n', [`${TOP}/package.json`]: '{}\n' })
  expect(await spec($, 'init now')).toBe('Usage: /spec init [--bare]')
  expect(await spec($, 'init')).toContain('The agent is asked to survey the code and propose a first tree.')
  await w.clock.advance(300)
  expect(w.submitted).toEqual([rooted(SURVEY, TOP)])
  expect(w.submitted[0]).toContain('Change no file of the project.\n\nThe repository root is /repo')
  expect(SURVEY).toContain('Record nothing invented or guessed')
})

test('/spec init under the read setting creates the store and submits nothing', { options: { ...OFF, specs: 'read' } }, async ($, on) => {
  const w = world(on, { [`${TOP}/src/a.ts`]: 'a\n' })
  expect(await spec($, 'init')).toContain('The specs setting is "read", so no agent is asked for a first tree.')
  await w.clock.advance(5000)
  expect(w.submitted).toEqual([])
})

test('accept, drop, export and compact: a person\'s changes are segments, and sealing leaves the tree as it was', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'x\n' })
  await call($, SPEC, { add: [{ title: 'Money', kind: 'area', refs: ['src/'] }] })
  await call($, SPEC, { add: [MONEY, { ...MONEY, title: 'Rounding is half-even' }, { ...MONEY, title: 'Gone tomorrow', refs: ['src/old.ts'] }] })
  expect(await spec($, 'stats')).toContain('stale: 1')
  const outline = await spec($, '')
  const id = /(\S+) decision!stale Gone tomorrow/.exec(outline)![1]!
  expect(await spec($, `drop ${id}`)).toMatch(/^dropped 1 record \([0-9a-f]{16}\.jsonl\):\n  \S+ decision!stale Gone tomorrow$/)
  expect(await spec($, 'accept all')).toMatch(/^accepted 3 records/)
  expect(await spec($, 'accept all')).toBe('Nothing is proposed.')
  expect(await spec($, 'accept zzzzzz')).toContain('No record matches "zzzzzz"')
  const last = dec.decode(w.files.get(`${DIR}/${w.stored('.jsonl').at(-1)}`)).trimEnd().split('\n').map(l => JSON.parse(l))
  expect(last.map(l => [l.via, l.status])).toEqual([['person', 'accepted'], ['person', 'accepted'], ['person', 'accepted']])

  const before = await spec($, ''), md = await spec($, 'export')
  expect(before).toMatch(/^3 records: 0 proposed, 1 area, 0 stale\n\S+ area Money\n \S+ decision Amounts are integer cents\n \S+ decision Rounding is half-even\n\n\/spec \| status/)
  expect(md).toMatch(/^# Specs and decisions\n\n## Money\n\n`[a-z2-7]{13}` area, accepted\n\nrefs: `src\/\*\*`\n\n- \*\*Amounts are integer cents\*\* \(`[a-z2-7]{13}` decision, accepted\)\n  Floats lost/)
  expect(await spec($, 'export out/specs.md')).toBe(`Wrote 3 records to ${TOP}/out/specs.md`)
  expect(dec.decode(w.files.get(`${TOP}/out/specs.md`))).toBe(md)

  expect(w.stored('.jsonl').length).toBe(4)
  const sealed = await spec($, 'compact')
  expect(sealed).toMatch(/^Sealed 8 changes from 4 files into 1 pack: [0-9a-f]{16}\.aesp\nThe tree reads the same as before \(3 records: 0 proposed, 1 area, 0 stale\)\.\nStaged in git: 1 new pack, 4 deleted files\. Commit it: git commit -m "Seal specs"$/)
  // the pack is staged before a segment goes, and the deletions after
  const pack = w.stored('.aesp')[0]!, order = w.ran.filter(c => /^(git add -- |rm -f|git add -A)/.test(c)).map(c => c.split(' ').slice(0, 3).join(' '))
  expect(order).toEqual(['git add --', 'rm -f --', 'git add -A'])
  expect(w.ran).toContain(`git add -- .plusplus/specs/${pack}`)
  expect(w.stored('.jsonl')).toEqual([])
  expect(w.stored('.aesp').length).toBe(1)
  expect(unpack(w.files.get(`${DIR}/${w.stored('.aesp')[0]}`)!).length).toBe(8)
  expect(await spec($, '')).toBe(before)
  expect(await spec($, 'export')).toBe(md)
  expect(await spec($, 'compact')).toBe('Nothing to seal: no loose segment, and no two small packs.')
  const stats = await spec($, 'stats')
  expect(stats).toContain('files: 0 loose segments (0.0 KiB), 1 sealed packs')
  expect(stats).toContain('stamps more than a day ahead of the clock: 0')
})

test('status, log, show and diff read the store as git reads a tree: against a commit, newest first', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'x\n' })
  expect(await spec($, 'diff')).toBe('there is no commit yet: every record is new')
  expect(await spec($, 'log')).toBe('No changes yet.')
  await call($, SPEC, { add: [MONEY, { ...MONEY, title: 'Rounding is half-even' }] })
  const [cents, rounding] = (await spec($, '')).split('\n').slice(1, 3).map(l => l.split(' ')[0]!)
  expect(await spec($, 'status')).toMatch(/^2 records: 2 proposed, 0 areas, 0 stale, on main\nnot in any commit: 1 new segment, 0 new packs, 0 deleted \(sealed or removed\)\n  commit with: git add -A \.plusplus\/specs && git commit\nrecords since the start: 2 added, 0 dropped, 0 changed\n  \+ \S+ decision!proposed Amounts are integer cents\n  \+ \S+ decision!proposed Rounding is half-even\nproposed, awaiting a person: 2 \(\/spec accept <id \.\.\.\|all>, \/spec drop <id \.\.\.>\)\n  \S+ decision!proposed Amounts are integer cents\n  \S+ decision!proposed Rounding is half-even\nset aside: none\ncompact: not due \(1 loose segment, due past 200\)$/)
  w.commit()
  expect(await spec($, 'status')).toContain('\nfiles: as HEAD has them, nothing to commit\nproposed, awaiting a person: 2')
  expect(await spec($, 'diff')).toBe('since HEAD (c0ffeec0ff): 0 added, 0 dropped, 0 changed\nno difference')

  await w.clock.advance(86_400_000)
  await spec($, `accept ${cents}`)
  await spec($, `drop ${rounding}`)
  await call($, SPEC, { add: [{ ...MONEY, title: 'Currency is ISO 4217' }] })
  expect(await spec($, 'diff')).toMatch(/^since HEAD \(c0ffeec0ff\): 1 added, 1 dropped, 1 changed\n\+ \S+ decision!proposed Currency is ISO 4217\n- \S+ decision!dropped Rounding is half-even\n~ \S+ decision Amounts are integer cents: proposed -> accepted$/)
  expect(await spec($, 'diff HEAD~1')).toContain('since HEAD~1 (c0ffeec0ff)')
  expect(await spec($, 'diff --output=x')).toBe('git knows no commit "--output=x". Usage: /spec diff [git ref]')
  expect(w.ran.some(c => c.includes('--output=x'))).toBe(false)
  // a file git was never told of is the one "git commit -a" would leave behind
  const file = w.stored('.jsonl').at(-1)!
  w.git.known.delete(`${DIR}/${file}`)
  const status = await spec($, 'status')
  expect(status).toContain('not in HEAD: 3 new segments, 0 new packs, 0 deleted (sealed or removed)\n  1 file is untracked, and "git commit -a" would leave it out: git add .plusplus/specs\nrecords since HEAD: 1 added, 1 dropped, 1 changed\n  + ')
  expect(status).toContain('proposed, awaiting a person: 1 ')

  const log = (await spec($, 'log')).split('\n')
  expect(log.length).toBe(5)
  expect(log[0]).toMatch(/^\S+ 2025-10-10 Test Person via agent claude-test-1: created decision, title "Currency is ISO 4217", why, \+src\/money\.ts$/)
  expect(log[1]).toBe(`${rounding} 2025-10-10 Test Person via person: dropped`)
  expect(log[2]).toBe(`${cents} 2025-10-10 Test Person via person: accepted`)
  expect(await spec($, 'log 2')).toBe([log[0], log[1], '… older changes: /spec log 8'].join('\n'))
  expect(await spec($, `log ${cents}`)).toBe([log[2], log[4]].join('\n'))
  expect(await spec($, 'log zzzzzz')).toBe('No record matches "zzzzzz".')
  const shown = await spec($, `show ${cents}`)
  expect(shown).toMatch(/^\S+ decision Amounts are integer cents\nwhy: Floats lost[^\n]+\nrefs: src\/money\.ts\n[a-z2-7]{13} accepted, by Test Person via agent claude-test-1, 2025-10-09\nhistory:\n /)
  expect(shown.split('\n').slice(-2)).toEqual([` ${log[2]}`, ` ${log[4]}`])
  expect(await spec($, 'show')).toBe('Usage: /spec show <id>')

  // sealed, the segments leave the folder: the commit's are read out of git, and the records are the same
  w.commit()
  expect(await spec($, 'compact')).toContain('Sealed 5 changes from 4 files into 1 pack')
  expect(await spec($, 'diff')).toBe('since HEAD (c0ffeec0ff): 0 added, 0 dropped, 0 changed\nno difference')
  expect(w.lots).toEqual([4]) // the four segments that left the folder, from one git process
  expect(await spec($, 'status')).toContain('not in HEAD: 0 new segments, 1 new pack, 4 deleted (sealed or removed)\n  commit with: git add -A .plusplus/specs && git commit\nrecords: the same as HEAD has them (the files were only sealed or copied)')
  // a file of the commit that git cannot give back is said, not passed over
  w.git.head!.set(`${DIR}/${file}`, enc.encode('torn'))
  expect(await spec($, 'diff')).toMatch(/1 added, 0 dropped, 0 changed\n\+ \S+ decision!proposed Currency is ISO 4217\n\(1 file of the store at HEAD could not be read out of git: /)
})

test('compact seals a part at a time, stages before it deletes, and deletes nothing when git will not stage', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'x\n' })
  // half of a surrogate pair in a title once made every seal of its store fail to read back
  for (const title of ['Amounts are integer cents', 'Rounding is half-even', 'A torn \ud83d title seals too', 'Currency is ISO 4217', 'Negative amounts are refunds']) await call($, SPEC, { add: [{ ...MONEY, title }] })
  const before = await spec($, 'export')
  expect(before).toContain('A torn \ufffd title seals too')
  expect(await spec($, 'compact x')).toBe('Usage: /spec compact [max files]')

  w.git.locked = true
  expect(await spec($, 'compact 2')).toMatch(/^Wrote [0-9a-f]{16}\.aesp, but git would not stage it \(fatal: Unable to create '\/repo\/\.git\/index\.lock': File exists\.\)\. Nothing was deleted: the segments are still there, and \/spec compact can be run again\.$/)
  expect(w.stored('.jsonl').length).toBe(5)
  expect(w.ran.some(c => c.startsWith('rm -f'))).toBe(false)
  w.git.locked = false

  expect(await spec($, 'compact 2')).toMatch(/^Sealed 2 changes from 2 files into 1 pack: [0-9a-f]{16}\.aesp\n3 loose segments are left: run \/spec compact again\.\nThe tree reads the same as before \(5 records: 5 proposed, 0 areas, 0 stale\)\.\nStaged in git: 1 new pack, 2 deleted files\. Commit it: git commit -m "Seal specs"$/)
  expect(w.stored('.jsonl').length).toBe(3)
  // the rest, with the small pack just made: a change that is in two files is sealed once
  expect(await spec($, 'compact')).toMatch(/^Sealed 5 changes from 4 files into 1 pack: [0-9a-f]{16}\.aesp\nThe tree reads the same as before \(5 records: 5 proposed, 0 areas, 0 stale\)\.\nStaged in git: 1 new pack, 4 deleted files\./)
  expect(w.stored('.jsonl')).toEqual([])
  expect(w.stored('.aesp').length).toBe(1)
  expect(await spec($, 'export')).toBe(before)
  expect(await spec($, 'stats')).toContain('files: 0 loose segments (0.0 KiB), 1 sealed packs')
})

test('stale is not claimed when git lists more than is read, and a file with many records shows the closest thirty', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'x\n' })
  w.git.flood = true
  for (let i = 0; i < 4; i++) await call($, SPEC, { add: Array.from({ length: 9 }, (_, k) => ({ ...MONEY, title: `Rule ${i * 9 + k} of many`, refs: [k % 2 ? 'src/money.ts' : 'src/gone.ts', 'src/money.ts#cents'] })) }), w.git.turns++
  expect(await spec($, 'stats')).toContain('\nstale: 0 (not checked: git lists more files than are read at once)\n')
  const lines = said(await call($, SPEC, { path: 'src/money.ts' })).split('\n')
  expect(lines.length).toBe(31)
  expect(lines[0]).toMatch(/^\S+ decision!proposed Rule 0 of many$/)
  expect(lines[30]).toBe('… 6 more: the first govern it most closely')
  w.git.flood = false
  await call($, SPEC, { add: [{ ...MONEY, title: 'This one is gone', refs: ['src/gone.ts'] }] })
  expect(await spec($, 'stats')).toContain('\nstale: 1\n')
})

/** A change as a line of a segment, as another writer wrote it. */
const change = (id: string, n: number, set: Record<string, unknown>) => JSON.stringify({ id, at: [1_750_000_000_000, n], writer: '0a0a0a0a0a0a', by: 'Ada', via: 'person', ...set })
const AREA = 'a2aaaaaaaaaaa', RULE = 'b3bbbbbbbbbbb'

test('a record whose parent is missing is named in /spec status, and dropping it lets agents add again', { options: OFF }, async ($, on) => {
  const w = world(on)
  await w.segment([change(RULE, 1, { kind: 'spec', under: AREA, title: 'Rounding is half-even', why: 'w', refs: ['+src/money.ts'] })])
  expect(said(await call($, SPEC, { add: [MONEY] }))).toContain('the store is incomplete: 1 parent is named but not here (a2aaaaaaaaaaa)')
  expect(await spec($, 'status')).toContain('\nparents named but not here: a2aaaaaaaaaaa, named by b3bbbb (a file of the store is missing; nothing is added until it is back: restore the file, or /spec drop the records that name them)\n')
  expect(await spec($, 'drop b3bbbb')).toMatch(/^dropped 1 record /)
  expect(await spec($, 'status')).not.toContain('parents named but not here')
  expect(await spec($, 'stats')).not.toContain('parents named but not here')
  expect(said(await call($, SPEC, { add: [MONEY] }))).toMatch(/^added \S+ decision!proposed Amounts are integer cents$/)
  expect(w.stored('.jsonl').length).toBe(3)
})

test('a ref that names a directory governs what is under it, with or without the slash', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/scan/walk.ts`]: 'x\n', [`${TOP}/src/money.ts`]: 'x\n' })
  expect(said(await call($, SPEC, { add: [{ title: 'Scanning', kind: 'area', refs: ['src/scan', './src/money.ts', 'src/scan#walk', 'src/sc*'] }, { ...MONEY, refs: 'src/scan' }] }))).toMatch(/^added /)
  const lines = dec.decode(w.files.get(`${DIR}/${w.stored('.jsonl')[0]}`)).trimEnd().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => l.refs)).toEqual([['+src/scan/**', '+src/money.ts', '+src/scan#walk', '+src/sc*'], ['+src/scan/**']])
  expect(said(await call($, SPEC, { path: 'src/scan/deep/walk.ts' })).split('\n').length).toBe(2)
  for (const text of [SURVEY, INTERVIEW, TOOL.inputSchema.properties.add.items.properties.refs.description]) expect(text).toContain('a directory ends in /')
})

test('a record under a dropped one is dropped to diff and status, and is neither accepted nor dropped by itself', { options: OFF }, async ($, on) => {
  const w = world(on)
  await call($, SPEC, { add: [{ title: 'Billing', kind: 'area', refs: ['src/billing/'], key: 'b' }, { ...MONEY, under: 'b' }] })
  const [area, rule] = (await spec($, '')).split('\n').slice(1, 3).map(l => l.trim().split(' ')[0]!)
  expect(await spec($, 'diff')).toMatch(/^there is no commit yet: every record is new\n\+ \S+ area!proposed Billing\n\+ \S+ decision!proposed Amounts are integer cents$/)
  await spec($, `drop ${area}`)
  // new and already hidden: it is not told as added
  expect(await spec($, 'diff')).toBe('there is no commit yet: every record is new')
  const n = w.stored('.jsonl').length
  expect(await spec($, `accept ${rule}`)).toBe(`${rule} is under a dropped record (${area} area!dropped Billing), so it is in no list and there is nothing to accept: /spec accept ${area} brings that record back, and this one with it. Nothing was changed.`)
  expect(await spec($, `drop ${rule}`)).toContain('there is nothing to drop')
  expect(w.stored('.jsonl').length).toBe(n)
  expect(await spec($, 'status')).toContain('\nunder a dropped record, and so in no list: 1 (')
  expect(await spec($, `accept ${area}`)).toMatch(/^accepted 1 record /)
  w.commit()
  await spec($, `drop ${area}`)
  expect(await spec($, 'diff')).toMatch(/^since HEAD \(c0ffeec0ff\): 0 added, 2 dropped, 0 changed\n- \S+ area!dropped Billing\n- \S+ decision!proposed Amounts are integer cents \(under a dropped record\)$/)
})

test('files that left the folder are read out of a commit by one git process, and by another only past what one answer holds', { options: OFF }, async ($, on) => {
  const w = world(on)
  const id = (i: number) => `c4${[...String(i).padStart(11, '0')].map(d => 'abcdefghij'[Number(d)]).join('')}`
  for (let i = 0; i < 300; i++) await w.segment([change(id(i), i, { kind: 'spec', title: `Rule ${i} holds`, why: 'w', refs: ['+src/money.ts'] })], true)
  expect(await spec($, 'diff')).toMatch(/^since HEAD \(c0ffeec0ff\): 0 added, 300 dropped, 0 changed\n- c4aaaa\S* spec!proposed Rule 0 holds \(gone\)\n/)
  expect(w.lots).toEqual([300])
  expect(w.ran.some(c => c.includes('git show'))).toBe(false)
  // two files of 1.4 MiB are more than one answer may carry
  for (const k of [1, 2]) await w.segment(Array.from({ length: 700 }, (_, i) => change(id(1000 * k), i, { ...(i ? {} : { kind: 'spec' }), title: `Big ${k} ${i}`, why: 'y'.repeat(1900) })), true)
  w.lots.length = 0
  expect(await spec($, 'status')).toContain('records since HEAD: 0 added, 302 dropped, 0 changed')
  expect(w.lots).toEqual([301, 1])
})

test('/spec init gives its allowance up and says so when the session never takes the prompt', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${TOP}/src/a.ts`]: 'a\n', [`${TOP}/src/b.ts`]: 'b\n', [`${TOP}/package.json`]: '{}\n' })
  w.git.busy = true
  expect(await spec($, 'init')).toContain('It is asked once the session is idle')
  for (let i = 0; i < 4; i++) await w.clock.advance(250)
  expect(w.toasts).toEqual([])
  await w.clock.advance(250)
  expect(w.submitted).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('Ask the agent directly')
  expect(said(await call($, SPEC, { add: Array.from({ length: 11 }, (_, i) => ({ ...MONEY, title: `Rule ${i} of the first tree` })) }))).toContain('this loop may add 10 more records this turn')
})

test('a line that is no change is skipped and counted, the rest of its segment loads, and compact leaves that file', { options: OFF }, async ($, on) => {
  const w = world(on, { [`${DIR}/store.json`]: '{"format":1}\n', [`${TOP}/src/money.ts`]: 'x\n' })
  const torn = await w.segment([change(RULE, 1, { kind: 'spec', title: 'Rounding is half-even', why: 'w', refs: ['+src/money.ts'] }), change(AREA, 2, { kind: 'epic', title: 'From a later version' }), 'not json'])
  const none = await w.segment([change(AREA, 3, { kind: 'epic', title: 'Nothing here is a change' })])
  await call($, SPEC, { add: [MONEY] })
  expect(await spec($, '')).toContain('b3bbbb spec!proposed Rounding is half-even')
  const stats = await spec($, 'stats')
  expect(stats).toContain(`set aside: 1\n  ${none}: none of its 1 line is a change\nlines skipped: in 1 segment\n  ${torn}: 2 lines skipped (they are no changes; the rest of the file is read)\n`)
  expect(await spec($, 'compact')).toContain('Not sealing while 1 file is set aside')
  w.files.delete(`${DIR}/${none}`)
  expect(await spec($, 'status')).toContain(`set aside: none\nlines skipped: in 1 segment\n  ${torn}: 2 lines skipped`)
  const before = await spec($, '')
  expect(await spec($, 'compact')).toMatch(new RegExp(`^Sealed 2 changes from 2 files into 1 pack: [0-9a-f]{16}\\.aesp\\n1 segment has skipped lines and was left in place \\(${torn}\\): the changes in it are sealed, the skipped lines are only in the file\\. /spec stats counts them\\.\\nThe tree reads the same as before \\(2 records: 2 proposed, 0 areas, 0 stale\\)\\.\\nStaged in git: 1 new pack, 1 deleted file\\.`))
  expect(w.stored('.jsonl')).toEqual([torn])
  expect(unpack(w.files.get(`${DIR}/${w.stored('.aesp')[0]}`)!).length).toBe(2)
  expect(await spec($, '')).toBe(before)
  // sealed once: the file that stays is not sealed again
  expect(await spec($, 'compact')).toBe('Nothing to seal: no loose segment, and no two small packs.')
  expect(w.stored('.aesp').length).toBe(1)
})
