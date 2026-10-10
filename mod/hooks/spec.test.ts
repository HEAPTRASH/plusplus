import { expect, test } from 'claude-code/testing'
import { pack, unpack } from './pack'
import {
  type Add, type Change, type Sound, type Tree, LIMITS, SLICE, ahead, bytesOf, children, clean, compose, counts, covers, day, detail, diff, empty, feed, fold, fresh,
  fromLine, get, governing, hidden, hiddenUnder, home, idOf, line, log, loose, mint, missing, order, orphans, outline, proposed, record, refuse, refuseAll, resolve, search, short, show, stale,
  stales, tick, toLine, walk,
} from './spec'

const imul = Math.imul, U8 = Uint8Array, DAY = 86_400_000

/** A seeded generator, so a failure is the same failure on every run. */
const dice = (a: number) => (n: number) => {
  a = (a + 0x6d2b79f5) | 0
  let x = imul(a ^ (a >>> 15), a | 1)
  x ^= x + imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) % n
}

const WRITERS = ['0a0a0a0a0a0a', '1b1b1b1b1b1b', '2c2c2c2c2c2c'] as const
/** Forty ids spread over the id space. */
const IDS = Array.from({ length: 40 }, (_, i) => {
  const rnd = dice(i * 7919 + 1)
  return idOf(U8.from({ length: 8 }, () => rnd(256)))
})
const [A, B, C, D, E, F, G, H] = IDS as [string, string, string, string, string, string, string, string]

/** A change as a test writes it: the stamp as [ms, n], then what it sets. */
const ch = (id: string, at: [number, number], set: Partial<Change>, writer: string = WRITERS[0]): Sound => {
  const c = clean({ id, at: { ms: at[0], n: at[1] }, writer, by: 'ada', via: 'person', ...set })
  if (!c) throw new Error(`the test wrote a change clean() discards: ${JSON.stringify(set)}`)
  return c
}
const tree = (...changes: Sound[]) => fold(empty(), changes)
const shuffled = <T>(xs: readonly T[], rnd: (n: number) => number) => {
  const out = xs.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** A change no honest writer would make but any file may hold: ids, parents and stamps drawn from small pools so they collide. */
function wild(rnd: (n: number) => number, pool = 10): Sound {
  const set: Partial<Change> = {}, id = IDS[rnd(pool)]!
  if (rnd(3) === 0) set.kind = (['area', 'spec', 'decision'] as const)[rnd(3)]!, set.under = rnd(3) === 0 ? '' : IDS[rnd(pool + 1)]! // one parent is never created
  if (rnd(3) === 0) set.title = ['Money is cents', 'money is  cents!', '+3 odd', '!bang', ''][rnd(5)]!
  if (rnd(4) === 0) set.why = ['because', 'so that\nit holds', ''][rnd(3)]!
  if (rnd(3) === 0) set.status = (['proposed', 'accepted', 'superseded', 'dropped'] as const)[rnd(4)]!, set.replacedBy = rnd(2) ? IDS[rnd(pool)]! : ''
  if (rnd(3) === 0) set.refs = Array.from({ length: 1 + rnd(3) }, () => '+-'[rnd(2)]! + ['src/a.ts', 'src/b/**', 'src/a.ts#f', 'docs/*.md'][rnd(4)]!)
  if (!Object.keys(set).length) set.title = 't'
  return ch(id, [1 + rnd(6), rnd(3)], set, WRITERS[rnd(3)])
}

const PATHS = ['src/a.ts', 'src/b/c/d.ts', 'docs/x.md', 'docs/deep/x.md', 'README.md'], EXISTING = PATHS.slice(1)

/** The rules of the fold written the slow, obvious way: sort every change, replay them in order, then hang the tree. */
function replay(changes: readonly Sound[]) {
  type R = { made?: Change; last?: Change; statusBy?: Change; title: string; why: string; status: string; replacedBy: string; refs: Set<string> }
  const recs = new Map<string, R>()
  for (const c of [...new Map(changes.map(c => [toLine(c), c])).values()].sort(order)) {
    const r = recs.get(c.id) ?? { title: '', why: '', status: 'proposed', replacedBy: '', refs: new Set<string>() }
    recs.set(c.id, r)
    if (c.kind) r.made ??= c
    if (c.title !== undefined) r.title = c.title
    if (c.why !== undefined) r.why = c.why
    if (c.status) r.status = c.status, r.replacedBy = c.replacedBy ?? '', r.statusBy = c
    for (const ref of c.refs ?? []) ref[0] === '+' ? r.refs.add(ref.slice(1)) : r.refs.delete(ref.slice(1))
    r.last = c
  }
  for (const r of recs.values()) if (r.status === 'dropped' && r.statusBy !== r.last) r.status = 'proposed'
  const parent = (r: R) => {
    const p = recs.get(r.made!.under!)
    return p?.made && order(p.made, r.made!) < 0 ? p : undefined
  }
  const listed = (r: R): boolean => r.status !== 'dropped' && (!parent(r) || listed(parent(r)!))
  const depth = (r: R): number => (parent(r) ? depth(parent(r)!) + 1 : 0)
  const made = [...recs].filter(([, r]) => r.made).sort(([a], [b]) => (a < b ? -1 : 1))
  const live = (r: R) => listed(r) && r.status !== 'superseded', covered = (r: R, paths: readonly string[]) => [...r.refs].some(ref => paths.some(p => covers(ref, p)))
  return {
    recs: made.map(([id, r]) => ({
      id, kind: r.made!.kind, under: r.made!.under, title: r.title, why: r.why, status: r.status, replacedBy: r.replacedBy, refs: [...r.refs].sort(),
      by: r.made!.by, via: r.made!.via, at: r.made!.at, live: live(r), stale: live(r) && r.made!.kind !== 'area' && !covered(r, EXISTING),
    })),
    governed: PATHS.map(p => made.filter(([, r]) => live(r) && covered(r, [p])).map(([id]) => id)),
    depths: new Map(made.filter(([, r]) => listed(r)).map(([id, r]) => [id, depth(r)])),
    missing: [...new Set(made.filter(([, r]) => r.made!.under !== '' && !parent(r) && r.status !== 'dropped').map(([, r]) => r.made!.under!))].sort(),
    loose: [...recs].filter(([, r]) => !r.made).map(([id]) => id).sort(),
  }
}

/** Everything a tree answers, as one text: two trees are the same tree when these are equal. Marks what is stale when only EXISTING exists. */
const dump = (t: Tree) =>
  JSON.stringify([
    t.clock, missing(t), loose(t), stale(t, EXISTING), counts(t), [...t.nodes.keys()].sort().map(id => [get(t, id), line(t, id), short(t, id)]),
    outline(t, { depth: 99, limit: 1e9 }), PATHS.map(p => governing(t, p).map(r => r.id)), search(t, /cents|src\/b/),
  ])

test('changes have one total order, and a clock ticks past everything it has read', async () => {
  const lt = (a: Sound, b: Sound) => order(a, b) < 0 && order(b, a) > 0
  expect(lt(ch(A, [5, 9], { title: 'z' }, WRITERS[2]), ch(A, [6, 0], { title: 'a' }))).toBe(true) // wall time first
  expect(lt(ch(A, [5, 1], { title: 'z' }, WRITERS[2]), ch(A, [5, 2], { title: 'a' }))).toBe(true) // then the counter
  expect(lt(ch(B, [5, 1], { title: 'z' }, WRITERS[0]), ch(A, [5, 1], { title: 'a' }, WRITERS[1]))).toBe(true) // then the writer
  expect(lt(ch(A, [5, 1], { title: 'a' }), ch(A, [5, 1], { title: 'b' }))).toBe(true) // then the text of the change
  expect(order(ch(A, [5, 1], { title: 'a' }), ch(A, [5, 1], { title: 'a' }))).toBe(0) // two copies of one change
  // one stamp, one writer, one id: any field that differs still tells two changes apart, the same way from both sides
  const base = { kind: 'spec', under: B, title: 't', why: 'w', status: 'superseded', replacedBy: C, refs: ['+a', '-b'] } as const
  for (const other of [{ kind: 'area' }, { under: C }, { title: 'u' }, { why: 'x' }, { status: 'accepted' }, { replacedBy: D }, { refs: ['+a', '+b'] }, { refs: ['+a'] }, { refs: ['-b', '+a'] }, { by: 'bob' }, { via: 'agent' }] as Partial<Change>[]) {
    const a = ch(A, [5, 1], base), b = clean({ ...a, ...other })!
    expect([other, order(a, b) !== 0, Math.sign(order(a, b)) === -Math.sign(order(b, a))]).toEqual([other, true, true])
  }
  // any shuffle of a set sorts to one sequence, and 0 means the same line
  const rnd = dice(11), set = Array.from({ length: 300 }, () => wild(rnd)), want = set.slice().sort(order).map(toLine).join('\n')
  for (let round = 0; round < 5; round++) expect(shuffled(set, rnd).sort(order).map(toLine).join('\n')).toBe(want)
  for (let i = 0; i < 2000; i++) {
    const a = set[rnd(300)]!, b = set[rnd(300)]!
    expect(Math.sign(order(a, b))).toBe(-Math.sign(order(b, a)) + 0)
    expect(order(a, b) === 0).toBe(toLine(a) === toLine(b))
  }
  expect(tick({ ms: 0, n: 0 }, 1000)).toEqual({ ms: 1000, n: 0 })
  expect(tick({ ms: 999, n: 7 }, 1000)).toEqual({ ms: 1000, n: 0 }) // the counter restarts when the wall moves
  expect(tick({ ms: 1000, n: 4 }, 1000)).toEqual({ ms: 1000, n: 5 })
  expect(tick({ ms: 2000, n: 4 }, 1000)).toEqual({ ms: 2000, n: 5 }) // a clock ahead of the wall still moves on
  // the clock is the greatest stamp folded, loose changes included, so the next change sorts after all of them
  const t = tree(ch(A, [7, 3], { kind: 'area' }), ch(B, [9, 1], { title: 'no creation yet' }), ch(A, [9, 0], { title: 't' }))
  expect(t.clock).toEqual({ ms: 9, n: 1 })
  const next = ch(C, [tick(t.clock, 8).ms, tick(t.clock, 8).n], { kind: 'area' })
  expect([...t.nodes.values()].every(n => order(n.last, next) < 0)).toBe(true)
  // a stamp over a day ahead is reported and still honoured
  expect([ahead({ ms: 5000 + DAY, n: 0 }, 5000), ahead({ ms: 5001 + DAY, n: 0 }, 5000)]).toEqual([false, true])
  fold(t, [ch(A, [5001 + DAY, 0], { title: 'from the future' })])
  expect(get(t, A)!.title).toBe('from the future')
  expect(ahead(t.clock, 5000)).toBe(true)
})

test('clean discards a change that breaks a limit it cannot repair, and repairs the rest', async () => {
  const ok = { id: A, at: { ms: 1, n: 0 }, writer: WRITERS[0], by: 'ada', via: 'person', title: 't' }
  expect(clean(ok)).toEqual(ok)
  // what comes out shares nothing with what went in
  const mine = { ...ok, at: { ms: 1, n: 0 }, refs: ['+a'] }, kept = clean(mine)!
  mine.at.ms = 9, mine.refs.push('+b')
  expect(kept).toEqual({ ...ok, refs: ['+a'] })
  // the id is what bytesOf accepts, and nothing else
  const rnd = dice(3)
  for (let i = 0; i < 500; i++) {
    const id = Array.from({ length: 12 + rnd(3) }, () => 'abpqz2789A-'[rnd(11)]!).join('')
    expect(clean({ ...ok, id }) !== undefined).toBe(bytesOf(id) !== undefined)
  }
  for (const bad of [
    { id: 'abc' }, { id: 7 }, { id: A.toUpperCase() }, { writer: 'xyzxyzxyzxyz' }, { writer: '0a0a0a' }, { writer: '0A0A0A0A0A0A' }, { writer: undefined },
    { at: { ms: -1, n: 0 } }, { at: { ms: 1, n: -1 } }, { at: { ms: Infinity, n: 0 } }, { at: { ms: NaN, n: 0 } }, { at: { ms: 1.5, n: 0 } },
    { at: { ms: 2 ** 60, n: 0 } }, { at: { ms: '1', n: 0 } }, { at: null }, { at: [1, 0] }, { at: undefined },
    { kind: 'epic' }, { kind: null }, { kind: 'area', under: 'nowhere' }, { kind: 'area', under: 5 }, { status: 'done' }, { status: 'superseded', replacedBy: 'x' },
    { title: 5 }, { title: null }, { why: {} }, { refs: '+a' }, { by: undefined }, { via: 7 }, { title: undefined }, // sets nothing
  ]) expect(clean({ ...ok, ...bad })).toBeUndefined()
  for (const junk of [undefined, null, 5, 'x', [], [ok], () => ok]) expect(clean(junk)).toBeUndefined()
  // a title is one line without § or control characters, cut to length; so are by and via
  const c = clean({ ...ok, title: `  a\r\nb\tc\u2028d §12§ e\u0000\u202e${'x'.repeat(300)}`, by: `ada\nlovelace${'!'.repeat(100)}`, via: 'per§son\u0007' })!
  expect(c.title).toBe(`a b c d 12 e${'x'.repeat(LIMITS.title - 12)}`)
  expect([c.by.length, c.by.startsWith('ada lovelace!'), c.via]).toEqual([LIMITS.name, true, 'person'])
  expect(clean({ ...ok, title: `${'x'.repeat(LIMITS.title - 1)}\u{1f600}` })!.title).toBe('x'.repeat(LIMITS.title - 1)) // never half of a pair
  // a why keeps tabs and newlines and loses the rest
  expect(clean({ ...ok, why: 'a\r\n\tb\u0000\u2029§' })!.why).toBe('a\n\tb§')
  expect(clean({ ...ok, why: 'y'.repeat(5000) })!.why!.length).toBe(LIMITS.why)
  // refs: signed, at most 300 characters, no control characters, one say per reference, 32 in all
  expect(clean({ ...ok, refs: ['+a', 'b', '+', 7, `+${'p'.repeat(300)}`, `+${'p'.repeat(301)}`, '+c\nd', '-a', '+e\u0000'] })!.refs).toEqual(['-a', `+${'p'.repeat(300)}`])
  expect(clean({ ...ok, refs: Array.from({ length: 50 }, (_, i) => `+f${i}`).concat('-f0', '-late') })!.refs!.length).toBe(LIMITS.refs)
  expect(clean({ ...ok, refs: Array.from({ length: 50 }, (_, i) => `+f${i}`).concat('-f0', '-late') })!.refs![0]).toBe('-f0')
  expect(clean({ ...ok, title: undefined, refs: ['nope'] })).toBeUndefined() // nothing left to set
  // fields that mean nothing where they stand are dropped; a creation without a parent is at the root
  expect(clean({ ...ok, under: B, replacedBy: B, extra: 1 })).toEqual(ok)
  expect(clean({ ...ok, kind: 'spec' })).toEqual({ ...ok, kind: 'spec', under: '' })
  expect(clean({ ...ok, status: 'accepted', replacedBy: B })).toEqual({ ...ok, status: 'accepted' })
  expect(clean({ ...ok, status: 'superseded', replacedBy: B })).toEqual({ ...ok, status: 'superseded', replacedBy: B })
  // whatever goes in, a title that comes out holds no § and no line break, and cleaning again changes nothing
  const bits = ['§', '\n', '\r', '\u2028', '\u0085', '\t', ' ', 'a', 'é', '\u{1f600}', '\ud83d', '\u0000', '\u202e', '+1', '!']
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: rnd(260) }, () => bits[rnd(bits.length)]!).join('')
    const once = clean({ ...ok, title: text, why: text, by: text, via: text, refs: [`+${text}`] })!
    expect(/[§\n\r\u2028\u2029\u0085\t\u0000-\u001f]/.test(once.title! + once.by + once.via)).toBe(false)
    expect(once.title!.length <= LIMITS.title && once.why!.length <= LIMITS.why && once.by.length <= LIMITS.name).toBe(true)
    expect(/[\u0000-\u0008\u000b-\u001f]/.test(once.why! + (once.refs ?? []).join(''))).toBe(false)
    expect(clean(once)).toEqual(once)
  }
})

