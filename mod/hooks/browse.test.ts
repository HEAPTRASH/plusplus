import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { type Change, clean, idOf, toLine } from './spec'
import { specsLayout } from './panes'
import { tall, width } from './ui'

const TOP = '/repo', DIR = `${TOP}/.plusplus/specs`
const OFF = { codegraph: 'off', router: 'off' }
const enc = new TextEncoder(), dec = new TextDecoder()
const pane = (bodyColumns: number, bodyRows: number) => ({
  plugin: 'plusplus', component: 'Pane', requestId: 'spec-browse',
  props: { title: 'plusplus: specs', isFocused: true, bodyColumns, placement: 'inline', scroll: { offset: 0, bodyRows }, view: {} },
}) as const

/** The engine beneath the browser: the store's folder in memory, the few commands the tracker runs, a clock the test moves. */
function world(on: On) {
  const files = new Map<string, Uint8Array>([[`${DIR}/store.json`, enc.encode('{"format":1}\n')]])
  /** `unlisted`: the store's folder cannot be listed; `lists` and `opened` count the asks. */
  const w = { files, clock: mock.clock(on, { now: 1_760_000_000_000 }), closed: [] as string[], sets: 0, unlisted: false, lists: 0, opened: 0 }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.env(on, {})
  on('state.set', { plugin: 'plusplus', key: 'specs' }, (_$, e, next) => (w.sets++, next(e)))
  on('ui.open', () => (w.opened++, { value: { isPlaced: true } }) as never)
  on('ui.close', (_$, e) => (w.closed.push(e.id), { value: undefined }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: TOP }))
  on('session.root', () => ({ value: TOP }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.list', (_$, e) => w.lists++ >= 0 && w.unlisted ? Promise.reject(new Error('EACCES: the folder cannot be listed')) : ({ value: [...files].filter(([p]) => p.startsWith(`${e.path}/`)).map(([p, b]) => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: b.length, mtimeMs: 1 })) }) as never)
  on('fs.read', (_$, e) => {
    const b = files.get(e.path)!
    let bin = ''
    for (let i = 0; i < b.length; i += 0x6000) bin += String.fromCharCode(...b.subarray(i, i + 0x6000))
    return { value: e.as === 'bytes' ? { base64: btoa(bin) } : dec.decode(b) }
  })
  on('fs.write', (_$, e) => (files.set(e.path, enc.encode(e.text)), { value: undefined }))
  on('process.run', (_$, e) => {
    const a = e.argv, cmd = a.slice(0, 2).join(' ')
    if (cmd === 'git rev-parse') return ok(`${TOP}\n\n`)
    if (cmd === 'git config') return ok('Test Person\n')
    if (cmd === 'git ls-files') return ok('src/money.ts')
    if (cmd === 'mv -f') return files.set(a[3]!, files.get(a[2]!)!), files.delete(a[2]!), ok()
    return ok()
  })
  /** A loose segment as another writer left it: these changes, under the name their bytes hash to. */
  const segment = async (changes: readonly Partial<Change>[]) => {
    const bytes = enc.encode(changes.map(c => toLine(clean({ writer: 'aaaaaaaaaaaa', by: 'Ada', via: 'agent claude-test-1', ...c })!)).join('\n') + '\n')
    const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
    files.set(`${DIR}/${Array.from(sum.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('')}.jsonl`, bytes)
  }
  /** The changes the store holds that a person made: what accept and drop wrote. */
  const personal = () => [...files].filter(([p]) => p.endsWith('.jsonl')).flatMap(([, b]) => dec.decode(b).split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)).filter(c => JSON.stringify(c).includes('person'))
  return Object.assign(w, { segment, personal })
}

/** A record id from a number: 13 characters, as the store names records. */
const id = (n: number) => idOf(Uint8Array.of(n * 37, n >> 3, n >> 8, n >> 11, n >> 16, 0x13, 0x37, 0x99))
const spec = async ($: Engine, args: string) => (await $.command.run({ command: 'spec', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)).text ?? ''
type Ui = { findAll: (q: { type?: string; key?: string }) => Promise<{ type: string; key: string | undefined; text: string; props: Record<string, unknown> }[]> }
/** Fails, with every text the pane draws, unless one of them is (or matches) `text`. */
async function shows(ui: Ui, text: string | RegExp) {
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  if (!all.some(t => (typeof text === 'string' ? t.includes(text) : text.test(t)))) throw new Error(`no text ${text} among:\n${all.join('\n')}`)
}
const rows = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('row:')).map(b => b.text)

