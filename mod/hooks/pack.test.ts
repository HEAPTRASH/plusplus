import { expect, test } from 'claude-code/testing'
import { deflate, inflate } from './deflate'
import { MAGIC, batches, pack, unpack } from './pack'
import { type Change, KINDS, STATUSES, bytesOf, idOf } from './spec'

const imul = Math.imul, U8 = Uint8Array, enc = new TextEncoder(), BLOCK = 256 << 10

/** A seeded generator, so a failure is the same failure on every run. */
const dice = (a: number) => (n: number) => {
  a = (a + 0x6d2b79f5) | 0
  let x = imul(a ^ (a >>> 15), a | 1)
  x ^= x + imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) % n
}
const shuffled = <T>(xs: readonly T[], rnd: (n: number) => number): T[] => {
  const out = xs.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// The format written a second time, by the rules in pack.ts's comment and none of its code.
/** A varint, through BigInt where the module divides. */
const leb = (n: number): number[] => {
  const out: number[] = []
  let v = BigInt(n)
  for (; v >= 128n; v >>= 7n) out.push(Number(v & 127n) | 128)
  return [...out, Number(v)]
}
/** CRC-32 a bit at a time, where the module uses a table. */
const crc = (d: Uint8Array) => {
  let c = ~0
  for (const b of d) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]
const text = (s: string) => [leb(enc.encode(s).length), ...enc.encode(s)].flat()
/** One block as a pack frames it; the lengths and checksum it claims can be overridden to lie. */
const block = (raw: Uint8Array, claim: { size?: number; packed?: number; crc?: number } = {}): number[] => {
  const z = deflate(raw)
  return [...leb(claim.size ?? raw.length), ...leb(claim.packed ?? z.length), ...le(claim.crc ?? crc(raw)), ...z]
}
/** A pack of one block holding this payload. */
const seal = (payload: readonly number[], version = 1) => new U8([...MAGIC.subarray(0, 5), version, ...block(new U8(payload))])
/** A pack's blocks: the raw length each claims, and the payload they hold. */
const opened = (bytes: Uint8Array) => {
  const sizes: number[] = [], parts: number[] = []
  const int = () => {
    let v = 0, unit = 1
    for (; bytes[at]! >= 128; unit *= 128) v += (bytes[at++]! & 127) * unit
    return v + bytes[at++]! * unit
  }
  let at = 6
  while (at < bytes.length) {
    const size = int(), packed = int()
    sizes.push(size), parts.push(...inflate(bytes.subarray(at + 4, at + 4 + packed), size))
    at += 4 + packed
  }
  return { sizes, payload: parts }
}
const hex = (bytes: Iterable<number>) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

const W = '0a1b2c3d4e5f', W2 = 'ffffffffffff'
const A = idOf(new U8([0, 1, 2, 3, 4, 5, 6, 7])), B = idOf(new U8([255, 254, 253, 252, 251, 250, 249, 248])), C = idOf(new U8(8))
const ch = (id: string, at: [number, number], set: Partial<Change> = {}, writer = W): Change => ({ id, at: { ms: at[0], n: at[1] }, writer, by: 'ada', via: 'person', ...set })

/** A change as unpack should return it: what pack says it normalises, and nothing else. */
const canon = (c: Change): Change => {
  // code point by code point: a pair is one, half a pair is one on its own
  const fix = (s: string) => Array.from(s, ch => (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff' ? '\ufffd' : ch)).join('')
  const o: Change = { id: c.id, at: { ...c.at }, writer: c.writer, by: fix(c.by), via: fix(c.via) }
  if (c.kind !== undefined) o.kind = c.kind
  if (c.under !== undefined) o.under = c.under
  if (c.title !== undefined) o.title = fix(c.title)
  if (c.why !== undefined) o.why = fix(c.why)
  if (c.status !== undefined) o.status = c.status
  if (c.replacedBy) o.replacedBy = c.replacedBy
  if (c.refs?.length) o.refs = c.refs.map(fix)
  return o
}
const lines = (cs: readonly Change[]) => cs.map(c => JSON.stringify(c))
/** The distinct changes, as text, in an order of the test's own. */
const set = (cs: readonly Change[]) => [...new Set(lines(cs.map(canon)))].sort()

test('a pack is exactly the bytes its specification says', async () => {
  const first = ch(A, [1_700_000_000_000, 0], { kind: 'spec', under: '', title: 'Money is whole cents', why: 'Floats drift.', refs: ['+src/money.ts', '-src/old.ts'] })
  const second = ch(A, [1_700_000_000_300, 2], { status: 'superseded', replacedBy: B })
  const want = [
    [6], text('ada'), text('person'), text('Money is whole cents'), text('Floats drift.'), text('src/money.ts'), text('src/old.ts'),
    [1], [0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f], [0, 1],
    [2],
    [0, 1, 2, 3, 4, 5, 6, 7], leb(1_700_000_000_000), [0, 0], [6], [1, 1, 1], [2, 0], [3, 1, 2], [4, 1, 3], [6, 2, 43, 4], [6, 2, 45, 5],
    [0, 1, 2, 3, 4, 5, 6, 7], [0xac, 0x02], [2, 0], [1], [5, 9, 2, 255, 254, 253, 252, 251, 250, 249, 248],
  ].flat()
  const bytes = pack([second, first])
  expect(hex(bytes.subarray(0, 6))).toBe('414553500001')
  expect(hex(MAGIC)).toBe('414553500001')
  expect(hex(opened(bytes).payload)).toBe(hex(want))
  expect(hex(bytes)).toBe(hex(seal(want)))
  // the checksum is the one zlib and PNG use: Python's zlib.crc32 gave both of these
  expect(crc(enc.encode('123456789'))).toBe(0xcbf43926)
  expect(crc(new U8(want))).toBe(0xb7bdcebf)
  expect(hex(bytes.subarray(6, 14))).toBe(`8d01${hex(leb(bytes.length - 14))}bfcebdb7`)
  expect(unpack(bytes)).toEqual([first, second])
  // nothing at all is still a pack
  expect(hex(opened(pack([])).payload)).toBe('000000')
  expect(unpack(pack([]))).toEqual([])
})

test('every field comes back as it went in, set, empty or left out', async () => {
  const long = 'né — 設計 \u{1f600} '.repeat(200), odd = '\ufeffBOM first, a NUL \0, a quote " and a line\nbreak\t.'
  const all: Change[] = [
    ch(A, [0, 0], { kind: 'area', under: '', title: '' }),
    ch(B, [1, 0], { kind: 'spec', under: A, title: 'T', why: '' }),
    ch(C, [1, 1], { kind: 'decision', under: B, title: odd, why: long, status: 'proposed', refs: ['+a', '-a', '+', '-src/**', '+src/x.ts#f'] }),
    ch(A, [2 ** 32 - 1, 0], { title: 'x' }),
    ch(A, [2 ** 32, 2 ** 32], { why: 'y' }),
    ch(A, [2 ** 41 + 1, 7], { status: 'accepted' }),
    ch(A, [2 ** 41 + 1, 8], { status: 'superseded', replacedBy: C }),
    ch(A, [2 ** 41 + 1, 9], { status: 'dropped' }, W2),
    ch(A, [2 ** 41 + 2, 0], { under: B }),
    ch(A, [2 ** 41 + 2, 1], { kind: 'area' }),
    ch(A, [2 ** 41 + 2, 2]),
    ch(B, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], { refs: ['-gone'] }, W2),
    { ...ch(B, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], { refs: ['-gone'] }, W2), by: '', via: 'agent claude-opus-5-5' },
  ]
  expect(new Set(all.map(c => c.kind)).size).toBe(KINDS.length + 1)
  expect(new Set(all.map(c => c.status)).size).toBe(STATUSES.length + 1)
  const back = unpack(pack(all)), want = [...all.slice(0, -2), all.at(-1)!, all.at(-2)!] // one stamp, writer and id: the other fields decide, "" before "ada"
  expect(back).toEqual(want)
  expect(lines(back)).toEqual(lines(want.map(canon))) // keys in the text form's order too
  expect(unpack(pack(back))).toEqual(back)
})

test('what pack normalises: no replacedBy for "", no refs for none, U+FFFD for half a pair', async () => {
  const bare = ch(A, [5, 0], { status: 'superseded' }), empty = ch(A, [5, 0], { status: 'superseded', replacedBy: '' })
  expect(hex(pack([empty]))).toBe(hex(pack([bare])))
  expect(unpack(pack([empty]))).toEqual([bare])
  expect('replacedBy' in unpack(pack([empty]))[0]!).toBe(false)
  expect(unpack(pack([ch(A, [5, 0], { title: 't', refs: [] })]))).toEqual([ch(A, [5, 0], { title: 't' })])
  expect(unpack(pack([ch(A, [5, 0], { title: 'a\ud800b', why: '\udc00', refs: ['+x\udfff'] })]))).toEqual([ch(A, [5, 0], { title: 'a\ufffdb', why: '\ufffd', refs: ['+x\ufffd'] })])
  expect(unpack(pack([ch(A, [5, 0], { title: 'whole \ud83d\ude00' })]))[0]!.title).toBe('whole \u{1f600}')
  for (const [half, made] of [['\ud800\uffff', '\ufffd\uffff'], ['\ud800\ue000', '\ufffd\ue000'], ['\ud800\ud800\udc00', '\ufffd\u{10000}'], ['\udc00\ud800', '\ufffd\ufffd'], ['\ud800', '\ufffd']] as const) {
    expect(unpack(pack([ch(A, [5, 0], { title: half })]))[0]!.title, JSON.stringify(half)).toBe(made)
    expect(hex(pack([ch(A, [5, 0], { title: half }), ch(A, [5, 0], { title: made })])), JSON.stringify(half)).toBe(hex(pack([ch(A, [5, 0], { title: made })])))
  }
  expect(unpack(pack([{ ...ch(A, [5, 0], { title: 't' }), extra: 1 } as Change]))).toEqual([ch(A, [5, 0], { title: 't' })])
})

test('the same changes give the same bytes in any order, and equal changes are stored once', async () => {
  const rnd = dice(11)
  const cs = Array.from({ length: 60 }, (_, i) => ch([A, B, C][i % 3]!, [1000 + (i >> 2), i % 2], { title: `title ${i % 7}`, refs: [`+src/${i % 5}.ts`] }, i % 4 ? W : W2))
  const bytes = pack(cs)
  for (let round = 0; round < 20; round++) expect(hex(pack(shuffled(cs, rnd)))).toBe(hex(bytes))
  expect(hex(pack([...cs, ...cs.map(c => ({ ...c, at: { ...c.at }, refs: [...c.refs!] })), cs[0]!]))).toBe(hex(bytes))
  const back = unpack(bytes)
  expect(set(back)).toEqual(set(cs))
  expect(back.length).toBe(new Set(lines(cs)).size)
  // sorted by stamp, then writer, then id
  for (let i = 1; i < back.length; i++) {
    const p = back[i - 1]!, q = back[i]!
    expect(p.at.ms < q.at.ms || (p.at.ms === q.at.ms && (p.at.n < q.at.n || (p.at.n === q.at.n && (p.writer < q.writer || (p.writer === q.writer && p.id <= q.id)))))).toBe(true)
  }
  // changes that differ in one field only are both kept
  expect(unpack(pack([ch(A, [1, 0], { title: 'a' }), ch(A, [1, 0], { title: 'b' }), ch(A, [1, 0], { title: 'a' })])).length).toBe(2)
  expect(unpack(pack([ch(A, [1, 0], { title: 'a' }), { ...ch(A, [1, 0], { title: 'a' }), via: 'agent' }])).length).toBe(2)
})

test('pack refuses a change it could not read back', async () => {
  const good = ch(A, [1, 0], { title: 't' })
  const bad: [Partial<Record<keyof Change, unknown>>, RegExp][] = [
    [{ id: 'short' }, /change 1 has an id that is not one: "short"/],
    [{ id: 'qaaaaaaaaaaaa' }, /an id that is not one/], // 13 characters, but the first carries only four bits
    [{ id: A.toUpperCase() }, /an id that is not one/],
    [{ id: 7 }, /an id that is not one/],
    [{ writer: '0A1B2C3D4E5F' }, /a writer that is not 12 hex/],
    [{ writer: '0a1b2c3d4e5' }, /a writer that is not 12 hex/],
    [{ writer: '0a1b2c3d4e5f0' }, /a writer that is not 12 hex/],
    [{ at: { ms: -1, n: 0 } }, /a stamp that is not/],
    [{ at: { ms: 1.5, n: 0 } }, /a stamp that is not/],
    [{ at: { ms: 1, n: 2 ** 53 } }, /a stamp that is not/],
    [{ at: [1, 0] }, /a stamp that is not/],
    [{ by: undefined }, /by or via/],
    [{ kind: 'note' }, /a kind off the list/],
    [{ under: 'nowhere' }, /under an id that is not one/],
    [{ title: 7 }, /a title that is not text/],
    [{ why: null }, /a why that is not text/],
    [{ status: 'done' }, /a status off the list/],
    [{ status: 'superseded', replacedBy: 'x' }, /replaced by an id that is not one/],
    [{ replacedBy: B }, /a replacedBy and no status/],
    [{ refs: 'src' }, /refs that are not a list/],
    [{ refs: ['+ok', 'src/x.ts'] }, /a ref that does not open with \+ or -: "src\/x.ts"/],
    [{ refs: ['+ok', ''] }, /a ref that does not open/],
  ]
  for (const [set, why] of bad) {
    expect(() => pack([good, { ...good, ...set } as Change]), JSON.stringify(set)).toThrow(why)
    expect(() => batches([good, { ...good, ...set } as Change]), JSON.stringify(set)).toThrow(why)
  }
  expect(() => pack([null as unknown as Change])).toThrow(/change 0 is not a change/)
  expect(() => pack([ch(A, [1, 0], { why: 'x'.repeat(5 << 20) })])).toThrow(/more than the 4194304 one pack holds; cut them with batches/)
})

// One change, piece by piece, for the packs the tests below build by hand.
const ID = [0, 1, 2, 3, 4, 5, 6, 7], TABLES = [[2], text('ada'), text('person'), [1], [0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f], [0, 1]].flat()
const HEAD = [...TABLES, 1, ...ID, 9, 0, 0]
const made = (fields: number[][], strings = HEAD) => seal([...strings, fields.length, ...fields.flat()])

test('a field of an unknown tag is skipped by its length, wherever it sits', async () => {
  expect(unpack(made([[1, 1, 2]]))).toEqual([ch(A, [9, 0], { kind: 'decision' })])
  expect(unpack(made([[7, 3, 9, 9, 9], [1, 1, 2], [...leb(200), 1, 0], [3, 1, 0], [0, 0], [...leb(2 ** 40), 2, 1, 2]]))).toEqual([ch(A, [9, 0], { kind: 'decision', title: 'ada' })])
  // and fields are taken in any order
  expect(lines(unpack(made([[6, 2, 45, 1], [5, 1, 1], [3, 1, 0], [6, 2, 43, 0], [2, 0], [1, 1, 0]])))).toEqual(
    lines([ch(A, [9, 0], { kind: 'area', under: '', title: 'ada', status: 'accepted', refs: ['-person', '+ada'] })]))
})

test('bytes that are not a sound pack of a version it knows are refused, each for its reason', async () => {
  const good = pack([ch(A, [9, 0], { kind: 'spec', under: '', title: 'A title', why: 'A reason.', refs: ['+src/a.ts'] }), ch(A, [10, 0], { status: 'superseded', replacedBy: B })])
  const but = (at: number, b: number) => good.map((x, i) => (i === at ? b : x))
  expect(() => unpack(new U8(0))).toThrow(/^pack: not a pack/)
  expect(() => unpack(enc.encode('{"id":"x"}\n'))).toThrow(/^pack: not a pack/)
  for (let i = 0; i < 5; i++) expect(() => unpack(but(i, good[i]! ^ 32))).toThrow(/^pack: not a pack/)
  expect(() => unpack(but(5, 0))).toThrow(/^pack: not a pack/)
  expect(() => unpack(but(5, 2))).toThrow(/^pack: version 2 is newer than this reader, which reads up to 1/)
  expect(() => unpack(but(5, 255))).toThrow(/version 255 is newer/)
  // cut short at every length
  for (let n = 0; n < good.length; n++) expect(() => unpack(good.subarray(0, n)), `${n} bytes of ${good.length}`).toThrow(/^pack: /)
  expect(() => unpack(new U8([...good, 0]))).toThrow(/^pack: /)
  // every bit, flipped: refused, or the same changes, where the bit is one DEFLATE leaves unread; in this pack, of a
  // single fixed-code block, those are all in the last byte
  const want = lines(unpack(good))
  let same = 0
  for (let bit = 0; bit < good.length * 8; bit++) {
    const flipped = but(bit >> 3, good[bit >> 3]! ^ (1 << (bit & 7)))
    let got: Change[] | undefined
    try {
      got = unpack(flipped)
    } catch (e) {
      expect(String(e), `bit ${bit}`).toMatch(/^Error: pack: /)
    }
    if (got) expect(lines(got), `bit ${bit}`).toEqual(want), expect(bit >> 3, `bit ${bit}`).toBe(good.length - 1), same++
  }
  expect(same < 8).toBe(true)
  const raw = new U8(opened(good).payload), M = [...MAGIC]
  expect(() => unpack(new U8([...M, ...block(raw, { crc: crc(raw) ^ 1 })]))).toThrow(/block 0 fails its checksum/)
  expect(() => unpack(new U8([...M, ...block(raw, { size: raw.length + 1 })]))).toThrow(/block 0 holds \d+ bytes and says \d+/)
  expect(() => unpack(new U8([...M, ...block(raw, { size: raw.length - 1 })]))).toThrow(/block 0 is damaged \(inflate: /)
  expect(() => unpack(new U8([...M, ...block(raw, { size: 0 })]))).toThrow(/a block holds 1 to 262144/)
  expect(() => unpack(new U8([...M, ...block(raw, { size: BLOCK + 1 })]))).toThrow(/a block holds 1 to 262144/)
  expect(() => unpack(new U8([...M, ...block(raw, { packed: 2 ** 31 })]))).toThrow(/too many for the/)
  expect(() => unpack(new U8([...M, ...block(raw, { size: 2 ** 53 })]))).toThrow(/a number that is padded, over eight bytes or past 2\^53/)
  expect(() => unpack(new U8([...M, 0x80 | raw.length, 0, ...block(raw).slice(1)]))).toThrow(/a number that is padded/)
  expect(() => unpack(new U8([...M, ...block(raw.subarray(0, 20)), ...block(raw.subarray(20))]))).toThrow(/block 1 follows one that is not full/)
  expect(() => unpack(new U8([...M, ...block(raw), ...block(raw)]))).toThrow(/block 1 follows one that is not full/)
  const full = block(new U8(BLOCK))
  expect(() => unpack(new U8([...M, ...Array.from({ length: 17 }, () => full).flat()]))).toThrow(/more than 16 blocks/)
})

test('a payload that lies about what it holds is refused before anything is set aside for it', async () => {
  const big = leb(2 ** 40)
  expect(() => unpack(seal([...big, 0, 0]))).toThrow(/1099511627776 strings cannot fit in the 2 bytes left/)
  expect(() => unpack(seal([1, ...big, 65]))).toThrow(/cut short/)
  expect(() => unpack(seal([0, ...big]))).toThrow(/writers cannot fit/)
  expect(() => unpack(seal([0, 0, ...big]))).toThrow(/changes cannot fit/)
  expect(() => unpack(seal([0, 0, 2, ...new Array<number>(23).fill(0)]))).toThrow(/2 changes cannot fit in the 23 bytes left/)
  expect(() => unpack(seal([...HEAD, ...big]))).toThrow(/fields cannot fit/)
  expect(() => unpack(made([[3, ...big, 0]]))).toThrow(/cut short/)
  expect(() => unpack(seal([0, 0, 0, 0]))).toThrow(/1 bytes after the last change/)
  expect(() => unpack(seal([0, 0]))).toThrow(/cut short/)
  expect(() => unpack(seal([1, 2, 0xc3, 0x28, 0, 0]))).toThrow(/string 0 is not UTF-8/)
  expect(() => unpack(seal([1, 3, 0xed, 0xa0, 0x80, 0, 0]))).toThrow(/string 0 is not UTF-8/) // half a pair, written out
  expect(() => unpack(seal([1, 1, 65, 1, 1, 2, 3, 4, 5, 6, 0, 1, 0]))).toThrow(/a string index past the table/)
  expect(() => unpack(seal([...HEAD.slice(0, -1), 1, 0]))).toThrow(/change 0 names a writer past the table/)
  expect(() => unpack(seal([...TABLES, 2, ...ID, ...leb(2 ** 52), 0, 0, 0, ...ID, ...leb(2 ** 52), 0, 0, 0]))).toThrow(/change 1 is stamped past 2\^53/)
  expect(unpack(seal([...TABLES, 2, ...ID, ...leb(2 ** 52), 0, 0, 0, ...ID, ...leb(2 ** 52 - 1), 0, 0, 0]))[1]!.at.ms).toBe(Number.MAX_SAFE_INTEGER)
  expect(() => unpack(made([[1, 1, 3]]))).toThrow(/change 0 has a field 1 that is not one/)
  expect(() => unpack(made([[1, 2, 0, 0]]))).toThrow(/a field 1 that is not one/)
  expect(() => unpack(made([[1, 0]]))).toThrow(/cut short/)
  expect(() => unpack(made([[2, 7, 1, 2, 3, 4, 5, 6, 7]]))).toThrow(/cut short/)
  expect(() => unpack(made([[2, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9]]))).toThrow(/a field 2 that is not one/)
  expect(() => unpack(made([[3, 1, 2]]))).toThrow(/a string index past the table/)
  expect(() => unpack(made([[3, 2, 0, 0]]))).toThrow(/a field 3 that is not one/)
  expect(() => unpack(made([[5, 1, 4]]))).toThrow(/a field 5 that is not one/)
  expect(() => unpack(made([[5, 5, 2, 1, 2, 3, 4]]))).toThrow(/cut short/)
  expect(() => unpack(made([[6, 2, 42, 0]]))).toThrow(/a ref that is neither added nor removed/)
  expect(() => unpack(made([[3, 1, 0], [3, 1, 1]]))).toThrow(/change 0 gives field 3 twice/)
  expect(() => unpack(made([[5, 1, 0], [1, 1, 0], [5, 1, 1]]))).toThrow(/gives field 5 twice/)
  expect(unpack(made([[6, 2, 43, 0], [6, 2, 43, 0]]))[0]!.refs).toEqual(['+ada', '+ada'])
})

const WORDS = ['money', 'is', 'whole', 'cents', 'the', 'router', 'never', 'moves', 'a', 'thread', 'up', 'ids', 'are', 'minted', 'above', '設計', 'naïve', '\u{1f600}', '\ufeff', '\uffff', '"', '\\', '\n', '\0', '§', '\ud800', '\udc00']
/** A random change that pack accepts: any field set or not, text of any length and script, stamps at the edges of 32, 41 and 53 bits. */
const random = (rnd: (n: number) => number): Change => {
  const id = () => idOf(U8.from({ length: 8 }, () => (rnd(4) ? rnd(256) : rnd(2) * 255)))
  const words = (most: number) => Array.from({ length: rnd(most + 1) }, () => WORDS[rnd(WORDS.length)]!).join(rnd(8) ? ' ' : '')
  const edge = [0, 2 ** 32, 2 ** 41, 2 ** 53 - 40][rnd(4)]!
  const c: Change = {
    id: id(), at: { ms: edge + rnd(40) - (edge && rnd(2) ? 20 : 0), n: rnd(3) ? rnd(4) : rnd(2 ** 31) * 2 ** 21 },
    writer: [W, W2, '000000000000', '00000000000a'][rnd(4)]!, by: ['ada', 'grace', ''][rnd(3)]!, via: ['person', 'agent claude-opus-5-5'][rnd(2)]!,
  }
  if (rnd(3) === 0) c.kind = KINDS[rnd(3)]
  if (rnd(3) === 0) c.under = rnd(2) ? id() : ''
  if (rnd(2)) c.title = words(8)
  if (rnd(3) === 0) c.why = words(rnd(10) ? 30 : 400)
  if (rnd(3) === 0) c.status = STATUSES[rnd(4)]
  if (c.status && rnd(2)) c.replacedBy = rnd(3) ? id() : ''
  if (rnd(3) === 0) c.refs = Array.from({ length: rnd(10) ? rnd(4) : rnd(40) }, () => '+-'[rnd(2)] + ['src/', 'src/hooks/', ''][rnd(3)]! + words(2))
  return c
}

test('four hundred random sets of changes come back whole, sorted, and the same from any order', async () => {
  const rnd = dice(2026)
  for (let round = 0; round < 400; round++) {
    const cs = Array.from({ length: rnd(4) ? rnd(12) : rnd(120) }, () => random(rnd))
    for (let k = rnd(4); k > 0 && cs.length; k--) cs.push({ ...cs[rnd(cs.length)]! }) // some of them twice
    const bytes = pack(cs), back = unpack(bytes)
    expect(set(back), `round ${round}`).toEqual(set(cs))
    expect(back.length, `round ${round}`).toBe(set(cs).length)
    expect(back.every(c => bytesOf(c.id) && /^[0-9a-f]{12}$/.test(c.writer)), `round ${round}`).toBe(true)
    expect(hex(pack(shuffled(cs, rnd))), `round ${round}`).toBe(hex(bytes))
    expect(hex(pack(back)), `round ${round}`).toBe(hex(bytes))
  }
})

test('a payload past one block is cut into full blocks and read back', async () => {
  const rnd = dice(5)
  const cs = Array.from({ length: 300 }, (_, i) => ch(A, [i, 0], { why: Array.from({ length: 300 }, () => WORDS[rnd(15)]! + rnd(1000)).join(' ') }))
  const bytes = pack(cs), { sizes } = opened(bytes)
  expect(sizes.length > 2).toBe(true)
  expect(sizes.slice(0, -1).every(s => s === BLOCK)).toBe(true)
  expect(sizes.at(-1)! >= 1 && sizes.at(-1)! <= BLOCK).toBe(true)
  expect(unpack(bytes)).toEqual(cs)
  expect(() => unpack(bytes.subarray(0, bytes.length - 40))).toThrow(/^pack: /)
})

test('batches keeps every change once, under the limit, cut the same way from any order', async () => {
  const rnd = dice(77)
  const cs = Array.from({ length: 1500 }, () => random(rnd))
  const twice = [...cs, ...cs.slice(0, 100).map(c => ({ ...c }))]
  for (const limit of [4096, 20_000, BLOCK]) {
    const groups = batches(twice, limit)
    expect(set(groups.flat())).toEqual(set(cs))
    expect(groups.flat().length).toBe(set(cs).length)
    const own = new Set(twice)
    expect(groups.flat().every(c => own.has(c))).toBe(true) // the caller's own objects
    const sizes = groups.map(g => opened(pack(g)).payload.length)
    // under the limit, and not far under it: only the last group may be small, bar a change too big to share one
    sizes.forEach((s, i) => expect(s <= limit || groups[i]!.length === 1, `group ${i} of limit ${limit} is ${s}`).toBe(true))
    sizes.slice(0, -1).forEach((s, i) => expect(s > limit * 0.75 || opened(pack([...groups[i]!, groups[i + 1]![0]!])).payload.length > limit * 0.9, `group ${i} of limit ${limit} is ${s}`).toBe(true))
    expect(lines(batches(shuffled(twice, rnd), limit).flat())).toEqual(lines(groups.flat()))
    expect(batches(shuffled(twice, rnd), limit).map(g => g.length)).toEqual(groups.map(g => g.length))
    // the groups together are the changes
    expect(set(groups.flatMap(g => unpack(pack(g))))).toEqual(set(cs))
  }
  expect(batches([])).toEqual([])
  const huge = ch(A, [1, 0], { why: 'x'.repeat(10_000) })
  expect(batches([ch(A, [0, 0], { title: 'a' }), huge, ch(A, [2, 0], { title: 'b' })], 1000).map(g => g.length)).toEqual([1, 1, 1])
})