test('a change is one plain line of JSON with its keys in a fixed order, and a hostile line is no change', async () => {
  const full = ch(A, [1700000000000, 2], { kind: 'decision', under: B, title: 'Amounts are "integer" cents', why: 'floats drift\nturned down: decimals', status: 'superseded', replacedBy: C, refs: ['+src/money.ts#round', '-src/old/**'] })
  expect(toLine(full)).toBe(
    `{"id":"${A}","at":[1700000000000,2],"writer":"0a0a0a0a0a0a","by":"ada","via":"person","kind":"decision","under":"${B}","title":"Amounts are \\"integer\\" cents","why":"floats drift\\nturned down: decimals","status":"superseded","replacedBy":"${C}","refs":["+src/money.ts#round","-src/old/**"]}`,
  )
  expect(toLine(ch(A, [3, 0], { title: 'only this' }))).toBe(`{"id":"${A}","at":[3,0],"writer":"0a0a0a0a0a0a","by":"ada","via":"person","title":"only this"}`)
  // keys in any order and unknown keys read the same
  expect(fromLine(`{"title":"only this","future":[1],"via":"person","by":"ada","writer":"0a0a0a0a0a0a","at":[3,0],"id":"${A}"}`)).toEqual(ch(A, [3, 0], { title: 'only this' }))
  for (const title of ['half a pair \ud83d alone', 'quote " backslash \\ slash /', 'é \u{1f600} 日本語', '<script>&amp;', '{"id":"x"}']) {
    const c = ch(A, [3, 0], { title, why: `${title}\n${title}` }), text = toLine(c)
    expect([/[\x00-\x1f]/.test(text), fromLine(text), toLine(fromLine(text)!)]).toEqual([false, c, text])
  }
  const rnd = dice(5)
  for (let i = 0; i < 800; i++) {
    const c = wild(rnd, 30), text = toLine(c)
    expect(text.includes('\n')).toBe(false)
    expect(fromLine(text)).toEqual(c)
    expect(toLine(fromLine(text)!)).toBe(text)
  }
  const good = toLine(ch(A, [3, 0], { title: 't' }))
  const with_ = (k: string, v: string) => good.replace(new RegExp(`"${k}":("[^"]*"|\\[[^\\]]*\\])`), `"${k}":${v}`)
  expect(fromLine(with_('at', '[3,0]'))).toBeDefined()
  for (const line of [
    '', 'not json', '{', 'null', 'true', '42', '"text"', '[]', `[${good}]`, '{}', '{"id":1}', good.slice(0, -1), `${good}x`,
    with_('at', '[1e999,0]'), with_('at', '[9007199254740993,0]'), with_('at', '[1,1e300]'), with_('at', '[-1,0]'), with_('at', '[1.5,0]'), with_('at', '[1]'),
    with_('at', '[1,2,3]'), with_('at', '{"ms":1,"n":0}'), with_('at', '"1,0"'), with_('at', '[null,0]'), with_('at', '[[1],0]'),
    with_('id', '7'), with_('id', '"../../etc"'), with_('id', '[]'), with_('writer', '"0A0A0A0A0A0A"'), with_('writer', '{}'), with_('by', 'null'),
    with_('title', '5'), with_('title', '["t"]'), with_('title', '{"toString":1}'), '['.repeat(50_000), `{"a":`.repeat(20_000), `${good.slice(0, -1)},"why":"${'y'.repeat(1 << 17)}"}`,
  ]) expect(fromLine(line)).toBeUndefined()
  expect(Object.getPrototypeOf(fromLine(`${good.slice(0, -1)},"__proto__":{"kind":"area"}}`)!)).toBe(Object.prototype)
  expect(fromLine(`${good.slice(0, -1)},"__proto__":{"kind":"area"}}`)!.kind).toBeUndefined()
})

test('a record is the fold of its registers; changes without a creation wait and are reported', async () => {
  const t = tree(
    ch(A, [10, 0], { kind: 'spec', under: '', title: 'first title', why: 'first why', status: 'proposed', refs: ['+src/a.ts'] }),
    ch(A, [12, 0], { title: 'second title' }, WRITERS[1]),
    ch(A, [11, 0], { title: 'lost title', why: 'second why' }, WRITERS[2]),
    // a record is never created, typed or parented twice: the lowest creation stands, even one read later
    ch(A, [20, 0], { kind: 'area', under: B, title: 'a later creation still sets the title' }, WRITERS[1]),
    ch(B, [9, 0], { kind: 'area', title: 'B' }),
  )
  expect(get(t, A)).toMatchObject({ kind: 'spec', under: '', by: 'ada', at: { ms: 10, n: 0 }, title: 'a later creation still sets the title', why: 'second why', status: 'proposed', refs: ['src/a.ts'] })
  fold(t, [clean({ ...ch(A, [8, 0], { kind: 'decision', under: B }), by: 'grace' })!])
  expect(get(t, A)).toMatchObject({ kind: 'decision', under: B, by: 'grace', at: { ms: 8, n: 0 }, title: 'a later creation still sets the title' })
  expect(get(tree(ch(C, [1, 0], { kind: 'area' })), C)).toMatchObject({ title: '', why: '', status: 'proposed', replacedBy: '', refs: [] })
  // status and replacedBy are one register: the highest change that sets a status sets both
  const s = tree(ch(A, [1, 0], { kind: 'spec' }), ch(A, [2, 0], { status: 'superseded', replacedBy: B }), ch(A, [3, 0], { title: 'edited since' }))
  expect(get(s, A)).toMatchObject({ status: 'superseded', replacedBy: B, live: false })
  fold(s, [ch(A, [4, 0], { status: 'accepted' }, WRITERS[1])])
  expect(get(s, A)).toMatchObject({ status: 'accepted', replacedBy: '', live: true })
  fold(s, [ch(A, [3, 5], { status: 'superseded', replacedBy: C }, WRITERS[2])]) // lower than the accept: it loses whole
  expect(get(s, A)).toMatchObject({ status: 'accepted', replacedBy: '' })
  // changes for an id nothing created are kept aside, reported, and make no record until the creation arrives
  const w = tree(ch(D, [5, 0], { title: 'waiting', refs: ['+src/w.ts'], status: 'accepted' }))
  expect([get(w, D), loose(w), outline(w), resolve(w, D), counts(w).live]).toEqual([undefined, [D], '', undefined, 0])
  fold(w, [ch(D, [4, 0], { kind: 'decision', title: 'created' })])
  expect([loose(w), get(w, D)]).toMatchObject([[], { title: 'waiting', status: 'accepted', refs: ['src/w.ts'], at: { ms: 4, n: 0 } }])
})

test('a reference is its own register, so concurrent adds both stay and the later of add and remove wins', async () => {
  const base = ch(A, [1, 0], { kind: 'spec', refs: ['+src/a.ts'] })
  const one = ch(A, [2, 0], { refs: ['+src/b.ts'] }, WRITERS[1]), two = ch(A, [2, 0], { refs: ['+src/c.ts', '-src/a.ts'] }, WRITERS[2])
  for (const files of [[base, one, two], [two, one, base], [one, base, two, one]]) expect(get(tree(...files), A)!.refs).toEqual(['src/b.ts', 'src/c.ts'])
  // remove then add again, and a remove that sorts before the add it never saw
  const t = tree(base, two, ch(A, [3, 0], { refs: ['+src/a.ts'] }), ch(A, [0, 5], { refs: ['-src/b.ts'] }), one)
  expect(get(t, A)!.refs).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  fold(t, [ch(A, [4, 0], { refs: ['-src/b.ts', '-never/there.ts'] })])
  expect(get(t, A)!.refs).toEqual(['src/a.ts', 'src/c.ts'])
})