const BILLING = id(1), CENTS = id(2), ROUND = id(3), AUTH = id(4), TOKENS = id(5)
const SMALL: Partial<Change>[] = [
  { id: BILLING, at: { ms: 1000, n: 0 }, kind: 'area', under: '', title: 'Billing', status: 'accepted', refs: ['+src/billing/**'] },
  { id: CENTS, at: { ms: 2000, n: 0 }, kind: 'decision', under: BILLING, title: 'Amounts are integer cents', why: 'Floats lost a cent on refunds; decimals were turned down as slower.', refs: ['+src/money.ts'] },
  { id: ROUND, at: { ms: 3000, n: 0 }, kind: 'spec', under: BILLING, title: 'Rounding is half-even', status: 'accepted', refs: ['+src/money.ts#round'] },
  { id: AUTH, at: { ms: 4000, n: 0 }, kind: 'area', under: '', title: 'Auth', status: 'accepted' },
  { id: TOKENS, at: { ms: 5000, n: 0 }, kind: 'spec', under: AUTH, title: 'Tokens expire after an hour', why: 'A stolen token must not outlive a shift.', refs: ['+src/auth/token.ts'] },
]

test('the spec browser: the tree folds and unfolds, the selection shows its why, refs and history, the filter finds, and a person accepts and drops', { options: OFF }, async ($, on) => {
  const w = world(on)
  await w.segment(SMALL)
  expect(await spec($, 'browse')).toBe('Spec browser opened.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(120, 30), surface })
    // closed at first: the two areas, the first selected, each saying how many it holds
    expect(await rows(ui)).toEqual([expect.stringMatching(/^❯ ▸ ■ ✓ Billing \+2 \w{6,13}$/), expect.stringMatching(/^  ▸ ■ ✓ Auth \+1 \w{6,13}$/)])
    await shows(ui, /5 records, 2 proposed/)
    await ui.press({ key: 'unfold' })
    expect((await rows(ui)).map(r => r.replace(/ \w{6,13}$/, ''))).toEqual(['❯ ▾ ■ ✓ Billing', '      ◇ ○ Amounts are integer cents', '      § ✓ Rounding is half-even', '  ▸ ■ ✓ Auth +1'])
    // open again steps into it; the record's why, refs and history are beside the list
    await ui.press({ key: 'unfold' })
    expect((await rows(ui))[1]).toMatch(/^❯     ◇ ○ Amounts are integer cents/)
    await shows(ui, 'Floats lost a cent on refunds; decimals were turned')
    await shows(ui, 'refs src/money.ts')
    await shows(ui, /^↑ 1970-01-01 created decision under \w+, title /)
    await shows(ui, '1970-01-01 · Ada via agent claude-test-1')
    await shows(ui, /^◇ decision · \w+ · under Billing$/)
    await ui.press({ key: 'down' })
    await ui.press({ key: 'down' })
    expect((await rows(ui))[3]).toMatch(/^❯ ▸ ■ ✓ Auth/)
    await ui.press({ key: 'up' })
    // close on a leaf steps out to its parent; close on the parent folds it
    await ui.press({ key: 'fold' })
    expect((await rows(ui))[0]).toMatch(/^❯ ▾ ■ ✓ Billing/)
    await ui.press({ key: 'fold' })
    expect(await rows(ui)).toHaveLength(2)
    // a press on a row selects it, a second one unfolds it
    await ui.press({ key: `row:${AUTH}` })
    await ui.press({ key: `row:${AUTH}` })
    expect((await rows(ui)).map(r => r.replace(/ \w{6,13}$/, ''))).toEqual(['  ▸ ■ ✓ Billing +2', '❯ ▾ ■ ✓ Auth', '      § ! Tokens expire after an hour']) // its ref covers no file git lists: stale
    await ui.press({ key: `row:${AUTH}` })

    // the filter: every word, anywhere in the record, as it is typed; the list is flat while it stands
    await ui.input({ key: 'filter', text: 'cents float', kind: 'change' })
    expect(await rows(ui)).toEqual([expect.stringMatching(/^❯ ◇ ○ Amounts are integer cents \w{6,13}$/)])
    await shows(ui, '"cents float" · 1 match')
    expect(await ui.find({ key: 'unfold' })).toBeUndefined()
    await ui.input({ key: 'filter', text: 'proposed', kind: 'change' })
    expect(await rows(ui)).toHaveLength(2)
    await ui.input({ key: 'filter', text: 'nothing has this', kind: 'change' })
    await shows(ui, 'No record matches.')
    await ui.input({ key: 'filter', text: 'cents' })
    // cleared, the record found stays selected and everything above it is unfolded
    await ui.press({ key: 'filter-clear' })
    expect((await rows(ui)).map(r => r.replace(/ \w{6,13}$/, ''))).toEqual(['  ▾ ■ ✓ Billing', '❯     ◇ ○ Amounts are integer cents', '      § ✓ Rounding is half-even', '  ▸ ■ ✓ Auth +1'])
    expect((await ui.find({ type: 'Input', key: 'filter' }))?.props.value).toBe('')
    await ui.press({ key: 'filter-edit' }) // asks the engine to put the focus in the field: the kit moves no ring, so only the press is shown here

    // accept: a person's change in the store, the tick marked for a moment, and then nothing moves
    const sets = w.sets
    await ui.press({ key: 'accept' })
    expect(w.personal().at(-1)).toMatchObject({ id: CENTS, status: 'accepted', via: 'person', by: 'Test Person' })
    expect((await rows(ui))[1]).toMatch(/^❯     ◇ ✓ Amounts are integer cents/)
    await shows(ui, /^✓ accepted \w{6,13} Amounts are integer cents$/)
    expect((await ui.findAll({ type: 'Text' })).filter(t => t.props.inverse === true).map(t => t.text)).toEqual(['✓', '✓ accepted']) // in its row, and beside it
    expect(await ui.find({ key: 'accept' })).toBeUndefined() // accepted: only drop is left to do
    await w.clock.advance(2000)
    expect((await ui.findAll({ type: 'Text' })).filter(t => t.props.inverse === true)).toHaveLength(0)
    const idle = w.sets
    expect(idle).toBeGreaterThan(sets)
    await w.clock.advance(5000)
    expect(w.sets).toBe(idle)
    // drop takes its key twice: the first press asks, and a move takes the question back
    const kept = w.personal().length
    await ui.press({ key: 'drop' })
    await shows(ui, /^! drop \w{6,13} Amounts are integer cents\? d again drops it; any other key keeps it$/)
    await ui.press({ key: 'down' })
    await ui.press({ key: 'up' })
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text.includes('d again drops it'))).toBe(false)
    await ui.press({ key: 'drop' })
    expect(w.personal().length).toBe(kept)
    // the second press drops: the record leaves the list and the selection takes the row where it was
    await ui.press({ key: 'drop' })
    expect(w.personal().at(-1)).toMatchObject({ id: CENTS, status: 'dropped', via: 'person' })
    expect((await rows(ui)).map(r => r.replace(/ \w{6,13}$/, ''))).toEqual(['  ▾ ■ ✓ Billing', '❯     § ✓ Rounding is half-even', '  ▸ ■ ✓ Auth +1'])
    await shows(ui, /^✗ dropped \w{6,13} Amounts are integer cents$/)
    // closed while the mark is still up: the timer goes with the pane
    const moving = w.sets
    await ui.press({ key: 'close' })
    expect(w.closed.at(-1)).toBe('spec-browse')
    await w.clock.advance(3000)
    expect(w.sets).toBe(moving)
    // put back for the next surface: accepted again, folded, on the first row
    await spec($, `accept ${CENTS}`)
    await spec($, `accept ${CENTS}`)
    await ui.press({ key: `row:${BILLING}` })
    await ui.press({ key: 'fold' })
    await ui.unmount()
    w.files.forEach((_b, p) => p.endsWith('.jsonl') && w.files.delete(p))
    await w.segment(SMALL)
    await spec($, '')
  }
})