test('a drop holds only while it is the last word on a record, and takes what is under it out of the lists', async () => {
  const made = [ch(A, [1, 0], { kind: 'area', title: 'Billing' }), ch(B, [2, 0], { kind: 'spec', under: A, title: 'Rounding', refs: ['+src/a.ts'] }), ch(C, [3, 0], { kind: 'decision', under: B, title: 'Half even', refs: ['+src/a.ts'] })]
  const drop = ch(A, [5, 0], { status: 'dropped' })
  const t = tree(...made, drop)
  expect([get(t, A)!.status, get(t, B)!.status, get(t, B)!.live, get(t, C)!.live]).toEqual(['dropped', 'proposed', false, false])
  expect([outline(t), search(t, /./).hits, governing(t, 'src/a.ts'), counts(t).live]).toEqual(['', 0, [], 0])
  // gone from the lists, still there by id and by prefix, and its line says so
  expect(line(t, A)).toBe(`${short(t, A)} area!dropped +1 Billing`)
  expect([resolve(t, short(t, C)), outline(t, { under: A, depth: 1 })]).toEqual([C, `${short(t, B)} spec!proposed +1 Rounding`])
  // an edit by a writer who never saw the drop sorts after it and brings the record back as proposed
  const edit = ch(A, [5, 0], { title: 'Billing and tax' }, WRITERS[1])
  for (const files of [[...made, drop, edit], [edit, drop, ...made], [edit, ...made, drop, drop]]) {
    const back = tree(...files)
    expect(get(back, A)).toMatchObject({ status: 'proposed', title: 'Billing and tax', live: true })
    expect(outline(back, { depth: 3 }).split('\n').length).toBe(3)
  }
  // an edit the drop came after does not, a second drop on top does, and a drop is undone by setting a status
  expect(get(tree(...made, drop, ch(A, [4, 0], { title: 'earlier' }, WRITERS[2])), A)!.status).toBe('dropped')
  expect(get(tree(...made, drop, edit, ch(A, [6, 0], { status: 'dropped' })), A)!.status).toBe('dropped')
  expect(get(tree(...made, drop, ch(A, [6, 0], { status: 'accepted' })), A)).toMatchObject({ status: 'accepted', live: true })
  // two writers settle one record at once: one register, so it is never accepted and superseded together
  const accept = ch(B, [7, 0], { status: 'accepted' }, WRITERS[1]), over = ch(B, [7, 0], { status: 'superseded', replacedBy: C }, WRITERS[2])
  for (const files of [[...made, accept, over], [over, accept, ...made]]) expect(get(tree(...files), B)).toMatchObject({ status: 'superseded', replacedBy: C })
  expect(get(tree(...made, over, ch(B, [7, 1], { status: 'accepted' }, WRITERS[1])), B)).toMatchObject({ status: 'accepted', replacedBy: '' })
})

test('a record whose parent is not here is listed under the root and the store says it is incomplete', async () => {
  const t = tree(ch(B, [2, 0], { kind: 'spec', under: A, title: 'Rounding', why: 'w', refs: ['+src/a.ts'] }), ch(C, [3, 0], { kind: 'decision', under: B, title: 'Half even' }))
  expect([missing(t), get(t, B)!.under, get(t, B)!.live]).toEqual([[A], A, true])
  expect(outline(t)).toBe(`${short(t, B)} spec!proposed Rounding\n ${short(t, C)} decision!proposed Half even`)
  expect(refuse(t, { title: 'Totals are summed in cents', why: 'w', refs: ['src/a.ts'] })).toMatch(/^the store is incomplete: 1 parent is named but not here/)
  // the file arrives: the record takes its place and writes are allowed again
  fold(t, [ch(A, [1, 0], { kind: 'area', title: 'Billing' })])
  expect([missing(t), outline(t, { depth: 1 })]).toEqual([[], `${short(t, A)} area!proposed +1 Billing`])
  expect(refuse(t, { title: 'Totals are summed in cents', why: 'w', refs: ['src/a.ts'] })).toBeUndefined()
})

test('the same changes give the same tree however they are split, ordered, repeated or folded, and it is the tree the rules describe', async () => {
  const rnd = dice(2026)
  for (let round = 0; round < 150; round++) {
    const changes = Array.from({ length: 5 + rnd(60) }, () => wild(rnd))
    const whole = fold(empty(), changes), want = dump(whole), rules = replay(changes)
    // against the rules written the slow way
    expect([...whole.nodes.keys()].sort().map(id => get(whole, id)).filter(r => r)).toEqual(rules.recs)
    expect([missing(whole), loose(whole)]).toEqual([rules.missing, rules.loose])
    const lines = outline(whole, { depth: 99, limit: 1e9 }).split('\n').filter(l => l)
    expect(lines.map(l => [resolve(whole, l.trim()), l.length - l.trimStart().length]).sort()).toEqual([...rules.depths].sort())
    // what governs each path is what a look at every record finds, a reference to the file itself before any glob
    PATHS.forEach((p, i) => {
      const got = governing(whole, p), exact = got.map(r => r.refs.some(ref => ref === p || ref.startsWith(`${p}#`)))
      expect(got.map(r => r.id).sort()).toEqual(rules.governed[i])
      expect(exact.lastIndexOf(true) < (exact.includes(false) ? exact.indexOf(false) : got.length)).toBe(true)
    })
    // split into files, some twice, folded one at a time in any order with questions asked in between
    const files: Sound[][] = Array.from({ length: 1 + rnd(8) }, () => [])
    for (const c of changes) files[rnd(files.length)]!.push(c)
    for (let i = rnd(4); i > 0; i--) files.push(files[rnd(files.length)]!.slice())
    const grown = empty()
    for (const file of shuffled(files, rnd)) {
      fold(grown, shuffled(file, rnd))
      if (rnd(2)) outline(grown), counts(grown)
    }
    expect(dump(grown)).toBe(want)
    expect(dump(fold(grown, shuffled(changes, rnd)))).toBe(want) // everything once more changes nothing
    expect(grown.rev).toBe(fold(grown, changes).rev)
    expect(dump(fold(empty(), shuffled(files, rnd).flat()))).toBe(want)
  }
})

test('no set of changes can build a loop: a parent is always created before its child', async () => {
  // each names the other; one names itself; a record created again, backdated, under its own child
  const pair = tree(ch(A, [1, 0], { kind: 'area', under: B }), ch(B, [1, 0], { kind: 'area', under: A }, WRITERS[1]))
  expect([get(pair, A)!.under, get(pair, B)!.under, missing(pair), outline(pair).split('\n').length]).toEqual([B, A, [B], 2])
  const self = tree(ch(A, [1, 0], { kind: 'area', under: A, title: 'own parent' }))
  expect([missing(self), outline(self)]).toEqual([[A], `${short(self, A)} area!proposed own parent`])
  const back = tree(ch(A, [10, 0], { kind: 'area' }), ch(B, [20, 0], { kind: 'spec', under: A }), ch(A, [5, 0], { kind: 'area', under: B }, WRITERS[1]))
  expect([missing(back), outline(back).split('\n').length]).toEqual([[B], 2])
  const rnd = dice(99)
  for (let round = 0; round < 150; round++) {
    const t = fold(empty(), Array.from({ length: 10 + rnd(80) }, () => wild(rnd, 6)))
    const records = [...t.nodes.values()].filter(n => n.made)
    expect(outline(t, { depth: 1e9, limit: 1e9 }).split('\n').filter(l => l).length).toBe(records.filter(n => n.depth >= 0).length)
    for (const n of records)
      for (let p = n, steps = 0; p.up !== t.root; p = p.up!, steps++) {
        expect(order(p.up!.made!, p.made!) < 0).toBe(true)
        expect(steps < records.length).toBe(true)
      }
  }
})

test('an id is shown by its shortest unique prefix and found again by it', async () => {
  // about half of all draws hold no digit in their first four characters and are drawn again
  const rnd = dice(8)
  let kept = 0
  for (let i = 0; i < 1000; i++) {
    const bytes = U8.from({ length: 8 }, () => rnd(256)), id = mint(bytes)
    expect(id).toBe(/\d/.test(idOf(bytes).slice(0, 4)) ? idOf(bytes) : undefined)
    if (id) kept++, expect(bytesOf(id)).toEqual(bytes)
  }
  expect(kept > 400 && kept < 550).toBe(true)
  // three ids that part at their eighth and eleventh characters
  const near = (...tail: number[]) => idOf(U8.of(9, 9, 9, 9, ...tail))
  const [P, Q, R] = [near(1, 0, 0, 0), near(2, 0, 0, 0), near(2, 0, 64, 0)] as [string, string, string]
  const t = tree(ch(P, [1, 0], { kind: 'area' }), ch(Q, [2, 0], { kind: 'area' }), ch(R, [3, 0], { kind: 'area' }), ch(A, [4, 0], { kind: 'area' }), ch(near(3, 0, 0, 0), [5, 0], { title: 'no record' }))
  expect([short(t, A), short(t, P), short(t, Q), short(t, R)]).toEqual([A.slice(0, 6), P.slice(0, 8), Q.slice(0, 11), R.slice(0, 11)])
  expect(resolve(t, P.slice(0, 7))).toEqual([P, Q, R].sort())
  expect(resolve(t, Q.slice(0, 8))).toEqual([Q, R].sort())
  expect([resolve(t, P.slice(0, 8)), resolve(t, Q), resolve(t, R.slice(0, 11)), resolve(t, `  ${A.slice(0, 6).toUpperCase()} area Billing`)]).toEqual([P, Q, R, A])
  expect([resolve(t, A.slice(0, 5)), resolve(t, 'zzzzzz'), resolve(t, ''), resolve(t, `${A}a`), resolve(t, near(3, 0, 0, 0))]).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect(line(t, P).startsWith(`${P.slice(0, 8)} area`)).toBe(true)
  // in any tree, every record's short id is at least six characters, belongs to no other record, and resolves to it
  for (let round = 0; round < 20; round++) {
    const ids = Array.from({ length: 30 }, () => idOf(U8.of(7, 7, 7, rnd(2) * 8, rnd(3), rnd(4) * 64, rnd(256), rnd(256))))
    const big = fold(empty(), ids.map((id, i) => ch(id, [i, 0], { kind: 'spec' })))
    for (const id of ids) {
      const s = short(big, id)
      expect(s.length >= 6 && ids.every(other => other === id || !other.startsWith(s))).toBe(true)
      expect(s.length === 6 || ids.some(other => other !== id && other.startsWith(s.slice(0, -1)))).toBe(true) // and no longer than it must be
      expect(resolve(big, s)).toBe(id)
    }
  }
})

test('a record is one line that parses one way, whatever its title starts with', async () => {
  /** The grammar, read back: indent, short id, kind, status, hidden children, title. */
  const parse = (l: string) => {
    const m = /^( *)([a-z2-7]{6,13}) (area|spec|decision)(?:!([a-z]+))?(?: \+(\d+))?(?: (.*))?$/.exec(l)!
    return { level: m[1]!.length, id: m[2]!, kind: m[3]!, status: m[4] ?? 'accepted', hidden: Number(m[5] ?? 0), title: m[6] ?? '' }
  }
  const titles = ['Amounts are integer cents', '', '!important', '!dropped', '+3 more', '+12', '+0', '+', '+x', '+3x', '42 is the answer', '7', 'area!stale +9 x', '+1 +2 +3', '- minus', '§§', ' padded ']
  const rnd = dice(4)
  for (let round = 0; round < 400; round++) {
    const title = round < titles.length ? titles[round]! : Array.from({ length: rnd(5) }, () => ['+', '!', '3', '+7', ' ', 'a', 'spec', '!dropped', '0'][rnd(9)]!).join('')
    const status = (['proposed', 'accepted', 'superseded', 'dropped'] as const)[rnd(4)]!, kind = (['area', 'spec', 'decision'] as const)[rnd(3)]!, n = rnd(3)
    const t = tree(ch(A, [1, 0], { kind, title, status, refs: ['+gone.ts'] }), ...Array.from({ length: n }, (_, i) => ch(IDS[10 + i]!, [2, i], { kind: 'spec', under: A, title: 'child' })))
    const want = { level: 0, id: short(t, A), kind, status, hidden: n, title: get(t, A)!.title }
    expect(parse(line(t, A))).toEqual(want)
    expect(parse(line(t, A, 0))).toEqual({ ...want, hidden: 0 })
    expect(line(t, A).endsWith(' ')).toBe(false)
    if (stale(t, []) && get(t, A)!.stale) expect(parse(line(t, A))).toEqual({ ...want, status: 'stale' })
  }
  const t = tree(ch(A, [1, 0], { kind: 'decision', title: 'Amounts are integer cents', status: 'accepted' }), ch(B, [2, 0], { kind: 'area', title: '+3 more' }), ch(C, [3, 0], { kind: 'spec', under: B, title: '' }))
  expect([line(t, A), line(t, B), line(t, B, 0), line(t, C), line(t, D)]).toEqual([
    `${short(t, A)} decision Amounts are integer cents`, `${short(t, B)} area!proposed +1 +3 more`, `${short(t, B)} area!proposed +0 +3 more`, `${short(t, C)} spec!proposed`, '',
  ])
})

test('an outline lists children oldest first, a space per level, and says what it leaves out', async () => {
  const [P, Q] = A < B ? [A, B] : [B, A] // created at one stamp: the id puts P first, though Q's writer sorts first
  const t = tree(
    ch(C, [3, 0], { kind: 'area', title: 'Third' }), ch(Q, [1, 0], { kind: 'area', title: 'Second, by id' }), ch(P, [1, 0], { kind: 'area', title: 'First', status: 'accepted' }, WRITERS[1]),
    ch(D, [4, 0], { kind: 'spec', under: P, title: 'Under first', status: 'accepted' }), ch(E, [5, 0], { kind: 'decision', under: D, title: 'Two down' }), ch(F, [6, 0], { kind: 'decision', under: E, title: 'Three down' }),
    ch(G, [7, 0], { kind: 'spec', under: C, title: 'Under third' }), ch(H, [8, 0], { kind: 'spec', under: C, title: 'Dropped', status: 'dropped' }),
  )
  const s = (id: string) => short(t, id), more = (n: number) => `… ${n} more: narrow with under=<id>, a smaller depth, or search`
  const top = [`${s(P)} area +1 First`, `${s(Q)} area!proposed Second, by id`, `${s(C)} area!proposed +1 Third`]
  expect(outline(t).split('\n')).toEqual([`${s(P)} area First`, ` ${s(D)} spec +1 Under first`, top[1], `${s(C)} area!proposed Third`, ` ${s(G)} spec!proposed Under third`])
  expect(outline(t, { depth: 1 }).split('\n')).toEqual(top)
  expect(outline(t, { under: s(P), depth: 9 }).split('\n')).toEqual([`${s(D)} spec Under first`, ` ${s(E)} decision!proposed Two down`, `  ${s(F)} decision!proposed Three down`])
  expect([outline(t, { under: 'zzzzzz' }), outline(t, { under: s(G) }), outline(t, { depth: 0 }), outline(empty())]).toEqual(['', '', '', ''])
  // past the limit the shallowest come first, a branch cut short shows in its parent's count, and the last line counts the rest
  expect(outline(t, { depth: 9, limit: 4 }).split('\n')).toEqual([...top, more(4)])
  expect(outline(t, { depth: 9, limit: 6 }).split('\n')).toEqual([`${s(P)} area First`, ` ${s(D)} spec +1 Under first`, top[1], `${s(C)} area!proposed Third`, ` ${s(G)} spec!proposed Under third`, more(2)])
  expect(outline(t, { depth: 9, limit: 7 }).split('\n')).toEqual([`${s(P)} area First`, ` ${s(D)} spec Under first`, `  ${s(E)} decision!proposed Two down`, `   ${s(F)} decision!proposed Three down`, top[1], `${s(C)} area!proposed Third`, ` ${s(G)} spec!proposed Under third`])
  expect(outline(t, { depth: 9, limit: 0 })).toBe(more(7))
  // a wide store: sixty lines by default, every top-level area before any child
  const wide = fold(empty(), Array.from({ length: 30 }, (_, i) => [ch(IDS[i]!, [i, 0], { kind: 'area', title: `Area ${i}` }), ...Array.from({ length: 5 }, (_, k) => ch(idOf(U8.of(1, i, k, 9, 9, 9, 9, 9)), [100 + i, k], { kind: 'spec', under: IDS[i]!, title: 'x' }))]).flat())
  const lines = outline(wide).split('\n')
  expect([lines.length, lines.filter(l => !l.startsWith(' ') && !l.startsWith('…')).length, lines.at(-1)]).toEqual([60, 30, more(121)])
  // a limit that falls among one record's children shows the first of them and counts the others
  const mid = outline(wide, { limit: 58 }).split('\n')
  expect([mid.length, mid[30], mid[33], mid.at(-1)]).toEqual([58, `${short(wide, IDS[5]!)} area!proposed +3 Area 5`, `${short(wide, IDS[6]!)} area!proposed +5 Area 6`, more(123)])
  expect([lines[0], lines[6], lines.at(-2)]).toEqual([`${short(wide, IDS[0]!)} area!proposed Area 0`, `${short(wide, IDS[1]!)} area!proposed Area 1`, `${short(wide, IDS[29]!)} area!proposed +5 Area 29`])
})

test('search finds records by title, reference or why and says where each one sits', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Billing', status: 'accepted' }), ch(B, [2, 0], { kind: 'area', under: A, title: 'Money', status: 'accepted' }),
    ch(C, [3, 0], { kind: 'decision', under: B, title: 'Amounts are integer cents', why: 'floats drift', refs: ['+src/money.ts'], status: 'accepted' }),
    ch(D, [4, 0], { kind: 'spec', under: B, title: 'Rounding is half-even', why: 'the bank rounds this way', refs: ['+src/round.ts'] }),
    ch(E, [5, 0], { kind: 'decision', title: 'Dates are UTC', why: 'no drift across zones', refs: ['+src/time.ts'], status: 'superseded', replacedBy: F }),
    ch(F, [6, 0], { kind: 'decision', under: A, title: 'Invoices are immutable', why: 'audit', refs: ['+src/invoice/**'] }),
    ch(G, [7, 0], { kind: 'spec', under: A, title: 'Dropped drift rule', status: 'dropped' }),
  )
  const s = (id: string) => short(t, id)
  expect(search(t, /drift/)).toEqual({ hits: 2, text: `${s(E)} decision!superseded Dates are UTC\n# Billing > Money\n ${s(C)} decision Amounts are integer cents` })
  expect(search(t, /^src\/(round|invoice)/).text).toBe(`# Billing > Money\n ${s(D)} spec!proposed Rounding is half-even\n# Billing\n ${s(F)} decision!proposed Invoices are immutable`)
  expect(search(t, /BILLING/i).text).toBe(`${s(A)} area +2 Billing`)
  expect(search(t, /are/g, 2)).toEqual({ hits: 3, text: `${s(E)} decision!superseded Dates are UTC\n# Billing > Money\n ${s(C)} decision Amounts are integer cents\n… 1 more: narrow the pattern` })
  expect(search(t, /nothing here/)).toEqual({ hits: 0, text: '' })
  expect(search(fold(t, [ch(D, [9, 0], { refs: ['-src/round.ts', '+src/half.ts'] })]), /src\/(round|half)/).text).toBe(`# Billing > Money\n ${s(D)} spec!proposed Rounding is half-even`)
  expect(search(t, /src\/round/).hits).toBe(0) // a reference since removed is not found
})

test('a path is governed by the live records whose references cover it, the most specific first', async () => {
  for (const [ref, path, want] of [
    ['src/a.ts', 'src/a.ts', true], ['src/a.ts#round', 'src/a.ts', true], ['src/a.ts', 'src/a.tsx', false], ['src/a.ts', 'lib/src/a.ts', false], ['src/c#/a.cs', 'src/c#/a.cs', true],
    ['src/c#/a.cs#Run', 'src/c#/a.cs', true], ['src/c#/a.cs', 'src/c', false], ['src', 'src/a.ts', false],
    ['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/x/a.ts', false], ['src/*', 'src/x/a.ts', false], ['*', 'a.ts', true], ['*', 'x/a.ts', false], ['src/*/a.ts', 'src/x/a.ts', true],
    ['src/*/a.ts', 'src/x/y/a.ts', false], ['src/*/a.ts', 'src/a.ts', false], ['a*c*e', 'abcde', true], ['a*c*e', 'abcd', false], ['src/a*.ts', 'src/a.ts', true],
    ['src/**', 'src/a.ts', true], ['src/**', 'src/x/y/a.ts', true], ['src/**', 'src', false], ['src/**', 'srcs/a.ts', false], ['**', 'x/y/a.ts', true],
    ['**/*.ts', 'a.ts', true], ['**/*.ts', 'x/y/a.ts', true], ['**/*.ts', 'x/y/a.tsx', false], ['**/a.ts', 'xa.ts', false], ['src/**/a.ts', 'src/a.ts', true],
    ['src/**/a.ts', 'src/x/y/a.ts', true], ['src/**/a.ts', 'src/xa.ts', false], ['src/**/a.ts', 'src/x/a.tsx', false], ['src/**.ts', 'src/x/a.ts', true], ['src/**.ts', 'src/x/a.js', false],
    ['src/**/x/**/a.ts', 'src/x/a.ts', true], ['src/**/x/**/a.ts', 'src/p/x/q/r/a.ts', true], ['src/**/x/**/a.ts', 'src/p/q/a.ts', false], ['src/**#round', 'src/x/a.ts', true],
    ['src/[id]/page.tsx', 'src/[id]/page.tsx', true], ['src/[ab]/page.tsx', 'src/a/page.tsx', false], ['src/a?.ts', 'src/ab.ts', false], ['src/(x|y).ts', 'src/x.ts', false],
  ] as const) expect([ref, path, covers(ref, path)]).toEqual([ref, path, want])
  // the matcher against the same rules written as a regular expression, on small random globs and paths
  const rnd = dice(6), bit = (bits: readonly string[]) => Array.from({ length: 1 + rnd(7) }, () => bits[rnd(bits.length)]!).join('')
  for (let i = 0; i < 5000; i++) {
    const g = bit(['a', 'b', '/', '/', '*', '**', '**/', '/**']), p = bit(['a', 'b', 'ab', '/', 'a/'])
    const re = new RegExp(`^${g.split(/((?:^|(?<=\/))\*\*+\/|\*\*+|\*)/).map((s, k) => (k % 2 === 0 ? s : s === '*' ? '[^/]*' : s.endsWith('/') ? '(?:.*/)?' : '.*')).join('')}$`)
    expect([g, p, covers(g, p)]).toEqual([g, p, re.test(p)])
  }
  // a glob built to make a matcher crawl answers at once
  expect(covers(`${'*a'.repeat(140)}b`, 'a'.repeat(300))).toBe(false)
  expect(covers(`**/${'*a'.repeat(100)}/b`, `${'a'.repeat(40)}/`.repeat(7))).toBe(false)
  expect(covers('**a'.repeat(100), 'a'.repeat(300))).toBe(true)
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Everything in src', refs: ['+src/**'], status: 'accepted' }), ch(B, [2, 0], { kind: 'area', under: A, title: 'Billing', refs: ['+src/billing/**'] }),
    ch(C, [3, 0], { kind: 'spec', under: B, title: 'Rounding', refs: ['+src/billing/round.ts#half', '+docs/**'] }), ch(D, [4, 0], { kind: 'decision', title: 'Typescript is strict', refs: ['+**/*.ts'] }),
    ch(E, [5, 0], { kind: 'decision', under: B, title: 'The file itself', refs: ['+src/billing/round.ts'] }), ch(F, [6, 0], { kind: 'decision', title: 'Replaced', refs: ['+src/billing/round.ts'], status: 'superseded', replacedBy: E }),
    ch(G, [7, 0], { kind: 'decision', title: 'Dropped', refs: ['+src/billing/round.ts'], status: 'dropped' }), ch(H, [8, 0], { kind: 'decision', under: G, title: 'Under a dropped record', refs: ['+src/billing/round.ts'] }),
    ch(IDS[20]!, [9, 0], { kind: 'spec', title: 'One level only', refs: ['+src/billing/*.ts', '+src/*.ts'] }), ch(IDS[21]!, [10, 0], { kind: 'spec', title: 'Removed since', refs: ['+src/billing/round.ts'] }), ch(IDS[21]!, [11, 0], { refs: ['-src/billing/round.ts'] }),
    // held more than one way, a record counts by its tightest hold
    ch(IDS[22]!, [12, 0], { kind: 'spec', title: 'File and glob', refs: ['+**', '+src/billing/round.ts', '+src/**'] }), ch(IDS[23]!, [13, 0], { kind: 'spec', title: 'Two globs', refs: ['+src/**', '+src/billing/**', '+**'] }),
  )
  expect(governing(t, 'src/billing/round.ts').map(r => r.title)).toEqual(['Rounding', 'The file itself', 'File and glob', 'Billing', 'One level only', 'Two globs', 'Everything in src', 'Typescript is strict'])
  expect(governing(t, 'src/billing/deep/x.ts').map(r => r.title)).toEqual(['Billing', 'Two globs', 'Everything in src', 'File and glob', 'Typescript is strict'])
  expect(governing(t, 'src/x.ts').map(r => r.title)).toEqual(['Everything in src', 'One level only', 'File and glob', 'Two globs', 'Typescript is strict'])
  expect([governing(t, 'docs/a.md').map(r => r.title), governing(t, 'README.md').map(r => r.title)]).toEqual([['Rounding', 'File and glob', 'Two globs'], ['File and glob', 'Two globs']])
  // a file whose own name holds a "#" is still found by its whole name, and a symbol on it still counts
  const sharp = tree(
    ch(A, [1, 0], { kind: 'spec', title: 'Whole name', refs: ['+notes/c#.md'] }), ch(B, [2, 0], { kind: 'spec', title: 'A symbol on it', refs: ['+notes/c#.md#intro'] }),
    ch(C, [3, 0], { kind: 'spec', title: 'Another file', refs: ['+notes/c'] }), ch(D, [4, 0], { kind: 'spec', title: 'A glob whose prefix is a whole name', refs: ['+notes/READ*'] }),
  )
  expect([governing(sharp, 'notes/c#.md').map(r => r.title), governing(sharp, 'notes/c').map(r => r.title)]).toEqual([['Whole name', 'A symbol on it'], ['Whole name', 'Another file']])
  expect([stale(sharp, ['notes/c#.md']), get(sharp, C)!.stale, stale(sharp, ['notes/c']), get(sharp, B)!.stale]).toEqual([2, true, 2, true])
  expect([stale(sharp, ['notes/READ', 'notes/REAL']), get(sharp, D)!.stale, stale(sharp, ['notes/REAL', 'notes/READ.md', 'notes/RE']), get(sharp, D)!.stale]).toEqual([3, false, 3, false])
})