test('the spec browser at 60 columns puts the record beneath the list and nothing is wider than the pane; a phone has no filter field', { options: OFF }, async ($, on) => {
  const w = world(on)
  await w.segment([...SMALL, { id: id(9), at: { ms: 9000, n: 0 }, kind: 'decision', under: '', title: 'A title that goes on for a good deal longer than sixty columns of any terminal could ever hold on one line', why: 'x '.repeat(400), refs: ['+src/a/very/long/path/that/goes/on/and/on/for/a/long/while/until/it/is/far/too/wide.ts'] }])
  await spec($, 'browse')
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane(60, 30), surface })
    await ui.press({ key: `row:${id(9)}` })
    for (const t of [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]) expect(width(t.text)).toBeLessThanOrEqual(60)
    await shows(ui, 'Record ') // the rule the record sits under, beneath the list
    expect(Boolean(await ui.find({ type: 'Input' }))).toBe(surface !== 'mobile')
    expect(Boolean(await ui.find({ type: 'Text', text: 'Filter from a terminal or the desktop app.' }))).toBe(surface === 'mobile')
    expect(Boolean(await ui.find({ key: 'filter-edit' }))).toBe(surface !== 'mobile')
    await ui.press({ key: 'up' })
    expect((await rows(ui)).find(r => r.startsWith('❯'))).toMatch(/Auth/)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
})