test('an add is turned down for each reason it can be, and a duplicate is answered with the record that exists', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Billing', refs: ['+src/billing/**'], status: 'accepted' }), ch(B, [2, 0], { kind: 'decision', under: A, title: 'Amounts are integer cents', why: 'w', refs: ['+src/billing/money.ts'], status: 'accepted' }),
    ch(C, [3, 0], { kind: 'decision', title: 'Old way', refs: ['+src/old.ts'], status: 'superseded', replacedBy: B }), ch(D, [4, 0], { kind: 'area', title: 'Gone', status: 'dropped' }), ch(E, [5, 0], { kind: 'spec', under: D, title: 'Under gone' }),
    ch(idOf(U8.of(9, 9, 9, 9, 1, 0, 0, 0)), [6, 0], { kind: 'area', title: 'Twin one' }), ch(idOf(U8.of(9, 9, 9, 9, 2, 0, 0, 0)), [7, 0], { kind: 'area', title: 'Twin two' }),
  )
  const ok = { title: 'Totals are summed in cents', why: 'floats drift; decimals were turned down', refs: ['src/billing/total.ts'] }
  expect(refuse(t, ok)).toBeUndefined()
  expect(refuse(t, { title: 'Payments', kind: 'area' })).toBeUndefined() // an area needs neither a ref nor a why
  expect(refuse(t, { ...ok, title: '  \n ' })).toBe('the title is empty')
  expect(refuse(t, { ...ok, title: 'x'.repeat(201) })).toMatch(/^the title is 201 characters, over the limit of 200/)
  expect(refuse(t, { ...ok, title: 'x'.repeat(200) })).toBeUndefined()
  for (const verb of ['Added', 'Fixed', 'Updated', 'Implemented', 'Renamed', 'Changed', 'Removed', 'Refactored'])
    for (const title of [`${verb} the totals`, `${verb.toLowerCase()}: totals`, verb]) expect(refuse(t, { ...ok, title })).toMatch(/^the title opens with "\w+", which says what was done/)
  expect([refuse(t, { ...ok, title: 'Fixed-point amounts are used for money' }), refuse(t, { ...ok, title: 'Addedness is not a word' })]).toEqual([undefined, undefined])
  expect(refuse(t, { ...ok, refs: [] })).toMatch(/^a decision needs a ref/)
  expect(refuse(t, { ...ok, kind: 'spec', refs: undefined })).toMatch(/^a spec needs a ref/)
  expect(refuse(t, { ...ok, why: ' \n' })).toMatch(/^a decision needs a why/)
  expect(refuse(t, { title: ok.title, refs: ok.refs, kind: 'spec' })).toMatch(/^a spec needs a why/)
  expect(refuse(t, { ...ok, kind: 'epic' as 'area' })).toBe('kind is one of area, spec, decision')
  expect(refuse(t, { ...ok, why: 'y'.repeat(2049) })).toMatch(/^the why is 2049 characters/)
  expect(refuse(t, { ...ok, refs: Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`) })).toMatch(/^33 refs, over the limit of 32/)
  for (const ref of ['', 'src/a\nb.ts', `src/${'p'.repeat(300)}`]) expect(refuse(t, { ...ok, refs: [ref] })).toMatch(/^ref ".*" is empty, over 300 characters or holds a control character/)
  // under and replaces each name exactly one live record
  expect(refuse(t, { ...ok, under: short(t, A) })).toBeUndefined()
  expect(refuse(t, { ...ok, replaces: B })).toBeUndefined()
  expect(refuse(t, { ...ok, under: 'zzzzzz' })).toBe('under "zzzzzz" matches no record')
  expect(refuse(t, { ...ok, under: idOf(U8.of(9, 9, 9, 9, 0, 0, 0, 0)).slice(0, 7) })).toMatch(/^under ".{7}" matches 2 records: .{8}, .{8}$/)
  expect(refuse(t, { ...ok, under: C })).toMatch(/^under ".+" is superseded: /)
  expect(refuse(t, { ...ok, under: D })).toMatch(/^under ".+" is dropped: /)
  expect(refuse(t, { ...ok, replaces: E })).toMatch(/^replaces ".+" is under a dropped record: /)
  expect(refuse(t, { ...ok, replaces: 'nothing' })).toBe('replaces "nothing" matches no record')
  // the same rule on the same code, whatever its case, punctuation or spacing
  const dup = { ...ok, title: 'amounts   are INTEGER-cents.', refs: ['./src/billing/money.ts'] }
  expect(refuse(t, dup)).toBe(`exists: ${short(t, B)} decision Amounts are integer cents`)
  expect([refuse(t, { ...dup, refs: ['src/billing/other.ts'] }), refuse(t, { ...dup, title: 'Amounts are integer euros' }), refuse(t, { ...dup, replaces: B })]).toEqual([undefined, undefined, undefined])
  expect(refuse(t, { ...ok, title: 'old WAY', refs: ['src/old.ts'] })).toBeUndefined() // what it would repeat is superseded
  expect(refuse(t, { ...dup, refs: ['src/billing/money.ts#cents'] })).toBe(`exists: ${short(t, B)} decision Amounts are integer cents`) // the same file, whatever the symbol
  fold(t, [ch(B, [9, 0], { refs: ['-src/billing/money.ts', '+src/billing/cents.ts#sum'] })])
  expect([refuse(t, dup), refuse(t, { ...dup, refs: ['src/billing/cents.ts'] })]).toEqual([undefined, `exists: ${short(t, B)} decision Amounts are integer cents`]) // it no longer speaks for that file
  expect(refuse(t, { title: 'billing!', kind: 'area', refs: ['src/billing/'] })).toBe(`exists: ${short(t, A)} area +1 Billing`)
})

test('an accepted add becomes changes: a proposed record in the right place, and the record it replaces superseded', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Source', refs: ['+src/**'] }), ch(B, [2, 0], { kind: 'area', under: A, title: 'Billing', refs: ['+src/billing/**', '+docs/billing.md'] }),
    ch(C, [3, 0], { kind: 'area', under: A, title: 'Billing tests', refs: ['+src/billing/tests/**'] }), ch(D, [4, 0], { kind: 'area', under: B, title: 'Old money', refs: ['+src/billing/**'], status: 'superseded' }),
    ch(E, [5, 0], { kind: 'decision', under: C, title: 'A decision is no home', why: 'w', refs: ['+src/billing/**'] }), ch(F, [6, 0], { kind: 'area', title: 'No refs' }),
  )
  // home: the deepest live area with one reference that covers them all, the tightest among equals
  expect(home(t, ['src/billing/money.ts'])).toBe(B)
  expect(home(t, ['src/billing/tests/money.ts'])).toBe(C)
  expect(home(t, ['src/billing/tests/money.ts', 'src/billing/money.ts#round'])).toBe(B)
  expect(home(t, ['src/billing/a.ts', 'src/auth/b.ts'])).toBe(A)
  expect(home(t, ['src/billing/sub/**'])).toBe(B)
  expect(home(t, ['docs/billing.md#intro'])).toBe(B) // a file covers its symbols
  expect(home(t, ['src/billing/a.ts', 'docs/billing.md'])).toBe('') // no single reference covers both
  expect([home(t, ['lib/x.ts']), home(t, []), home(empty(), ['src/a.ts'])]).toEqual(['', '', ''])
  // deeper wins even over a tighter hold higher up
  const deep = tree(ch(A, [1, 0], { kind: 'area', refs: ['+src/billing/money.ts'] }), ch(B, [2, 0], { kind: 'area', under: A, refs: ['+src/**'] }), ch(C, [3, 0], { kind: 'area', refs: ['+src/billing/**'] }))
  expect(home(deep, ['src/billing/money.ts'])).toBe(B)
  const who = { writer: WRITERS[1], by: 'claude', via: 'agent claude-opus-5-5' }, at = tick(t.clock, 1000)
  const add = { title: 'Totals are\nsummed in cents', why: 'floats drift', refs: ['./src/billing/total.ts', 'src/billing/sums/'] }
  expect(refuse(t, add)).toBeUndefined()
  const made = record(t, add, G, at, who)
  expect(made).toEqual([{ id: G, at: { ms: 1000, n: 0 }, ...who, kind: 'decision', under: B, title: 'Totals are summed in cents', why: 'floats drift', status: 'proposed', refs: ['+src/billing/total.ts', '+src/billing/sums/**'] }])
  expect(made.map(c => fromLine(toLine(c)))).toEqual(made)
  expect(get(fold(t, made), G)).toMatchObject({ kind: 'decision', under: B, status: 'proposed', by: 'claude', live: true })
  expect(record(t, { title: 'Payments', kind: 'area', under: short(t, F) }, H, tick(t.clock, 1000), who)).toEqual([{ id: H, at: { ms: 1000, n: 1 }, ...who, kind: 'area', under: F, title: 'Payments', status: 'proposed' }])
  // replacing: the new record takes the old one's place, and the old one is superseded by it one tick later
  const again = { title: 'Totals are summed in integer cents', why: 'said more exactly', refs: ['src/billing/total.ts'], replaces: short(t, G) }
  expect(refuse(t, again)).toBeUndefined()
  const two = record(t, again, H, tick(t.clock, 1000), who)
  expect(two.map(c => [c.id, c.at.n, c.under, c.status, c.replacedBy])).toEqual([[H, 1, B, 'proposed', undefined], [G, 2, undefined, 'superseded', H]])
  fold(t, two)
  expect([get(t, G), get(t, H)]).toMatchObject([{ status: 'superseded', replacedBy: H, live: false }, { status: 'proposed', under: B, live: true }])
  expect(governing(t, 'src/billing/total.ts').map(r => r.id)).toEqual([H, B, E, A])
  expect(t.clock).toEqual({ ms: 1000, n: 2 })
  const placed = record(t, { ...add, title: 'Kept apart on purpose', under: F }, IDS[31]!, tick(t.clock, 1000), who)
  const moved = record(fold(t, placed), { ...add, title: 'Kept apart, said again', replaces: IDS[31]! }, IDS[32]!, tick(t.clock, 1000), who)
  expect([placed[0]!.under, moved[0]!.under, home(t, add.refs)]).toEqual([F, F, B])
  // a name that does not resolve writes nothing
  expect([record(t, { ...add, under: 'zzzzzz' }, IDS[30]!, at, who), record(t, { ...add, replaces: 'zzzzzz' }, IDS[30]!, at, who), record(t, add, 'not an id', at, who)]).toEqual([[], [], []])
})

test('the header counts what is in force, and a record whose code is gone reads as stale', async () => {
  const changes = [
    ch(A, [1, 0], { kind: 'area', title: 'Billing', refs: ['+gone/**'], status: 'accepted' }), ch(B, [2, 0], { kind: 'decision', under: A, title: 'Lives by a file', refs: ['+src/a.ts#f', '+gone.ts'], status: 'accepted' }),
    ch(C, [3, 0], { kind: 'spec', under: A, title: 'Lives by a glob', refs: ['+src/**/*.ts'] }), ch(D, [4, 0], { kind: 'spec', under: A, title: 'File gone', refs: ['+src/old.ts', '+lib/*.ts'], status: 'accepted' }),
    ch(E, [5, 0], { kind: 'decision', title: 'Glob matches nothing', refs: ['+src/*.md'] }), ch(F, [6, 0], { kind: 'decision', title: 'Superseded', refs: ['+src/old.ts'], status: 'superseded' }),
    ch(G, [7, 0], { kind: 'decision', title: 'Dropped', refs: ['+src/old.ts'], status: 'dropped' }), ch(H, [8, 0], { kind: 'spec', title: 'No refs left', refs: ['+src/a.ts'] }), ch(H, [9, 0], { refs: ['-src/a.ts'] }),
  ]
  const t = tree(...changes)
  expect(counts(t)).toEqual({ live: 6, proposed: 3, areas: 1, stale: 0 })
  expect(stale(t, ['src/a.ts', 'src/deep/b.ts', 'lib/x/y.ts', 'README.md'])).toBe(3)
  expect(counts(t)).toEqual({ live: 6, proposed: 3, areas: 1, stale: 3 })
  expect([D, E, H, A, B, C, F, G].map(id => get(t, id)!.stale)).toEqual([true, true, true, false, false, false, false, false])
  expect([line(t, D), line(t, E), line(t, B), line(t, F), line(t, G)]).toEqual([
    `${short(t, D)} spec!stale File gone`, `${short(t, E)} decision!stale Glob matches nothing`, `${short(t, B)} decision Lives by a file`, `${short(t, F)} decision!superseded Superseded`, `${short(t, G)} decision!dropped Dropped`,
  ])
  expect(outline(t)).toContain(` ${short(t, D)} spec!stale File gone`)
  // a record dropped or superseded after it was marked says that, not stale
  const later = tree(...changes)
  expect(stale(later, ['src/a.ts'])).toBe(3)
  fold(later, [ch(D, [20, 0], { status: 'dropped' }), ch(E, [20, 0], { status: 'superseded' })])
  expect([line(later, D), line(later, E), get(later, D)!.stale, counts(later).stale]).toEqual([`${short(later, D)} spec!dropped File gone`, `${short(later, E)} decision!superseded Glob matches nothing`, false, 1])
  // the marks are as of the last call
  expect([stale(t, ['src/old.ts', 'src/notes.md', 'src/a.ts']), get(t, H)!.stale, stale(t, [])]).toEqual([1, true, 5])
  expect(counts(tree())).toEqual({ live: 0, proposed: 0, areas: 0, stale: 0 })
})

test('half of a surrogate pair becomes U+FFFD, so a change is the same text from a line and from a pack', async () => {
  const ok = { id: A, at: { ms: 1, n: 0 }, writer: WRITERS[0], by: 'ada', via: 'person' }
  const torn = 'a\ud83d b\udc00c 😀 \udc00\ud83d', mended = 'a� b�c \u{1f600} ��'
  const c = clean({ ...ok, by: torn, via: torn, kind: 'spec', title: torn, why: `${torn}\n${torn}`, refs: [`+src/${torn}.ts`, `-src/${mended}.ts`, '+x\ud83d', '-x�'] })!
  expect([c.title, c.by, c.via, c.why, c.refs]).toEqual([mended, mended, mended, `${mended}\n${mended}`, [`-src/${mended}.ts`, '-x�']]) // two spellings of one reference are one say
  expect(clean({ ...ok, title: `${'x'.repeat(LIMITS.title - 1)}😀\ud83d` })!.title).toBe('x'.repeat(LIMITS.title - 1)) // the cut still never leaves half a pair
  // a line written before this rule, the half pair escaped as JSON escapes it, reads as the mended change
  const old = `{"id":"${A}","at":[1,0],"writer":"0a0a0a0a0a0a","by":"ada","via":"person","title":"half \\ud83d here","refs":["+a\\udc00"]}`
  expect(fromLine(old)).toMatchObject({ title: 'half � here', refs: ['+a�'] })
  // what compaction checks: the changes a pack gives back are, line for line, the changes that went in
  const sealed = (cs: Sound[]) => unpack(pack(cs)).map(x => toLine(clean(x)!))
  expect(sealed([c, fromLine(old)!]).sort()).toEqual([c, fromLine(old)!].map(toLine).sort()) // a pack keeps its own order
  const rnd = dice(77), bits = ['\ud83d', '\ude00', '😀', '\udfff', '\ud800', 'a', ' ', 'é', '\n', '§', '\u0000', '日']
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  for (let i = 0; i < 400; i++) {
    const text = Array.from({ length: rnd(40) }, () => bits[rnd(bits.length)]!).join('')
    const made = clean({ ...ok, id: IDS[rnd(40)]!, by: text, via: text, kind: 'decision', title: text, why: text, refs: [`+${text}`, `-b${text}`] })!
    expect(lone.test(toLine(made).replace(/\\u[0-9a-f]{4}/g, '?') + made.title + made.why + made.by + made.via + (made.refs ?? []).join(''))).toBe(false)
    expect([clean(made), fromLine(toLine(made)), sealed([made])]).toEqual([made, made, [toLine(made)]])
  }
})

test('log tells the history newest first, one plain line a change, and show sets a record above its own', async () => {
  const d = (day: number) => Date.UTC(2026, 9, day, 12)
  const made = ch(A, [d(7), 0], { kind: 'decision', title: 'Amounts are integer cents', why: 'floats drift', status: 'proposed', refs: ['+src/a.ts'] })
  const all = [
    made, ch(A, [d(8), 0], { title: 'Amounts are whole cents' }, WRITERS[1]), ch(A, [d(8), 1], { status: 'accepted' }), ch(A, [d(9), 0], { why: 'said again', refs: ['+src/b.ts', '-src/a.ts'] }),
    clean({ ...ch(B, [d(9), 1], { kind: 'decision', title: 'Amounts are minor units', why: 'w', refs: ['+src/b.ts'] }), by: 'claude', via: 'agent claude-haiku' })!,
    ch(A, [d(9), 2], { status: 'superseded', replacedBy: B }), ch(C, [d(9), 3], { kind: 'area', title: 'Money' }), ch(D, [d(9), 4], { kind: 'spec', under: C, title: 'Kept', status: 'dropped' }),
    ch(E, [d(9), 5], { title: 'no creation' }),
  ]
  const t = tree(...all), s = (id: string) => short(t, id)
  const mine = [
    `${s(A)} 2026-10-09 ada via person: superseded by ${s(B)}`, `${s(A)} 2026-10-09 ada via person: why, +src/b.ts -src/a.ts`, `${s(A)} 2026-10-08 ada via person: accepted`,
    `${s(A)} 2026-10-08 ada via person: title "Amounts are whole cents"`, `${s(A)} 2026-10-07 ada via person: created decision, title "Amounts are integer cents", why, +src/a.ts`,
  ]
  expect(log(all, A, t)).toEqual(mine)
  // every change of the store, whatever order and however often it was read
  const rnd = dice(12), whole = log(all, undefined, t)
  expect(whole).toEqual([
    `${s(E)} 2026-10-09 ada via person: title "no creation"`, `${s(D)} 2026-10-09 ada via person: created spec under ${s(C)}, title "Kept", dropped`, `${s(C)} 2026-10-09 ada via person: created area, title "Money"`,
    mine[0], `${s(B)} 2026-10-09 claude via agent claude-haiku: created decision, title "Amounts are minor units", why, +src/b.ts`, ...mine.slice(1),
  ])
  expect(log(shuffled([...all, ...all, made], rnd), undefined, t)).toEqual(whole)
  // without a tree the ids are whole; an id nothing mentions has no history
  expect(log(all, A)[0]).toBe(`${A} 2026-10-09 ada via person: superseded by ${B}`)
  expect([log(all, F, t), log([], undefined, t), log(all, s(A), t)]).toEqual([[], [], []])
  // a stamp no calendar holds still gets a line
  expect([day({ ms: 0, n: 0 }), day({ ms: d(9), n: 3 }), day({ ms: 253_402_300_799_999, n: 0 }), day({ ms: 2 ** 53 - 1, n: 0 })]).toEqual(['1970-01-01', '2026-10-09', '9999-12-31', 'after-9999'])
  expect(log([ch(A, [2 ** 53 - 1, 0], { status: 'accepted' })], A)).toEqual([`${A} after-9999 ada via person: accepted`])
  // the record in full
  const head = [`${s(A)} decision!superseded Amounts are whole cents`, 'why: said again', 'refs: src/b.ts', `${A} superseded, by ada via person, 2026-10-07`, `replaced by ${s(B)} decision!proposed Amounts are minor units`]
  expect(detail(t, A).split('\n')).toEqual(head)
  expect(show(t, all, A).split('\n')).toEqual([...head, 'history:', ...mine.map(l => ` ${l}`)])
  expect(detail(t, C).split('\n')).toEqual([`${s(C)} area!proposed Money`, `${C} proposed, by ada via person, 2026-10-09`]) // its only child is dropped
  expect(detail(t, D).split('\n')).toEqual([`${s(D)} spec!dropped Kept`, `${D} dropped, by ada via person, 2026-10-09`, `under ${s(C)} area!proposed Money`])
  const orphan = tree(ch(D, [d(9), 4], { kind: 'spec', under: C, title: 'Kept' }), ch(D, [2 ** 53 - 1, 0], { title: 'Kept late' }))
  expect(detail(orphan, D).split('\n').slice(1)).toEqual([`${D} proposed, by ada via person, 2026-10-09`, `under ${C} (not here)`])
  expect(show(orphan, [], D)).toBe(`${detail(orphan, D)}\nhistory:`)
  // changes without a creation still have a history; nothing at all is nothing
  expect(show(t, all, E).split('\n')).toEqual([`${E} has changes but none that creates it: a file of the store is missing`, 'history:', ` ${s(E)} 2026-10-09 ada via person: title "no creation"`])
  expect([detail(t, E), detail(t, F), show(t, all, F), detail(t, s(A))]).toEqual(['', '', '', ''])
})

test('diff sets two folds side by side: what was added, dropped and changed, and "no difference" when nothing was', async () => {
  const then = [
    ch(A, [1, 0], { kind: 'decision', title: 'Amounts are integer cents', why: 'floats drift', refs: ['+src/a.ts', '+src/keep.ts'] }), ch(D, [2, 0], { kind: 'spec', title: 'Old rule', status: 'accepted', refs: ['+src/old.ts'] }),
    ch(E, [3, 0], { kind: 'area', title: 'Billing', status: 'accepted' }), ch(F, [4, 0], { kind: 'spec', title: 'Dropped long ago', status: 'dropped' }), ch(B, [5, 0], { kind: 'spec', title: 'Untouched', status: 'accepted' }),
  ]
  const since = [
    ch(A, [10, 0], { title: 'Amounts are whole cents', status: 'accepted', why: 'said again', refs: ['+src/b.ts', '-src/a.ts'] }), ch(D, [11, 0], { status: 'dropped' }), ch(G, [12, 0], { kind: 'spec', under: E, title: 'New rule' }),
    ch(H, [13, 0], { kind: 'spec', title: 'Made and dropped in between', status: 'dropped' }), ch(B, [14, 0], { title: 'Untouched', status: 'accepted' }), ch(F, [15, 0], { status: 'dropped' }), ch(C, [16, 0], { title: 'no creation' }),
  ]
  const before = tree(...then), after = tree(...then, ...since), s = (id: string) => short(after, id)
  const got = diff(before, after)
  expect(got.lines).toEqual([
    `+ ${s(G)} spec!proposed New rule`, `- ${s(D)} spec!dropped Old rule`,
    `~ ${s(A)} decision Amounts are whole cents: title "Amounts are integer cents" -> "Amounts are whole cents", proposed -> accepted, why, -src/a.ts +src/b.ts`,
  ])
  expect([got.added, got.dropped, got.changed, got.text]).toEqual([[G], [D], [A], got.lines.join('\n')])
  // read the other way, as a store rolled back: what is not there any more is gone, and a drop undone is a change
  expect(diff(after, before).lines).toEqual([
    `- ${s(G)} spec!proposed New rule (gone)`,
    `~ ${s(A)} decision!proposed Amounts are integer cents: title "Amounts are whole cents" -> "Amounts are integer cents", accepted -> proposed, why, +src/a.ts -src/b.ts`,
    `~ ${s(D)} spec Old rule: dropped -> accepted`,
  ])
  expect([diff(before, before), diff(after, tree(...shuffled([...since, ...then, ...then], dice(5)))), diff(empty(), empty())].map(x => [x.text, x.lines, x.added, x.dropped, x.changed])).toEqual(Array(3).fill(['no difference', [], [], [], []]))
  expect(diff(empty(), before).lines).toEqual([`+ ${s(A)} decision!proposed Amounts are integer cents`, `+ ${s(D)} spec Old rule`, `+ ${s(E)} area Billing`, `+ ${s(B)} spec Untouched`])
  // a replacement, a move and a change of kind are named; a stale mark is not a difference
  const moved = tree(...then, ch(G, [20, 0], { kind: 'decision', title: 'Amounts are minor units' }), ch(A, [21, 0], { status: 'superseded', replacedBy: G }), ch(B, [0, 1], { kind: 'decision', under: E }), ch(D, [22, 0], { refs: ['+src/**', '-src/old.ts', '+src/old.ts#f'] }))
  stale(moved, [])
  expect(diff(before, moved).lines).toEqual([
    `+ ${s(G)} decision!proposed Amounts are minor units`, `~ ${s(B)} decision Untouched: kind spec -> decision, moved under ${s(E)}`,
    `~ ${s(A)} decision!superseded Amounts are integer cents: proposed -> superseded, replaced by ${s(G)}`, `~ ${s(D)} spec Old rule: +src/** -src/old.ts +src/old.ts#f`,
  ])
  expect(diff(moved, before).lines.find(l => l.includes('Untouched'))).toBe(`~ ${s(B)} spec Untouched: kind decision -> spec, moved under the root`)
  // on any two sets of changes: no difference exactly when every record that is not dropped reads the same in both
  const rnd = dice(404), face = (t: Tree) => JSON.stringify([...t.nodes.keys()].sort().map(id => get(t, id)).filter(r => r && r.status !== 'dropped').map(r => [r!.id, r!.kind, r!.under, r!.title, r!.why, r!.status, r!.replacedBy, r!.refs]))
  let equal = 0
  for (let round = 0; round < 300; round++) {
    const one = Array.from({ length: 3 + rnd(25) }, () => wild(rnd, 5)), two = rnd(3) ? [...one, ...Array.from({ length: rnd(3) }, () => wild(rnd, 5))] : Array.from({ length: 3 + rnd(25) }, () => wild(rnd, 5))
    const x = tree(...one), y = tree(...shuffled(two, rnd)), d = diff(x, y), back = diff(y, x)
    expect([d.text === 'no difference', back.text === 'no difference']).toEqual([face(x) === face(y), face(x) === face(y)])
    // read the other way it names the same records: what was added is gone, and a drop undone is a change
    const ids = (z: typeof d) => [...z.added, ...z.dropped, ...z.changed].sort()
    expect([d.lines.length, ids(d), d.added.slice().sort()]).toEqual([ids(d).length, ids(back), back.dropped.filter(id => !get(x, id)).sort()])
    expect(diff(x, tree(...shuffled(two, rnd))).text).toBe(d.text) // and the same lines however the changes were read
    if (d.text === 'no difference') equal++
  }
  expect(equal > 20 && equal < 280).toBe(true)
})

test('the lists a hook needs are asked for by name: children and a walk in order, what is proposed, what is stale', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'First' }), ch(B, [2, 0], { kind: 'spec', under: A, title: 'Replaced', status: 'superseded', replacedBy: C, refs: ['+src/a.ts'] }),
    ch(D, [4, 0], { kind: 'decision', under: B, title: 'Under a replaced one', refs: ['+src/a.ts'], status: 'accepted' }), ch(C, [3, 0], { kind: 'decision', under: A, title: 'Second child', refs: ['+src/gone.ts'] }),
    ch(E, [5, 0], { kind: 'area', title: 'Dropped', status: 'dropped' }), ch(F, [6, 0], { kind: 'spec', under: E, title: 'Under a dropped one' }), ch(G, [7, 0], { kind: 'area', title: 'Last' }), ch(H, [8, 0], { title: 'no creation' }),
  )
  expect(children(t).map(r => r.id)).toEqual([A, G])
  expect(children(t, A).map(r => [r.id, r.status, r.live])).toEqual([[B, 'superseded', false], [C, 'proposed', true]])
  expect([children(t, C), children(t, 'zzzzzz'), children(t, H), children(empty())]).toEqual([[], [], [], []])
  expect(children(t, E).map(r => r.id)).toEqual([F]) // asked for by id, what is under a dropped record is still there
  expect([...walk(t)].map(w => [w.rec.id, w.depth])).toEqual([[A, 0], [B, 1], [D, 2], [C, 1], [G, 0]])
  expect([...walk(t, A)].map(w => [w.rec.id, w.depth])).toEqual([[B, 0], [D, 1], [C, 0]])
  expect([[...walk(t, 'zzzzzz')], [...walk(empty())]]).toEqual([[], []])
  // the same records, in the same order and at the same depths, as the outline prints
  const rnd = dice(31)
  for (let round = 0; round < 60; round++) {
    const w = fold(empty(), Array.from({ length: 10 + rnd(70) }, () => wild(rnd, 8)))
    expect([...walk(w)].map(x => ' '.repeat(x.depth) + short(w, x.rec.id))).toEqual(outline(w, { depth: 1e9, limit: 1e9 }).split('\n').filter(l => l).map(l => /^ *\S+/.exec(l)![0]))
    expect(proposed(w).sort()).toEqual([...w.nodes.keys()].filter(id => get(w, id)?.live && get(w, id)!.status === 'proposed').sort())
  }
  expect(proposed(t)).toEqual([A, C, G]) // oldest first; not the superseded, the accepted, or what a drop took with it
  expect([stales(t), stale(t, ['src/a.ts']), stales(t)]).toEqual([[], 1, [C]])
  expect([stale(t, []), stales(t)]).toEqual([2, [C, D]])
  // straight after a fold, with nothing else asked in between
  fold(t, [ch(C, [9, 0], { status: 'dropped' }), ch(IDS[20]!, [10, 0], { kind: 'spec', under: G, title: 'New' })])
  expect([fresh(t), fresh(t).listed.length, proposed(t), stales(t), children(t, G).map(r => r.id)]).toEqual([t, 5, [A, G, IDS[20]], [D], [IDS[20]]])
})

test('adds are checked as a batch: a parent by its key, no two alike, and whatever is handed in is a reason, never a throw', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Billing', refs: ['+src/billing/**'], status: 'accepted' }), ch(B, [2, 0], { kind: 'decision', under: A, title: 'Amounts are integer cents', why: 'w', refs: ['+src/billing/money.ts'], status: 'accepted' }),
    ch(C, [3, 0], { kind: 'decision', under: A, title: 'Totals are floats', why: 'w', refs: ['+src/billing/total.ts'] }),
  )
  const who = { writer: WRITERS[1], by: 'claude', via: 'agent claude-haiku' }, s = (id: string) => short(t, id), [I, J, K] = [IDS[20]!, IDS[21]!, IDS[22]!]
  const ok = { title: 'Refunds are idempotent', why: 'a retry must not pay twice', refs: ['src/pay/refund.ts'] }
  // anything at all may be handed in
  const junk = [undefined, null, 5, 'title', [], [ok], () => ok, {}, { title: 5 }, { title: null }, { ...ok, why: {} }, { ...ok, refs: 7 }, { ...ok, refs: [1] }, { ...ok, refs: ['a', null] }, { ...ok, kind: 3 }, { ...ok, under: [] }, { ...ok, replaces: 1 }, { ...ok, key: {} }]
  expect(refuseAll(t, junk)).toEqual([
    ...Array(7).fill('an add is an object: {title, why, refs}'), 'the title is empty', 'the title is not text', 'the title is empty', 'the why is not text', ...Array(3).fill('refs is a list of texts: files, globs or file#symbol'),
    'kind is one of area, spec, decision', 'under is not text: give the id of the parent', 'replaces is not text: give the id of the record it supersedes', 'key is not text',
  ])
  for (const raw of junk) {
    expect(refuse(t, raw as Add)).toBe(refuseAll(t, [raw])[0])
    expect([record(t, raw as Add, I, tick(t.clock, 9), who), typeof compose(t, [raw], [I], tick(t.clock, 9), who)]).toEqual([[], 'string'])
  }
  // null and "" are a field left out, and one reference may come as a text
  expect(refuseAll(t, [{ ...ok, refs: 'src/pay/refund.ts', kind: null, under: null, replaces: '', key: null }, { title: 'Payments', kind: 'area', why: null, refs: null }])).toEqual([undefined, undefined])
  expect(record(t, { ...ok, refs: 'src/pay/' } as unknown as Add, I, { ms: 9, n: 0 }, who)).toMatchObject([{ id: I, kind: 'decision', under: '', refs: ['+src/pay/**'] }])
  // a batch: an area, a record under it by the area's key, and a replacement, written as one run of stamps
  const batch = [{ title: 'Payments', kind: 'area', key: 'pay', refs: ['src/pay/'] }, { ...ok, under: 'pay' }, { title: 'Totals are summed in cents', why: 'floats drift', refs: ['src/billing/total.ts'], replaces: s(C) }]
  expect(refuseAll(t, batch)).toEqual([undefined, undefined, undefined])
  const made = compose(t, batch, [I, J, K], tick(t.clock, 1000), who) as Sound[]
  expect(made.map(c => [c.id, c.at, c.kind, c.under, c.status, c.replacedBy, c.by])).toEqual([
    [I, { ms: 1000, n: 0 }, 'area', '', 'proposed', undefined, 'claude'], [J, { ms: 1000, n: 1 }, 'decision', I, 'proposed', undefined, 'claude'],
    [K, { ms: 1000, n: 2 }, 'decision', A, 'proposed', undefined, 'claude'], [C, { ms: 1000, n: 3 }, undefined, undefined, 'superseded', K, 'claude'],
  ])
  expect(made.map(c => fromLine(toLine(c)))).toEqual(made)
  const after = fold(tree(...[...t.nodes.values()].map(n => n.made as Sound)), made)
  expect(outline(after, { depth: 9 }).split('\n').map(l => l.replace(/^( *)\S+ /, '$1'))).toEqual(['area Billing', ' decision Amounts are integer cents', ' decision!superseded Totals are floats', ' decision!proposed Totals are summed in cents', 'area!proposed Payments', ' decision!proposed Refunds are idempotent'])
  expect(diff(t, after).lines.map(l => l[0])).toEqual(['+', '+', '+', '~'])
  expect(after.clock).toEqual({ ms: 1000, n: 3 })
  // one add is a batch of one, and gives what record gives
  expect(compose(t, [ok], [I], tick(t.clock, 1000), who)).toEqual(record(t, ok, I, tick(t.clock, 1000), who))
  // what a batch is refused for
  const why = (...adds: unknown[]) => refuseAll(t, adds)
  expect(why(ok, { ...ok, title: 'refunds ARE  idempotent!', refs: ['src/other.ts'] })).toEqual([undefined, 'the same title as add[0] of this call'])
  expect(why({ ...ok, title: '' }, { ...ok }, { ...ok })).toEqual(['the title is empty', undefined, 'the same title as add[1] of this call'])
  expect(why({ ...batch[0], key: 'k' }, { ...ok, key: 'k' })).toEqual([undefined, `key "k" is add[0]'s too`])
  expect(why({ ...ok, key: s(A) }, { ...ok, title: 'Another', key: 'two words' }, { ...ok, title: 'Third', key: 'k'.repeat(41) })).toEqual([`key "${s(A)}" reads as the id of a record: pick another`, 'key is one word of at most 40 characters', 'key is one word of at most 40 characters'])
  expect(why({ ...ok, under: 'pay' }, batch[0])).toEqual(['under "pay" is add[1], which comes after this one: put the parent first', undefined])
  expect(why({ ...batch[0], under: 'pay' })).toEqual(['under "pay" is this add itself'])
  expect(why({ ...batch[0], title: 'Added payments' }, { ...ok, under: 'pay' }, { ...ok, title: 'Third', under: 'nokey' }).map(x => x?.replace(/, which says.*/, ''))).toEqual(['the title opens with "Added"', 'under "pay" is add[0], which is turned down', 'under "nokey" matches no record'])
  expect(why(batch[0], { ...ok, replaces: 'pay' })).toEqual([undefined, 'replaces "pay" is an add of this call: only a record already in the store is replaced'])
  expect(why(batch[2], { ...batch[2], title: 'Totals are integer sums' })).toEqual([undefined, `add[0] of this call replaces ${s(C)} already`])
  expect(why(batch[0], { ...ok, under: 'pay', title: 'amounts are integer cents', refs: ['src/billing/money.ts'] })).toEqual([undefined, `exists: ${s(B)} decision Amounts are integer cents`])
  // all or none, each add named, and the caller's own slips are reasons too
  const at = tick(t.clock, 1000)
  expect(compose(t, [batch[0], { ...ok, why: '' }, { title: 7 }], [I, J, K], at, who)).toBe('add[0] "Payments": fine\nadd[1] "Refunds are idempotent": a decision needs a why: the reason, and what was turned down\nadd[2] "": the title is not text')
  expect([compose(t, [], [], at, who), compose(t, [ok], [], at, who), compose(t, batch, [I, J, I], at, who)]).toEqual(['add is empty', '1 adds need 1 ids, no two alike', '3 adds need 3 ids, no two alike'])
  expect([compose(t, [ok], [A], at, who), compose(t, [ok], ['not an id'], at, who), compose(t, [ok], [I], { ms: -1, n: 0 }, who), compose(t, [ok], [I], at, { ...who, writer: 'me' })]).toEqual([
    `add[0]: the id ${A} is taken`, 'add[0] "Refunds are idempotent": "not an id" is not a record id', ...Array(2).fill('add[0] "Refunds are idempotent": the stamp or the writer is not one a change may carry'),
  ])
  expect(t.nodes.size).toBe(3) // nothing here folds
})

test('a store is folded a slice at a time to the tree one fold gives, and no slice is long', async () => {
  const rnd = dice(64)
  for (let round = 0; round < 60; round++) {
    const changes = Array.from({ length: 1 + rnd(120) }, () => wild(rnd)), want = dump(fold(empty(), changes)), t = empty(), size = 1 + rnd(40)
    let steps = 0
    for (let i = 0; i < changes.length; steps++) {
      const next = feed(t, changes, i, size)
      expect(next).toBe(Math.min(changes.length, i + size))
      if (rnd(3) === 0) outline(t), counts(t) // a question between slices
      i = next
    }
    expect([dump(t), steps]).toEqual([want, Math.ceil(changes.length / size)])
  }
  expect([feed(empty(), []), feed(empty(), [], 5), feed(empty(), [ch(A, [1, 0], { kind: 'area' })], 3), SLICE]).toEqual([0, 0, 1, 4000])
  // 100,000 records, a creation and a later change each, as two files that arrive out of order
  const N = 100_000, id = (i: number) => idOf(U8.of(i >>> 16, i >>> 8, i, 7, i >>> 3, i >>> 11, 1, 2)), base = { writer: WRITERS[0], by: 'ada', via: 'person' }
  const first: Sound[] = [], second: Sound[] = []
  for (let i = 0; i < N; i++) {
    const under = i < 100 ? '' : id(i % 100)
    first.push(clean({ ...base, id: id(i), at: { ms: 1000 + i, n: 0 }, kind: i < 100 ? 'area' : 'decision', under, title: `Rule ${i} holds`, why: 'because it must', status: 'proposed', refs: [`+src/m${i % 500}/f${i}.ts`] })!)
    second.push(clean({ ...base, id: id(i), at: { ms: 500_000 + i, n: 0 }, status: i % 7 ? 'accepted' : 'dropped' })!)
  }
  const t = empty()
  let slices = 0, longest = 0
  for (const file of [second, first])
    for (let i = 0; i < file.length; slices++) {
      const began = Date.now()
      i = feed(t, file, i)
      longest = Math.max(longest, Date.now() - began)
    }
  const began = Date.now(), c = counts(t), drawn = Date.now() - began
  expect([slices, t.nodes.size, t.clock, loose(t), missing(t)]).toEqual([50, N, { ms: 500_000 + N - 1, n: 0 }, [], []])
  // an area in seven is dropped and takes its thousand records with it
  const areas = Array.from({ length: 100 }, (_, i) => i).filter(i => i % 7), under = (i: number) => Array.from({ length: 999 }, (_, k) => 100 + i + 100 * k).filter(k => k % 7).length
  expect(c).toEqual({ live: areas.length + areas.reduce((sum, i) => sum + under(i), 0), proposed: 0, areas: areas.length, stale: 0 })
  expect([get(t, id(1234)), governing(t, 'src/m234/f1234.ts').map(r => r.id)]).toMatchObject([{ status: 'accepted', under: id(34), title: 'Rule 1234 holds' }, [id(1234)]])
  // far inside the five seconds after which a hook that has not awaited is unloaded
  expect([longest < 1000, drawn < 2000]).toEqual([true, true])
})