test('the spec browser is never taller than its room: the rows it lists make way for the legend and the keys as they wrap, and a short pane gives up the legend, then the record\'s detail', { options: OFF }, async ($, on) => {
  const w = world(on)
  const many: Partial<Change>[] = Array.from({ length: 60 }, (_x, i) => ({ id: id(100 + i), at: { ms: 10_000 + i, n: 0 }, kind: 'decision' as const, under: '', title: `Decision ${i} with a title long enough to be cut at any width a pane is given here`, why: 'because '.repeat(120), refs: [`+src/a/long/path/to/a/file/number/${i}/that/goes/on/and/on/for/a/while.ts`, '+src/b.ts', '+src/c.ts'] }))
  await w.segment([...SMALL, ...many])
  // each with five changes behind it, so the history is as long as it gets
  for (let k = 1; k < 5; k++) await w.segment(many.map((c, i) => ({ id: c.id!, at: { ms: 20_000 * k + i, n: 0 }, title: `${c.title} ${k}` })))
  await spec($, 'browse')
  for (const [columns, bodyRows] of [[60, 30], [60, 24], [60, 20], [60, 16], [60, 13], [40, 22], [72, 30], [73, 30], [99, 26], [100, 30], [100, 18], [110, 30], [110, 12], [140, 40], [140, 10]] as const) {
    const ui = await $.ui.mount({ ...pane(columns, bodyRows), surface: 'terminal' })
    const at = specsLayout(columns, bodyRows), fits = async (what: string) => expect(`${columns}x${bodyRows} ${what}: ${Math.min(tall(await ui.drawn(), columns), bodyRows + 1)} rows`).not.toBe(`${columns}x${bodyRows} ${what}: ${bodyRows + 1} rows`)
    for (let i = 0; i < 16; i++) await ui.press({ key: 'page-up' }) // from wherever the last pane left the selection
    await ui.press({ key: `row:${id(100)}` })
    for (let i = 0; i < 3; i++) await ui.press({ key: 'page-down' })
    expect((await rows(ui)).length).toBe(at.rows) // the window is full
    await fits('a full window, a long record')
    // with the line beneath the keys in use, and the filter's own count beside the field
    await ui.press({ key: 'accept' })
    await fits('after an accept')
    await ui.press({ key: 'drop' })
    await fits('asked about a drop')
    await ui.input({ key: 'filter', text: 'decision', kind: 'change' })
    await fits('filtered')
    await ui.press({ key: 'filter-clear' })
    // every key is still drawn, however short the pane
    expect((await ui.findAll({ type: 'Button' })).filter(b => !b.key?.startsWith('row:')).map(b => b.props.hotkey).join('')).toBe('jknplhfadq')
    expect(Boolean(await ui.find({ type: 'Text', text: /^. superseded$/ }))).toBe(at.legend)
    await spec($, `accept ${id(100)}`)
    await ui.press({ key: 'close' })
    await ui.unmount()
    await w.clock.advance(3000)
  }
  // the budget itself: at 60 columns the legend and the keys take two rows each, which the list gives up
  expect(specsLayout(60, 30)).toMatchObject({ wide: false, rows: 10, detail: 10, legend: true })
  expect(specsLayout(73, 30)).toMatchObject({ rows: 11, legend: true })
  expect(specsLayout(60, 16)).toMatchObject({ rows: 5, detail: 4, legend: false })
  expect(specsLayout(120, 30)).toMatchObject({ wide: true, rows: 24, detail: 24, legend: true })
  expect(specsLayout(100, 30)).toMatchObject({ wide: true, rows: 23 }) // the keys wrap under 111 columns
})

test('a store folder that cannot be listed is said once and drawn at rest: no read and no redraw follows a look', { options: OFF }, async ($, on) => {
  const w = world(on)
  await w.segment(SMALL)
  let invalidates = 0
  on('ui.invalidate', (_$, e, next) => (invalidates++, next(e)))
  w.unlisted = true
  expect(await spec($, 'browse')).toBe('Spec browser opened.')
  const ui = await $.ui.mount({ ...pane(100, 30), surface: 'terminal' })
  await w.clock.advance(1000)
  await shows(ui, 'could not read .plusplus/specs: close, and /spec browse tries again')
  expect((await ui.find({ type: 'Text', text: '✗' }))?.props.color).toBe('error')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('reading the store'))).toBe(false)
  const settled = [w.lists, invalidates, w.sets]
  for (let i = 0; i < 5; i++) {
    await ui.findAll({ type: 'Text' })
    await ui.redraw()
    await w.clock.advance(1000)
  }
  expect([w.lists, invalidates, w.sets]).toEqual(settled)
  expect(w.lists).toBeGreaterThan(0)
  // closed and opened again, the folder is read again; once it can be listed the tree is there
  await ui.press({ key: 'close' })
  await ui.unmount()
  w.unlisted = false
  await spec($, 'browse')
  const again = await $.ui.mount({ ...pane(100, 30), surface: 'terminal' })
  expect(await rows(again)).toHaveLength(2)
  await again.press({ key: 'close' })
  await again.unmount()
})