test('search takes plain text as it is, every word anywhere in the record, and narrows by kind and status', async () => {
  const t = tree(
    ch(A, [1, 0], { kind: 'area', title: 'Billing', status: 'accepted' }), ch(B, [2, 0], { kind: 'area', under: A, title: 'Money', status: 'accepted' }),
    ch(C, [3, 0], { kind: 'decision', under: B, title: 'Amounts are integer cents', why: 'floats drift', refs: ['+src/money.ts'], status: 'accepted' }),
    ch(D, [4, 0], { kind: 'spec', under: B, title: 'Rounding is half-even (a+)+$', why: 'the bank rounds this way', refs: ['+src/round.ts'] }),
    ch(E, [5, 0], { kind: 'decision', title: 'Dates are UTC', why: 'no drift across zones', refs: ['+src/time.ts'], status: 'superseded', replacedBy: F }),
    ch(F, [6, 0], { kind: 'decision', under: A, title: 'Invoices are immutable', why: 'audit', refs: ['+src/invoice/**'] }),
    ch(G, [7, 0], { kind: 'spec', under: A, title: 'Dropped drift rule', status: 'dropped' }),
  )
  const s = (id: string) => short(t, id), money = `# Billing > Money\n ${s(C)} decision Amounts are integer cents`
  expect(search(t, 'DRIFT')).toEqual(search(t, /drift/))
  expect(search(t, '  Cents   integer ')).toEqual({ hits: 1, text: money }) // any case, any order, any spacing
  expect(search(t, 'src/money.ts floats amounts')).toEqual({ hits: 1, text: money }) // across the title, the why and the references
  expect([search(t, 'integer dollars').hits, search(t, 'src/round').hits, search(t, '').hits, search(t, ' \n ').hits]).toEqual([0, 1, 0, 0])
  // what would be a pattern is only text: it finds itself and nothing else, and a long one costs nothing
  expect([search(t, '(a+)+$').text, search(t, '.*').hits, search(t, '[').hits, search(t, 'a|b').hits, search(t, '\\').hits]).toEqual([`# Billing > Money\n ${s(D)} spec!proposed Rounding is half-even (a+)+$`, 0, 0, 0, 0])
  const big = tree(ch(A, [1, 0], { kind: 'spec', title: 'x', why: 'a'.repeat(2000) }))
  expect([search(big, `${'(a+)+'.repeat(60)}$`).hits, search(big, 'a '.repeat(5000)).hits, search(big, 'a'.repeat(100_000)).hits, search(big, 'b'.repeat(100_000)).hits]).toEqual([0, 1, 1, 0]) // only the first 400 characters are read
  // by kind and by status, with or without text
  expect(search(t, '', { kind: 'area' })).toEqual({ hits: 2, text: `${s(A)} area +2 Billing\n# Billing\n ${s(B)} area +2 Money` })
  expect(search(t, '', { status: 'proposed' }).text).toBe(`# Billing > Money\n ${s(D)} spec!proposed Rounding is half-even (a+)+$\n# Billing\n ${s(F)} decision!proposed Invoices are immutable`)
  expect(search(t, 'drift', { kind: 'decision', status: 'accepted' })).toEqual({ hits: 1, text: money })
  expect([search(t, 'drift', { status: 'superseded' }).text, search(t, /drift/, { kind: 'spec' }).hits, search(t, /./, { kind: 'decision', limit: 1 }).hits]).toEqual([`${s(E)} decision!superseded Dates are UTC`, 0, 3])
  expect(search(t, /are/g, { limit: 2 })).toEqual(search(t, /are/g, 2))
  // a dropped record is found only when dropped ones are asked for
  expect([search(t, 'dropped drift').hits, search(t, 'drift', { status: 'dropped' })]).toEqual([0, { hits: 1, text: `# Billing\n ${s(G)} spec!dropped Dropped drift rule` }])
  expect([search(t, '', { status: 'stale' }).hits, stale(t, ['src/money.ts']), search(t, '', { status: 'stale' }).hits, search(t, 'audit', { status: 'stale' }).text]).toEqual([0, 2, 2, `# Billing\n ${s(F)} decision!stale Invoices are immutable`])
})

test('a dropped record does not make its parent missing, so dropping the orphan clears the store', async () => {
  const orphan = ch(B, [2, 0], { kind: 'spec', under: A, title: 'Rounding', why: 'w', refs: ['+src/a.ts'] }), ok = { title: 'Totals are summed in cents', why: 'w', refs: ['src/a.ts'] }
  const t = tree(orphan, ch(C, [3, 0], { kind: 'decision', under: B, title: 'Half even' }))
  expect([missing(t), orphans(t)]).toEqual([[A], [B]])
  expect(refuse(t, ok)).toMatch(/^the store is incomplete: .* or a person drops the record that names it \(\/spec status\)$/)
  fold(t, [ch(B, [4, 0], { status: 'dropped' })])
  expect([missing(t), orphans(t), refuse(t, ok)]).toEqual([[], [], undefined])
  // any later change brings the record back, and its parent is missed again
  fold(t, [ch(B, [5, 0], { title: 'Rounding is half-even' })])
  expect([missing(t), orphans(t)]).toEqual([[A], [B]])
})

test('diff takes a record hidden under a dropped one as dropped, and never as added', async () => {
  const base = [ch(A, [1, 0], { kind: 'area', title: 'Billing' }), ch(B, [2, 0], { kind: 'spec', under: A, title: 'Rounding' }), ch(C, [3, 0], { kind: 'decision', under: B, title: 'Half even' })]
  const drop = ch(A, [9, 0], { status: 'dropped' }), late = ch(D, [10, 0], { kind: 'spec', under: B, title: 'Made under a dropped record' })
  const before = tree(...base), after = tree(...base, drop, late)
  expect([hidden(before), hidden(after), hiddenUnder(after, C), hiddenUnder(after, A), hiddenUnder(before, C), hiddenUnder(after, E)]).toEqual([0, 3, A, undefined, undefined, undefined])
  const d = diff(before, after)
  expect([d.added, d.dropped, d.changed]).toEqual([[], [A, B, C], []])
  expect(d.lines).toEqual([`- ${short(after, A)} area!dropped Billing`, `- ${short(after, B)} spec!proposed Rounding (under a dropped record)`, `- ${short(after, C)} decision!proposed Half even (under a dropped record)`])
  expect(diff(empty(), after).text).toBe('no difference')
  // hidden in both is no difference; back in the lists, the hidden ones are added and the dropped one says what it was
  expect(diff(after, tree(...base, drop, late, ch(C, [11, 0], { title: 'Half-even' }))).text).toBe('no difference')
  const back = diff(after, tree(...base, drop, late, ch(A, [12, 0], { status: 'accepted' })))
  expect([back.added, back.dropped, back.changed]).toEqual([[B, C, D], [], [A]])
  expect(diff(before, tree(base[0]!, drop)).lines.slice(1)).toEqual([`- ${short(before, B)} spec!proposed Rounding (gone)`, `- ${short(before, C)} decision!proposed Half even (gone)`])
})