test('where nothing draws a pane (a -p run), /spec browse answers with the outline instead of "opened"', { options: OFF }, async ($, on) => {
  const w = world(on)
  await w.segment(SMALL)
  on('session.surfaces', () => ({ value: [] }))
  const text = await spec($, 'browse')
  expect(text).toMatch(/^Nothing draws a pane in this run\.\n5 records: 2 proposed, 2 areas, \d stale\n/)
  expect(text).toContain('Amounts are integer cents')
  expect(w.opened).toBe(0)
})

test('a store of 20,000 records: the browser draws its window and nothing else, and every key is answered at once', { options: OFF, timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  // 100 areas of 199 records each, in four segments
  for (let s = 0; s < 4; s++) {
    const changes: Partial<Change>[] = []
    for (let a = s * 25; a < s * 25 + 25; a++) {
      changes.push({ id: id(a * 200), at: { ms: 1000 + a, n: 0 }, kind: 'area', under: '', title: `Area ${a}`, status: 'accepted' })
      for (let k = 1; k < 200; k++) changes.push({ id: id(a * 200 + k), at: { ms: 100_000 + a * 200 + k, n: 0 }, kind: k % 2 ? 'spec' : 'decision', under: id(a * 200), title: `Record ${a}.${k} holds a rule about part ${k}`, why: `Because part ${k} of area ${a} was once broken by a change nobody could explain afterwards.`, refs: [`+src/area${a}/part${k}.ts`] })
    }
    await w.segment(changes)
  }
  expect(await spec($, 'browse')).toBe('Spec browser opened.')
  const ui = await $.ui.mount({ ...pane(120, 30), surface: 'terminal' })
  await shows(ui, /20k records, 20k proposed/)
  const took: Record<string, number> = {}
  const timed = async (what: string, act: () => Promise<unknown>) => {
    const t0 = performance.now()
    await act()
    took[what] = Math.max(took[what] ?? 0, performance.now() - t0)
  }
  // folded, the list is the 100 areas; from the last one up each is unfolded, until all 20,000 rows are in the list
  for (let i = 0; i < 5; i++) await timed('page', () => ui.press({ key: 'page-down' }))
  expect((await rows(ui)).at(-1)).toMatch(/^❯ ▸ ■ ✓ Area 99 \+199/)
  for (let a = 99; a >= 0; a--) {
    await timed('unfold', () => ui.press({ key: 'unfold' }))
    await timed('up', () => ui.press({ key: 'up' }))
  }
  await shows(ui, /of 20000$/)
  for (let i = 0; i < 40; i++) await timed('down', () => ui.press({ key: 'down' }))
  for (let i = 0; i < 40; i++) await timed('page', () => ui.press({ key: 'page-down' }))
  await timed('select', () => ui.press({ key: `row:${id(4 * 200 + 195)}` }))
  expect((await rows(ui)).find(r => r.startsWith('❯'))).toMatch(/Record 4\.195 holds/)
  await timed('fold', () => ui.press({ key: 'fold' }))
  expect((await rows(ui)).find(r => r.startsWith('❯'))).toMatch(/▾ ■ ✓ Area 4 /)
  expect((await rows(ui)).length).toBe(24) // 30 rows less the header, the filter, the legend under its blank row, one row of keys and the line beneath
  expect((await ui.findAll({})).length).toBeLessThan(400)
  await timed('filter', () => ui.input({ key: 'filter', text: 'part 77 area 12', kind: 'change' }))
  await shows(ui, /· \d+ matches$/)
  await timed('clear', () => ui.press({ key: 'filter-clear' }))
  await timed('accept', () => ui.press({ key: 'accept' }))
  for (const [what, ms] of Object.entries(took)) expect(`${what} ${ms < 150 ? 'under 150 ms' : `${Math.round(ms)} ms`}`).toBe(`${what} under 150 ms`)
  await ui.press({ key: 'close' })
  await ui.unmount()
})
