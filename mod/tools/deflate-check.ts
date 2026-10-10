// Cross-checks hooks/deflate.ts against real zlib, both ways, then throws corrupt streams at inflate and times it.
// Development only: it needs bun, node:zlib and the file system (the tests the plugin kit runs are hooks/deflate.test.ts).
//   bun tools/deflate-check.ts [text files or folders ...]   the whole check; exits 1 on any failure
//   bun tools/deflate-check.ts --vectors                     the streams hooks/deflate.test.ts embeds, to paste there
// The text (prose, source and JSON, told apart by file extension) is this repository's unless paths are given.
// python3, when there is one, is the second referee: its zlib is the stock one, where bun's is a fork. The vectors
// are python's zlib's, so --vectors needs it.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { deflate, inflate } from '../hooks/deflate.ts'

const Z = zlib.constants, enc = new TextEncoder(), MiB = 1 << 20
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
const times = (x: Uint8Array, k: number) => cat(...new Array<Uint8Array>(k).fill(x))
const hex = (x: Uint8Array) => Buffer.from(x.subarray(0, 20)).toString('hex') + (x.length > 20 ? '...' : '')
const sha = (x: Uint8Array) => createHash('sha256').update(x).digest('hex')
const tried = <T>(f: () => T): T | Error => { try { return f() } catch (e) { return e instanceof Error ? e : new Error(String(e)) } }
const timed = (f: () => unknown, reps = 5) => { let best = Infinity; for (let r = 0; r < reps; r++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t) } return best }
const rate = (bytes: number, ms: number) => `${(bytes / MiB / (ms / 1000)).toFixed(1)} MiB/s`

let checks = 0
const failed: string[] = []
const check = (ok: boolean, what: string) => { checks++; if (!ok) failed.push(what.slice(0, 300)) }
/** Checks that `f` gives exactly `want`. */
const gives = (f: () => Uint8Array, want: Uint8Array, what: string) => { const r = tried(f); check(!(r instanceof Error) && same(r, want), `${what}${r instanceof Error ? `: ${r.message}` : ''}`) }

/** Random numbers from a seed (mulberry32), so a run that fails can be had again. */
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const rnd = rng(20261009), ri = (k: number) => Math.floor(rnd() * k), pick = <T>(of: readonly T[]) => of[ri(of.length)]!
const noise = (n: number, alphabet = 256) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = ri(alphabet); return a }

// ---- inputs ----

/** Bytes with what LZ77 looks for: stretches of fresh bytes, and copies of earlier ones at every distance and length. */
function woven(n: number, alphabet: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n;) {
    if (!i || rnd() < 0.3) { for (let k = 1 + ri(12); k > 0 && i < n; k--) a[i++] = ri(alphabet); continue }
    const dist = 1 + ri(Math.min(i, pick([1, 4, 300, 32768, 40000])))
    for (let k = pick([3, 4, 5, 8, 20, 257, 258, 259, 600]); k > 0 && i < n; k--, i++) a[i] = a[i - dist]!
  }
  return a
}

/**
 * `symbols` byte values, `gap` apart, whose counts grow by `ratio` until there are `most` bytes, shuffled by `seed`:
 * lopsided enough for Huffman trees deeper than the format allows. hooks/deflate.test.ts has the same function, and
 * with the arguments in LIMITS the same bytes.
 */
function skewed(symbols: number, ratio: number, most: number, seed: number, gap = 1): Uint8Array {
  const rnd = rng(seed), out: number[] = []
  for (let s = 0, f = 1; s < symbols && out.length < most; s++, f *= ratio) for (let k = Math.ceil(f); k > 0 && out.length < most; k--) out.push(s * gap)
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = out[i]!; out[i] = out[j]!; out[j] = t }
  return Uint8Array.from(out)
}
/** Random bytes in which no three in a row come twice: nothing for deflate to match, so one token a byte. */
function unrepeated(n: number, rnd = rng(3)): Uint8Array {
  const a = new Uint8Array(n), seen = new Set<number>()
  for (let i = 0, three = 0; i < n; i++, seen.add(three)) do three = (a[i - 2]! << 16) | (a[i - 1]! << 8) | (a[i] = rnd() * 256); while (seen.has(three))
  return a
}
/** The inputs the test file relies on to reach deflate's two length limits: 15 bits for a code, 7 for the code-length code. */
const LIMITS = { 15: 'skewed(30, 3, 400000, 9)', 7: 'skewed(127, 1.08, 6000, 2, 2)' }

/** The text of one kind under the paths given, 4 MiB at most. */
function corpus(roots: string[], kind: RegExp): Uint8Array {
  const parts: Uint8Array[] = []
  let size = 0
  const walk = (p: string) => {
    const st = tried(() => statSync(p))
    if (st instanceof Error || size >= 4 * MiB) return
    if (st.isDirectory()) { if (!/^(\.git|node_modules|__pycache__)$/.test(p.split('/').at(-1)!)) for (const e of readdirSync(p).sort()) walk(join(p, e)) }
    else if (kind.test(p) && st.size < MiB) { const b = readFileSync(p).subarray(0, 4 * MiB - size); parts.push(b); size += b.length }
  }
  roots.forEach(walk)
  return cat(...parts)
}

/** Records as a tracker would keep them, as JSON. */
const records = (n: number) => enc.encode(JSON.stringify(Array.from({ length: n }, (_, i) => ({
  id: `r${((i * 2654435761) >>> 0).toString(32)}`, at: { ms: 1760000000000 + i * 977, n: i % 7 }, kind: pick(['area', 'spec', 'decision']), status: pick(['proposed', 'accepted', 'superseded', 'dropped']),
  title: `The ${pick(['parser', 'router', 'store', 'cache', 'index'])} must ${pick(['keep', 'refuse', 'log', 'retry'])} ${pick(['every', 'no', 'each failed', 'the first'])} ${pick(['edit', 'request', 'record', 'write'])}`, refs: [`+src/${pick(['core', 'router', 'spec'])}.ts#${pick(['apply', 'route', 'fold'])}`],
}))))

function inputs(prose: Uint8Array, source: Uint8Array, json: Uint8Array): [string, Uint8Array][] {
  const all: [string, Uint8Array][] = [['empty', new Uint8Array(0)], ['every byte value', Uint8Array.from({ length: 256 }, (_, i) => i)], ['every byte value, 40 times, descending', Uint8Array.from({ length: 256 * 40 }, (_, i) => 255 - (i & 255))]]
  const add = (name: string, x: Uint8Array) => all.push([name, x])
  for (let b = 0; b < 256; b++) add(`the byte ${b}`, Uint8Array.of(b))
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 257, 258, 259, 260, 261, 262, 514, 515, 516, 517, 518, 1000, 65535, 65536, 65537]) add(`a run of ${n}`, new Uint8Array(n).fill(97))
  add('1 MiB of zeros', new Uint8Array(MiB)); add('1 MiB of 0xFF', new Uint8Array(MiB).fill(255)); add('3 MiB of zeros', new Uint8Array(3 * MiB))
  for (const n of [65535, 65536, 131073, MiB, MiB + 1]) add(`${n} random bytes`, noise(n))
  for (const d of [1, 2, 3, 4, 258, 32767, 32768, 32769, 65536]) add(`a block repeated at distance ${d}`, cat(times(noise(d), 3), noise(d).subarray(0, d >> 1)))
  // a copy of exactly `len` bytes from far back, then a byte that ends it
  for (const len of [3, 4, 257, 258, 259, 260, 516, 517]) {
    const base = noise(3000), parts = [base]
    for (let k = 0; k < 200; k++) { const at = ri(3000 - len - 1); parts.push(base.subarray(at, at + len), Uint8Array.of(base[at + len]! ^ 1), noise(ri(4))) }
    add(`matches of length ${len}`, cat(...parts))
  }
  for (const [kind, text] of [['prose', prose], ['source', source], ['JSON', json], ['JSON records', records(12000)]] as const) {
    if (!text.length) continue
    add(`${kind}, all ${text.length} bytes`, text); add(`${kind}, the first MiB`, text.subarray(0, MiB))
    for (let k = 0; k < 80; k++) { const n = ri(Math.min(text.length, k < 70 ? 70_000 : 400_000)), at = ri(text.length - n); add(`${kind} ${at}+${n}`, text.subarray(at, at + n)) }
  }
  for (const [symbols, ratio, most, gap] of [[30, 3, 400000, 1], [20, 3.2, 400000, 1], [40, 1.6, 400000, 5], [60, 1.3, 400000, 1], [30, 2, 400000, 1], [24, 1.62, 3000, 5], [127, 1.08, 6000, 2], [120, 1.1, 8000, 2]] as const)
    for (let seed = 1; seed <= (most > 8000 && symbols !== 30 ? 6 : 10); seed++) add(`skewed(${symbols}, ${ratio}, ${most}, ${seed}${gap > 1 ? `, ${gap}` : ''})`, skewed(symbols, ratio, most, seed, gap))
  for (let k = 0; k < 1500; k++) { const n = ri(k < 1400 ? 1500 : 100_000), alphabet = pick([1, 2, 3, 4, 16, 64, 256]); add(`fuzz ${k}: ${n} bytes of ${alphabet} values`, noise(n, alphabet)) }
  for (let k = 0; k < 500; k++) { const n = ri(k < 450 ? 5000 : 300_000), alphabet = pick([2, 4, 26, 256]); add(`woven ${k}: ${n} bytes of ${alphabet} values`, woven(n, alphabet)) }
  for (const alphabet of [2, 3, 4, 16]) add(`1 MiB of ${alphabet} values`, noise(MiB, alphabet))
  for (const n of [16383, 16384, 16385, 32768]) add(`${n} bytes with no three in a row twice`, unrepeated(n))
  return all
}

// ---- streams put together by hand ----

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
const bin = (v: number, k: number) => v.toString(2).padStart(k, '0')
/** Canonical codes for these lengths, as strings of bits in the order the stream carries them. */
const canon = (lens: number[]) => { const out: string[] = []; for (let l = 1, code = 0; l <= 15; l++, code <<= 1) lens.forEach((x, s) => { if (x === l) out[s] = bin(code++, l) }); return out }
/** `n` code lengths, zero but for the ones given. */
const lens = (n: number, given: Record<number, number>) => { const a = new Array<number>(n).fill(0); for (const s in given) a[s] = given[s]!; return a }
const FIX = canon(Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8)))

let pending: number[] = []
/** Appends the low k bits of v, lowest first, as a block header or extra bits go. */
const put = (v: number, k: number) => { for (let i = 0; i < k; i++) pending.push((v >> i) & 1) }
/** Appends a Huffman code, or several, first bit first. */
const code = (c: string) => { for (const b of c) pending.push(+b) }
const built = (build: () => void) => { pending = []; build(); const s = new Uint8Array((pending.length + 7) >> 3); pending.forEach((b, i) => { s[i >> 3]! |= b << (i & 7) }); return s }
/** Code lengths as the code-length symbols that send them, with their extra bits: zeros in runs (17, 18), the rest as they are. */
function plainly(all: number[]): [number, number?][] {
  const seq: [number, number?][] = []
  for (let i = 0, k = 1; i < all.length; i += k) {
    for (k = 1; !all[i] && all[i + k] === 0 && k < 138;) k++
    if (k < 3) k = 1
    seq.push(k >= 11 ? [18, k - 11] : k >= 3 ? [17, k - 3] : [all[i]!])
  }
  return seq
}
/**
 * Writes a dynamic block's header for these code lengths and returns the two codes. `seq` is the code-length symbols
 * to send when not the plain ones, `pre` the code-length code's own lengths (a complete code of all 19 unless given).
 */
function header(final: number, ll: number[], dl: number[], seq = plainly([...ll, ...dl]), pre = lens(19, { 13: 5, 14: 5, 15: 5, 16: 5, 17: 5, 18: 5 }).map(l => l || 4)) {
  put(final | 4, 3); put(ll.length - 257, 5); put(dl.length - 1, 5); put(15, 4)
  for (const s of ORDER) put(pre[s]!, 3)
  const pc = canon(pre)
  for (const [s, extra] of seq) { code(pc[s]!); if (s >= 16) put(extra!, s === 16 ? 2 : s === 17 ? 3 : 7) }
  return [canon(ll), canon(dl)] as const
}

/** What no compressor writes: the edges of what RFC 1951 allows, and what it forbids. zlib says which is which. */
function crafted(): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [], add = (name: string, build: () => void) => out.push([name, built(build)])
  const a = FIX[97]!, end = FIX[256]!, len3 = FIX[257]!, len258 = FIX[285]!, AZ = { 97: 1, 256: 1 }, AZ3 = { 97: 1, 256: 2, 257: 2 }
  add('stored: no bytes at all', () => { put(1, 8); put(0, 16); put(0xffff, 16) })
  add('stored: bits set in the padding before the length', () => { put(0xf9, 8); put(1, 16); put(0xfffe, 16); put(97, 8) })
  add('stored: a length whose check fails', () => { put(1, 8); put(1, 16); put(0xfffd, 16); put(97, 8) })
  add('stored: fewer bytes than the length says', () => { put(1, 8); put(2, 16); put(0xfffd, 16); put(97, 8) })
  add('a block of the type that does not exist', () => put(7, 8))
  add('fixed: the end of block and nothing else', () => { put(3, 3); code(end) })
  add('fixed: bits set after the end, within the last byte', () => { put(3, 3); code(end); put(63, 6) })
  add('fixed: a byte after the final block', () => { put(3, 3); code(end); put(0, 14) })
  add('fixed: a block that is not the last, and then nothing', () => { put(2, 3); code(a + end) })
  add('an empty stored block that is not the last, then a fixed one', () => { put(0, 8); put(0, 16); put(0xffff, 16); put(3, 3); code(a + end) })
  add('fixed: a match of 258 that overlaps itself at distance 1', () => { put(3, 3); code(a + len258 + '00000' + end) })
  add('fixed: a distance that reaches the first byte', () => { put(3, 3); code(a + FIX[98]! + len3 + '00001' + end) })
  add('fixed: a distance one byte past the first', () => { put(3, 3); code(a + FIX[98]! + len3 + '00010' + end) })
  add('fixed: a match before any byte', () => { put(3, 3); code(len3 + '00000' + end) })
  add('fixed: length code 286', () => { put(3, 3); code(a + FIX[286]! + '00000' + end) })
  add('fixed: length code 287', () => { put(3, 3); code(a + FIX[287]! + '00000' + end) })
  add('fixed: distance code 30', () => { put(3, 3); code(a + len3 + '11110' + end) })
  add('fixed: distance code 31', () => { put(3, 3); code(a + len3 + '11111' + end) })
  // 'x', then 32767 times 'a', is a window's worth: distance 32768 reaches the 'x', and no further
  add('fixed: 258 bytes from distance 32768', () => { put(3, 3); code(FIX[120]! + a + (len258 + '00000').repeat(127) + len258 + '11101'); put(8191, 13); code(end) })
  add('fixed: distance 32768 with 32767 bytes to reach into', () => { put(3, 3); code(a + (len258 + '00000').repeat(127) + len3 + '11101'); put(8191, 13); code(end) })
  add('dynamic: one code of one bit, for the end of block', () => { const [l] = header(1, lens(257, { 256: 1 }), [0]); code(l[256]!) })
  add('dynamic: literals and no distance code at all', () => { const [l] = header(1, lens(257, AZ), [0]); code(l[97]! + l[97]! + l[256]!) })
  add('dynamic: one distance code, of one bit', () => { const [l, d] = header(1, lens(258, AZ3), [1]); code(l[97]! + l[257]! + d[0]! + l[256]!) })
  add('dynamic: the bit a lone distance code leaves unused', () => { const [l] = header(1, lens(258, AZ3), [1]); code(l[97]! + l[257]! + '1' + l[256]!) })
  add('dynamic: a match when there is no distance code', () => { const [l] = header(1, lens(258, AZ3), [0]); code(l[97]! + l[257]! + '0' + l[256]!) })
  add('dynamic: one distance code, of two bits', () => { const [l] = header(1, lens(257, AZ), [2]); code(l[256]!) })
  add('dynamic: an incomplete distance code', () => { const [l] = header(1, lens(257, AZ), [2, 2]); code(l[256]!) })
  add('dynamic: an over-subscribed distance code', () => { const [l] = header(1, lens(257, AZ), [1, 1, 1]); code(l[256]!) })
  add('dynamic: an incomplete literal/length code', () => { const [l] = header(1, lens(257, { 97: 2, 256: 2 }), [0]); code(l[256]!) })
  add('dynamic: an over-subscribed literal/length code', () => { const [l] = header(1, lens(257, { 97: 1, 98: 1, 256: 1 }), [0]); code(l[256]!) })
  add('dynamic: no code for the end of block', () => { const [l] = header(1, lens(257, { 97: 1, 98: 1 }), [0]); code(l[97]!) })
  add('dynamic: 286 literal/length codes and 30 distance codes', () => { const [l, d] = header(1, lens(286, { 97: 1, 256: 2, 285: 2 }), lens(30, { 0: 1, 29: 1 })); code(l[97]! + l[285]! + d[0]! + l[256]!) })
  add('dynamic: 287 literal/length codes', () => { const [l] = header(1, lens(287, AZ), [0]); code(l[256]!) })
  add('dynamic: 31 distance codes', () => { const [l] = header(1, lens(257, AZ), lens(31, { 0: 1, 1: 1 })); code(l[256]!) })
  add('dynamic: an incomplete code-length code', () => header(1, lens(257, AZ), [0], [[0], [1]], lens(19, { 0: 2, 1: 2 })))
  add('dynamic: a code-length code of one code', () => header(1, lens(257, AZ), [0], [[0], [0]], lens(19, { 0: 1 })))
  add('dynamic: an over-subscribed code-length code', () => header(1, lens(257, AZ), [0], [[0], [1]], lens(19, { 0: 1, 1: 1, 2: 1 })))
  add('dynamic: a repeat with no length before it', () => header(1, lens(257, AZ), [0], [[16, 0], [0]]))
  add('dynamic: zeros running past the last code', () => header(1, lens(257, AZ), [0], [[18, 127], [18, 110]]))
  add('dynamic: a repeat running past the last code', () => header(1, lens(257, AZ), [0], [[18, 127], [18, 105], [1], [16, 3]]))
  add('dynamic: a repeat running from the literal lengths into the distance lengths', () => { const [l, d] = header(1, lens(258, { 97: 2, 255: 2, 256: 2, 257: 2 }), [2, 2, 2, 2], [[18, 86], [2], [18, 127], [17, 5], [18, 0], [2], [16, 3]]); code(l[97]! + l[255]! + l[257]! + d[1]! + l[256]!) })
  add('dynamic: zeros running from the literal lengths into the distance lengths', () => { const [l, d] = header(1, lens(260, AZ3), [0, 0, 1], [[18, 86], [1], [18, 127], [18, 9], [2], [2], [17, 1], [1]]); code(l[97]!.repeat(3) + l[257]! + d[2]! + l[256]!) })
  return out
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258], LEXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577], DEXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
/** The lengths of a random complete code of `count` codes (two or more), none longer than `most` bits. */
function anyCode(count: number, most: number): number[] {
  const depths = [0]
  while (depths.length < count) {
    const open = depths.flatMap((d, i) => (d < most ? [i] : []))
    if (!open.length) break
    const i = pick(open)
    depths.splice(i, 1, depths[i]! + 1, depths[i]! + 1)
  }
  return depths
}
/** `n` code lengths: the ones given, dealt to random symbols, `must` among them. */
function dealt(n: number, depths: number[], must: number[] = []): number[] {
  const order = Array.from({ length: n }, (_, i) => i).filter(i => !must.includes(i)), a = new Array<number>(n).fill(0)
  for (let i = order.length - 1; i > 0; i--) { const j = ri(i + 1), t = order[i]!; order[i] = order[j]!; order[j] = t }
  depths.forEach((d, k) => { a[[...must, ...order][k]!] = d })
  return a
}
/** Code lengths as code-length symbols picked at random among the ways the format allows: runs of zeros long or short, repeats of any length (of zero too). */
function anyRuns(all: number[]): [number, number?][] {
  const seq: [number, number?][] = []
  for (let i = 0; i < all.length;) {
    let run = 1
    while (all[i + run] === all[i]) run++
    const how = ri(4)
    if (!all[i] && run >= 11 && how < 2) { const k = 11 + ri(Math.min(run, 138) - 10); seq.push([18, k - 11]); i += k }
    else if (!all[i] && run >= 3 && how < 3) { const k = 3 + ri(Math.min(run, 10) - 2); seq.push([17, k - 3]); i += k }
    else if (i && all[i - 1] === all[i] && run >= 3 && how < 3) { const k = 3 + ri(Math.min(run, 6) - 2); seq.push([16, k - 3]); i += k }
    else seq.push([all[i++]!])
  }
  return seq
}
/**
 * A random stream that keeps to the format and looks like no compressor's: blocks of any type in any order, complete
 * codes of any shape up to 15 bits (7 for the code-length code), a lone distance code or none, random tokens.
 */
function anyStream(): Uint8Array {
  let made = 0
  return built(() => {
    for (let left = 1 + ri(4); left > 0; left--) {
      const final = left === 1 ? 1 : 0, type = ri(3)
      if (type === 0) {
        const len = ri(50)
        put(final, 3); while (pending.length & 7) put(ri(2), 1)
        put(len, 16); put(len ^ 0xffff, 16); for (let k = 0; k < len; k++) put(ri(256), 8)
        made += len
        continue
      }
      let ll = Array.from({ length: 286 }, () => 1), dl = new Array<number>(30).fill(1), codes: readonly [string[], string[]] = [FIX, dl.map((_, s) => bin(s, 5))]
      if (type === 1) put(final | 2, 3)
      else {
        const nl = 257 + ri(30), nd = 1 + ri(30)
        ll = ri(20) ? dealt(nl, anyCode(2 + ri(Math.min(nl - 1, pick([3, 40, 285]))), 15), [256]) : lens(nl, { 256: 1 })
        dl = nd > 1 && ri(8) ? dealt(nd, anyCode(2 + ri(nd - 1), 15)) : lens(nd, ri(3) ? { [ri(nd)]: 1 } : {})
        const seq = anyRuns([...ll, ...dl]), used = [...new Set(seq.map(([s]) => s))]
        if (used.length < 2) used.push((used[0]! + 1 + ri(18)) % 19)
        const depths = anyCode(used.length, 7)
        codes = header(final, ll, dl, seq, lens(19, Object.fromEntries(used.map((s, k) => [s, depths[k]!]))))
      }
      const lits = ll.flatMap((l, s) => (l && s < 256 ? [s] : [])), copies = ll.flatMap((l, s) => (l && s > 256 ? [s] : []))
      for (let t = ri(80); t > 0; t--) {
        const reach = dl.flatMap((l, s) => (l && DBASE[s]! <= made ? [s] : []))
        if (copies.length && reach.length && ri(2)) {
          const s = pick(copies), ds = pick(reach), more = ri(1 << LEXTRA[s - 257]!)
          code(codes[0][s]!); put(more, LEXTRA[s - 257]!); code(codes[1][ds]!); put(ri(Math.min(1 << DEXTRA[ds]!, made - DBASE[ds]! + 1)), DEXTRA[ds]!)
          made += LBASE[s - 257]! + more
        } else if (lits.length) { code(codes[0][pick(lits)]!); made++ }
      }
      code(codes[0][256]!)
    }
  })
}

/** What zlib makes of a stream when it must take the whole of it: nothing for one it refuses, finds cut short or leaves bytes of. */
function zlibSays(s: Uint8Array): Uint8Array | undefined {
  const r = tried(() => zlib.inflateRawSync(s, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } })
  return r instanceof Error || r.engine.bytesWritten !== s.length ? undefined : r.buffer
}

// ---- the streams the test file embeds ----

/** The plain bytes of the zlib-made vectors: hooks/deflate.test.ts holds the same formulas. */
const PLAIN = {
  stored: enc.encode('stored: the bytes as they are'),
  fixed: enc.encode('fixed codes, fixed codes, fixed codes: no table to send'),
  dynamic: enc.encode(Array.from({ length: 120 }, (_, i) => i * i).join(' ')),
  // counts of 1, 2, 3, 5, 8 ... 987 (and the one end of block) make a code of every length from 1 to 15; the gaps
  // between the byte values make runs of zeros of every size
  deep: Uint8Array.from([1, 3, 6, 10, 20, 40, 41, 80, 81, 82, 120, 160, 200, 201, 240].flatMap((v, k) => { let a = 1, b = 2; for (let i = 0; i < k; i++) [a, b] = [b, a + b]; return new Array<number>(a).fill(v) })),
  // eight neighbouring bytes as often as each other get codes of one length: a repeat
  level: enc.encode('abcdefgh'.repeat(12)),
}

/** The code-length symbols (0..18) that the header of a stream's first block, a dynamic one, uses. */
function headerSymbols(s: Uint8Array): Set<number> {
  let p = 3
  const bits = (k: number) => { let v = 0; for (let i = 0; i < k; i++, p++) v |= ((s[p >> 3]! >> (p & 7)) & 1) << i; return v }
  if (((s[0]! >> 1) & 3) !== 2) throw new Error('not a dynamic block')
  const all = bits(5) + 257 + bits(5) + 1, hclen = bits(4) + 4, pre = new Array<number>(19).fill(0), used = new Set<number>()
  for (let i = 0; i < hclen; i++) pre[ORDER[i]!] = bits(3)
  const codes = canon(pre)
  for (let i = 0; i < all;) {
    let key = ''
    while (!codes.includes(key)) key += bits(1)
    const sym = codes.indexOf(key)
    used.add(sym)
    i += sym < 16 ? 1 : sym === 16 ? 3 + bits(2) : sym === 17 ? 3 + bits(3) : 11 + bits(7)
  }
  return used
}

/** Bytes as the JS string expression the test file compares with: one char a byte, long runs folded. */
function literal(x: Uint8Array): string {
  const parts: string[] = []
  let plain = ''
  const flush = () => { if (plain) parts.push(`'${plain}'`); plain = '' }
  for (let i = 0, k = 1; i < x.length; i += k) {
    const c = x[i]!, ch = c >= 32 && c < 127 && c !== 39 && c !== 92 ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, '0')}`
    for (k = 1; x[i + k] === c;) k++
    if (k >= 16) { flush(); parts.push(`'${ch}'.repeat(${k})`) } else plain += ch.repeat(k)
  }
  flush()
  return parts.join(' + ') || "''"
}

/** A base64 string as source text, cut into lines. */
const quoted = (x: Uint8Array) => Buffer.from(x).toString('base64').match(/.{1,120}/g)!.map(part => `'${part}'`).join(' +\n    ')

// The vectors as the stock zlib writes them. The last is one stream, flushed in full between its two blocks, so the
// second starts on a byte and its header can be looked into.
const STOCK = `
import sys, zlib, base64
stored, fixed, dynamic, deep, level = (base64.b64decode(line) for line in sys.stdin.read().split())
def made(x, level=9, strategy=zlib.Z_DEFAULT_STRATEGY):
    c = zlib.compressobj(level, zlib.DEFLATED, -15, 8, strategy); return c.compress(x) + c.flush()
c = zlib.compressobj(9, zlib.DEFLATED, -15, 8, zlib.Z_HUFFMAN_ONLY)
first = c.compress(deep) + c.flush(zlib.Z_FULL_FLUSH)
for s in (made(stored, 0), made(fixed, 9, zlib.Z_FIXED), made(dynamic), first, c.compress(level) + c.flush()): print(base64.b64encode(s).decode())
print(zlib.ZLIB_RUNTIME_VERSION)
`

function vectors() {
  const run = spawnSync('python3', ['-I', '-c', STOCK], { input: Object.values(PLAIN).map(x => Buffer.from(x).toString('base64')).join('\n') })
  if (run.status !== 0) throw new Error(`the vectors come from the stock zlib, through python3, which did not run: ${run.error?.message ?? run.stderr}`)
  const lines = run.stdout.toString().trim().split('\n'), [stored, fixed, dynamic, deep, level] = lines.map(line => new Uint8Array(Buffer.from(line, 'base64'))) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]
  const made: Record<string, [Uint8Array, Uint8Array]> = { stored: [stored, PLAIN.stored], fixed: [fixed, PLAIN.fixed], dynamic: [dynamic, PLAIN.dynamic], everyLength: [cat(deep, level), cat(PLAIN.deep, PLAIN.level)] }
  const used = [...new Set([...headerSymbols(deep), ...headerSymbols(level)])].sort((a, b) => a - b)
  if (used.length !== 19) throw new Error(`the code-length vector uses only ${used}`)
  if (Object.values(made).map(([s]) => (s[0]! >> 1) & 3).join() !== '0,1,2,2') throw new Error('a vector is not of the block type it is named for')
  console.log(`// zlib ${lines.at(-1)} wrote these, through python (tools/deflate-check.ts --vectors)\nconst ZLIB = {`)
  for (const [name, [s, plain]] of Object.entries(made)) {
    if (!same(zlib.inflateRawSync(s), plain) || !same(inflate(s), plain)) throw new Error(`${name} does not decode to its plain bytes`)
    console.log(`  ${name}: ${quoted(s)},`)
  }
  console.log('}\n\n// Streams the same tool put together bit by bit, for what no compressor writes: [what it is, the stream, the bytes\n// zlib reads from it]. No bytes: zlib refuses the stream, or stops before its end.\nconst CRAFTED: [string, string, string?][] = [')
  for (const [name, s] of crafted()) { const z = zlibSays(s); console.log(`  ['${name}', ${quoted(s)}${z ? `, ${literal(z)}` : ''}],`) }
  console.log(']')
}

// ---- the checks ----

type Codec = { deflate: (x: Uint8Array) => Uint8Array; lengths: (freq: Uint32Array, limit: number) => Uint8Array }
/**
 * A copy of the module with its source changed, to reach what its two exports do not show. Every copy exports
 * lengths() and counts the calls in which a length limit had to be enforced.
 */
async function variant(tmp: string, name: string, ...changes: [string, string][]): Promise<Codec> {
  let src = `${readFileSync(join(import.meta.dir, '../hooks/deflate.ts'), 'utf8')}\nexport { lengths }\n`
  for (const [from, to] of [['  for (; over > 0; over--) {', '  if (over > 0) (globalThis as any).limited[limit]++\n  for (; over > 0; over--) {'], ...changes] as const) {
    if (!src.includes(from)) throw new Error(`hooks/deflate.ts no longer has "${from}": this check has to follow it`)
    src = src.replaceAll(from, to)
  }
  writeFileSync(join(tmp, `${name}.ts`), src)
  return import(join(tmp, `${name}.ts`))
}
const limited: Record<number, number> = { 7: 0, 15: 0 }
Object.assign(globalThis, { limited })
const KIND: [string, string] = ['if (stored <= min(dynamic, fixed)) {', 'if (false) {'], ROOM: [string, string] = ['new U8(n + (n >> 11) + 64)', 'new U8(2 * n + 1024)']

/**
 * deflate's output is read back by this module, by zlib and by libdeflate, and so is the output of copies of it made
 * to write one kind of block only, or blocks of a million tokens; every zlib and libdeflate stream is read by inflate.
 */
async function roundTrips(tmp: string, all: [string, Uint8Array][]): Promise<string> {
  const counted = await variant(tmp, 'counted'), large = await variant(tmp, 'large', ['const TOKENS = 16384', 'const TOKENS = 1 << 20'])
  const forced: [string, Codec][] = [['stored', await variant(tmp, 'stored', ['if (stored <= min(dynamic, fixed)) {', 'if (true) {'])], ['fixed', await variant(tmp, 'fixed', KIND, ROOM, ['dynamic < fixed', 'false'])], ['dynamic', await variant(tmp, 'dynamic', KIND, ROOM, ['dynamic < fixed', 'true'])]]
  const hit: Record<string, string[]> = { 'as it is, 15': [], 'as it is, 7': [], 'large, 15': [], 'large, 7': [] }
  /** Runs deflate in a copy and notes which limits it had to enforce. */
  const watched = (m: Codec, x: Uint8Array, name: string, how: string) => { const b7 = limited[7]!, b15 = limited[15]!, d = m.deflate(x); if (limited[15]! > b15) hit[`${how}, 15`]!.push(name); if (limited[7]! > b7) hit[`${how}, 7`]!.push(name); return d }
  const theirs: [string, zlib.ZlibOptions][] = []
  for (const level of [0, 1, 6, 9]) for (const [name, strategy] of [['default', Z.Z_DEFAULT_STRATEGY], ['fixed', Z.Z_FIXED], ['huffman-only', Z.Z_HUFFMAN_ONLY]] as const) theirs.push([`zlib level ${level} ${name}`, { level, strategy }])
  theirs.push(['zlib run-length', { strategy: Z.Z_RLE }], ['zlib in blocks of 128 tokens', { memLevel: 1 }], ['zlib with a 512-byte window', { windowBits: 9 }])
  for (const [name, x] of all) {
    const d = tried(() => deflate(x))
    if (d instanceof Error) { check(false, `${name}: deflate threw: ${d.message}`); continue }
    // stored blocks are the worst deflate does: five bytes for each, of 16 KiB or more, and a byte to end on
    check(d.length <= x.length + 5 * (1 + (x.length >> 14)) + 1, `${name}: deflate wrote ${d.length} bytes for ${x.length}`)
    gives(() => inflate(d), x, `${name}: inflate(deflate(x)) is not x`)
    const exact = tried(() => inflate(d, x.length))
    check(!(exact instanceof Error) && same(exact, x) && exact.buffer.byteLength === x.length, `${name}: inflate with the exact size for a limit`)
    if (x.length) check(tried(() => inflate(d, x.length - 1)) instanceof Error, `${name}: inflate did not throw one byte past its limit`)
    gives(() => zlib.inflateRawSync(d), x, `${name}: zlib does not read deflate's output`)
    gives(() => Bun.inflateSync(d, { library: 'libdeflate' } as never), x, `${name}: libdeflate does not read deflate's output`)
    for (const [how, options] of theirs) gives(() => inflate(zlib.deflateRawSync(x, options)), x, `${name}: inflate does not read ${how}`)
    for (const level of [1, 12]) gives(() => inflate(Bun.deflateSync(x, { library: 'libdeflate', level } as never)), x, `${name}: inflate does not read libdeflate level ${level}`)
    gives(() => watched(counted, x, name, 'as it is'), d, `${name}: the counting copy of deflate writes other bytes`)
    for (const [kind, m] of [...forced, ['million-token', { ...large, deflate: (y: Uint8Array) => watched(large, y, name, 'large') }]] as const) {
      const f = tried(() => m.deflate(x))
      if (f instanceof Error) { check(false, `${name}: deflate made to write ${kind} blocks threw: ${f.message}`); continue }
      gives(() => zlib.inflateRawSync(f), x, `${name}: zlib does not read deflate made to write ${kind} blocks`)
      gives(() => inflate(f), x, `${name}: inflate does not read deflate made to write ${kind} blocks`)
    }
  }
  // the window is used to its last byte and not a byte past it: random bytes three times over cost one copy, or three
  const near = deflate(times(noise(32768), 3)).length, past = deflate(times(noise(32769), 3)).length
  check(near < 34_000 && past > 98_000, `distance 32768 must match and 32769 must not: ${near} and ${past} bytes`)
  // a block filled to its last token goes out at once, and the stream ends on an empty one: a stored block and two bytes
  check(deflate(unrepeated(16384)).length === 16384 + 5 + 2, `16384 literals were expected to fill one block exactly: ${deflate(unrepeated(16384)).length} bytes`)
  for (const limit of [15, 7] as const) check(hit[`as it is, ${limit}`]!.includes(LIMITS[limit]), `${LIMITS[limit]} no longer reaches the ${limit}-bit limit: find another for hooks/deflate.test.ts`)
  return `length limits: deflate as it is had to enforce 15 bits on ${hit['as it is, 15']!.length} inputs (${hit['as it is, 15']!.slice(0, 3).join('; ')}) and 7 bits, for the code-length code, on ${hit['as it is, 7']!.length}; with blocks of a million tokens, on ${hit['large, 15']!.length} and ${hit['large, 7']!.length}`
}

/** Corrupt streams: inflate must throw (an error of its own) or return, never hang, and agree with zlib on which and on the bytes. */
function corruption(prose: Uint8Array): { streams: Uint8Array[]; report: string[] } {
  const text = prose.length > 50_000 ? prose.subarray(5000, 45_000) : records(300), small = text.subarray(0, 300)
  const part = (x: Uint8Array, options: zlib.ZlibOptions) => zlib.deflateRawSync(x, { ...options, finishFlush: Z.Z_FULL_FLUSH })
  const bases: Uint8Array[] = [
    deflate(small), zlib.deflateRawSync(small, { level: 9 }), zlib.deflateRawSync(small, { strategy: Z.Z_FIXED }), zlib.deflateRawSync(small.subarray(0, 60), { level: 0 }), deflate(new Uint8Array(0)),
    zlib.deflateRawSync(skewed(24, 1.62, 3000, 1, 5), { strategy: Z.Z_HUFFMAN_ONLY }), deflate(skewed(24, 1.62, 3000, 1, 5)), deflate(woven(400, 4)), Bun.deflateSync(small, { library: 'libdeflate', level: 12 } as never),
    // every kind of block in one stream, with empty stored blocks between
    cat(part(small.subarray(0, 80), { level: 9 }), part(small.subarray(80, 120), { level: 0 }), part(small.subarray(120, 200), { strategy: Z.Z_FIXED }), zlib.deflateRawSync(small.subarray(200), { strategy: Z.Z_HUFFMAN_ONLY })),
  ]
  const hand = crafted().map(([, s]) => s), odd = Array.from({ length: 20_000 }, anyStream), big = [deflate(text), zlib.deflateRawSync(text, { level: 6 }), zlib.deflateRawSync(text, { memLevel: 1 })]
  // a copy each time: zlib hands out Buffers, whose slice() is a view of the same bytes
  const flip = (s: Uint8Array, bit: number) => { const c = new Uint8Array(s); c[bit >> 3]! ^= 1 << (bit & 7); return c }
  for (const s of odd) check(!!zlibSays(s), `a random stream that should keep to the format, and zlib does not take: ${hex(s)} (${s.length} bytes)`)
  const groups: [string, Uint8Array[]][] = [
    ['streams put together by hand', hand],
    ['random streams that keep to the format: any blocks, any complete codes, any tokens', odd],
    ['one bit flipped in each of those', odd.map(s => flip(s, ri(s.length * 8)))],
    ['every single bit flipped, in 10 small streams and the ones made by hand', [...bases, ...hand].flatMap(s => Array.from({ length: s.length * 8 }, (_, bit) => flip(s, bit)))],
    ['every cut of the same streams', [...bases, ...hand].flatMap(s => Array.from({ length: s.length }, (_, n) => s.subarray(0, n)))],
    ['two to four bits flipped', bases.flatMap(s => Array.from({ length: 2000 }, () => { let c = s; for (let f = 2 + ri(3); f > 0; f--) c = flip(c, ri(c.length * 8)); return c }))],
    ['bytes put in or taken out', bases.flatMap(s => Array.from({ length: 300 }, () => { const at = ri(s.length + 1); return cat(s.subarray(0, at), noise(1 + ri(3)), s.subarray(at + ri(2))) }))],
    ['bytes added at the end', bases.flatMap(s => [cat(s, Uint8Array.of(0)), cat(s, noise(7))])],
    ['one bit flipped in 13 KiB of compressed text', big.flatMap(s => Array.from({ length: 2000 }, () => flip(s, ri(s.length * 8))))],
    ['a byte replaced in the same, or its end cut off', big.flatMap(s => Array.from({ length: 2000 }, (_, k) => { if (k & 1) return s.subarray(0, ri(s.length)); const c = new Uint8Array(s); c[ri(c.length)] = ri(256); return c }))],
    ['random bytes, a third of them opening as a dynamic block', Array.from({ length: 150_000 }, (_, k) => { const c = noise(1 + ri(40)); if (k % 3 === 0) c[0] = (c[0]! & ~6) | 4; return c })],
  ]
  const report: string[] = []
  let slowest = new Uint8Array(0), worst = 0
  for (const [name, streams] of groups) {
    let threw = 0, agreed = 0
    for (const s of streams) {
      const t = performance.now(), r = tried(() => inflate(s)), ms = performance.now() - t, z = zlibSays(s)
      if (ms > worst) { worst = ms; slowest = s }
      if (r instanceof Error) threw++
      const ok = r instanceof Error ? !z && r.message.startsWith('inflate: ') && r.constructor === Error : !!z && same(r, z)
      if (ok) agreed++
      check(ok, `${name}: ${hex(s)} (${s.length} bytes): inflate ${r instanceof Error ? `throws "${r.message}"` : `gives ${r.length} bytes`}, zlib ${z ? `gives ${z.length}` : 'does not take it'}`)
    }
    report.push(`  ${name}: ${streams.length}; inflate throws at ${threw} and reads ${streams.length - threw}; zlib, made to take the whole input, agrees on ${agreed === streams.length ? 'every one' : `ONLY ${agreed}`}`)
  }
  const again = timed(() => tried(() => inflate(slowest)))
  check(again < 50, `a corrupt stream of ${slowest.length} bytes took inflate ${again.toFixed(1)} ms`)
  report.push(`  the slowest of them took ${worst.toFixed(2)} ms when it was met and ${again.toFixed(2)} ms run again (${slowest.length} bytes)`)
  // output without end: 256 MiB of zeros in 250 KiB must stop at the limit
  const bomb = cat(times(part(new Uint8Array(4 * MiB), { level: 9 }), 64), deflate(new Uint8Array(0)))
  const stopped = tried(() => inflate(bomb)), tDefault = timed(() => tried(() => inflate(bomb)), 3), tSmall = timed(() => tried(() => inflate(bomb, MiB)), 3)
  check(stopped instanceof Error && /passes/.test(stopped.message), 'inflate did not stop at its limit')
  report.push(`  256 MiB of zeros in ${bomb.length} bytes: refused at the default limit of 64 MiB after ${tDefault.toFixed(0)} ms, at a limit of 1 MiB after ${tSmall.toFixed(2)} ms`)
  return { streams: groups.flatMap(([, s]) => s.slice(0, 20_000)), report }
}

/** Streams in the framing the python referee reads: a length in four bytes, then the bytes. */
const framed = (streams: Uint8Array[]) => cat(...streams.flatMap(s => [new Uint8Array(Uint32Array.of(s.length).buffer), s]))
const REFEREE = `
import sys, zlib, hashlib, struct
def frames(path):
    d = open(path, 'rb').read(); i = 0
    while i < len(d):
        n, = struct.unpack_from('<I', d, i); yield d[i + 4:i + 4 + n]; i += 4 + n
with open(sys.argv[3], 'wb') as out:
    for x in frames(sys.argv[1]):
        for level in (1, 6, 9):
            c = zlib.compressobj(level, zlib.DEFLATED, -15); s = c.compress(x) + c.flush(); out.write(struct.pack('<I', len(s)) + s)
for s in frames(sys.argv[2]):
    try:
        o = zlib.decompressobj(-15); x = o.decompress(s)
        print(hashlib.sha256(x).hexdigest(), len(o.unused_data)) if o.eof else print('cut')
    except zlib.error:
        print('bad')
print(zlib.ZLIB_RUNTIME_VERSION)
`

/**
 * The stock zlib's word, through python: it compresses every input, and inflate must read each; it reads deflate's
 * output for every input, and the corrupt streams, and inflate must take exactly the ones it takes whole, to the same bytes.
 */
function python(tmp: string, all: [string, Uint8Array][], corrupt: Uint8Array[], stock: Map<string, number>): string {
  const ours = all.map(([, x]) => deflate(x)), streams = [...ours, ...corrupt]
  writeFileSync(join(tmp, 'plain'), framed(all.map(([, x]) => x))); writeFileSync(join(tmp, 'streams'), framed(streams))
  const run = spawnSync('python3', ['-I', '-c', REFEREE, join(tmp, 'plain'), join(tmp, 'streams'), join(tmp, 'theirs')], { maxBuffer: 1 << 30 })
  if (run.status !== 0) return `python3 did not run (${run.error?.message ?? run.stderr?.toString().trim().split('\n').at(-1)}): the stock zlib was not asked`
  const theirs = new Uint8Array(readFileSync(join(tmp, 'theirs'))), view = new DataView(theirs.buffer, theirs.byteOffset), lines = run.stdout.toString().trim().split('\n')
  let at = 0, whole = 0
  for (const [name, x] of all) for (const level of [1, 6, 9]) {
    const n = view.getUint32(at, true), s = theirs.subarray(at + 4, at + 4 + n)
    at += 4 + n
    if (level === 6) stock.set(name, n)
    gives(() => inflate(s), x, `${name}: inflate does not read python's zlib level ${level}`)
  }
  streams.forEach((s, i) => {
    const [hash, unused] = lines[i]!.split(' '), r = tried(() => inflate(s)), took = unused === '0'
    if (took && i >= ours.length) whole++
    check(took ? !(r instanceof Error) && sha(r) === hash : r instanceof Error && i >= ours.length, `stream ${i} (${hex(s)}, ${s.length} bytes): python's zlib says "${lines[i]}", inflate ${r instanceof Error ? `throws "${r.message}"` : `gives ${r.length} bytes`}`)
  })
  return `python's zlib ${lines.at(-1)}: inflate reads all ${all.length * 3} streams it wrote (levels 1, 6, 9), and it reads deflate's output for all ${ours.length} inputs; of ${corrupt.length} corrupt streams it takes ${whole} whole, and inflate takes those ${whole} and no others, to the same bytes`
}

/** lengths() by itself, through a copy of the module that exports it: complete codes, within the limit, optimal when the limit is not in the way. */
async function codeLengths(tmp: string): Promise<string> {
  const { lengths } = await variant(tmp, 'lengths')
  // Huffman's cost and depth by the textbook method, to compare with
  const huffman = (freq: number[]) => {
    const nodes = freq.filter(f => f > 0).map(w => ({ w, depth: 0 }))
    let cost = 0
    while (nodes.length > 1) { nodes.sort((a, b) => a.w - b.w || a.depth - b.depth); const [a, b] = nodes.splice(0, 2); cost += a!.w + b!.w; nodes.push({ w: a!.w + b!.w, depth: Math.max(a!.depth, b!.depth) + 1 }) }
    return { cost, depth: nodes[0]?.depth ?? 0 }
  }
  let limited = 0, trials = 0, worst = 0
  for (const [size, limit] of [[286, 15], [30, 15], [19, 7]] as const) for (let k = 0; k < 4000; k++) {
    const used = pick([0, 1, 2, 3, size >> 1, size]), ratio = pick([1, 1.1, 1.3, 1.62, 2, 4]), freq = new Uint32Array(size)
    for (let s = 0, f = 1 + ri(3); s < used; s++, f *= ratio) freq[ri(size)] = Math.min(4e9, Math.ceil(f * (0.5 + rnd())))
    const all = [...freq], had = all.filter(f => f > 0).length, got = [...lengths(freq, limit)], coded = got.filter(l => l > 0), plain = huffman(all)
    const cost = got.reduce((sum, l, s) => sum + l * all[s]!, 0), fits = plain.depth <= limit
    trials++
    if (!fits) { limited++; worst = Math.max(worst, cost / plain.cost - 1) }
    check(coded.reduce((sum, l) => sum + 2 ** -l, 0) === 1 && Math.max(...coded) <= limit && all.every((f, s) => !f || got[s]! > 0) && coded.length === Math.max(2, had)
      && (had < 2 || (fits ? cost === plain.cost : cost > plain.cost)), `lengths of ${had} symbols within ${limit} bits: [${all.filter(f => f > 0)}] gives [${coded}]`)
  }
  return `code lengths: ${trials} frequency tables all give a complete code within the limit, of Huffman's own cost whenever Huffman's tree fits; ${limited} needed limiting, which cost ${(worst * 100).toFixed(1)}% at worst`
}

/** How small and how fast on a MiB of text; what cutting the input into pieces costs; then the inputs each side is slowest on. */
function speeds(all: [string, Uint8Array][], stock: Map<string, number>) {
  const pct = (a: number, b: number) => `${a > b ? '+' : ''}${((a / b - 1) * 100).toFixed(2)}%`
  for (const [name, x] of all.filter(([name]) => name.endsWith(', the first MiB'))) {
    if (x.length < MiB >> 3) { console.log(`${name}: only ${x.length} bytes of it, not measured (give more as arguments)`); continue }
    const d = deflate(x), z = zlib.deflateRawSync(x, { level: 6 }), py = stock.get(name)
    console.log(`${name} (${x.length} bytes): deflate ${d.length} bytes; zlib level 6 as bun has it ${z.length} (deflate ${pct(d.length, z.length)})${py ? `, as python has it ${py} (deflate ${pct(d.length, py)})` : ''}`)
    console.log(`  deflate ${rate(x.length, timed(() => deflate(x), 9))}, inflate ${rate(x.length, timed(() => inflate(z), 9))}; bun's zlib ${rate(x.length, timed(() => zlib.deflateRawSync(x, { level: 6 })))} and ${rate(x.length, timed(() => zlib.inflateRawSync(z)))}`)
    const cut = (piece: number) => { let sum = 0; for (let at = 0; at < x.length; at += piece) sum += deflate(x.subarray(at, at + piece)).length; return `${piece >> 10} KiB ${pct(sum, d.length)}` }
    console.log(`  cut into pieces deflated apart: ${[16, 64, 256, 512].map(k => cut(k << 10)).join(', ')}`)
  }
  const random = noise(MiB), hard: [string, Uint8Array][] = [['2 values', noise(MiB, 2)], ['3 values', noise(MiB, 3)], ['4 values', noise(MiB, 4)], ['16 values', noise(MiB, 16)], ['random bytes', random], ['zeros', new Uint8Array(MiB)]]
  hard.push(['AAA and a random byte', random.map((b, i) => ((i & 3) === 3 ? b : 65))], ['short runs', (() => { const a = new Uint8Array(MiB); for (let i = 0; i < MiB;) { const l = 1 + ri(20); a.fill(ri(4), i, i + l); i += l } return a })()])
  let slow = Infinity
  console.log('1 MiB of what the match search is slowest on:')
  for (const [name, x] of hard) {
    const d = deflate(x), td = timed(() => deflate(x)), ti = timed(() => inflate(d))
    slow = Math.min(slow, MiB / td)
    console.log(`  ${name}: deflate ${td.toFixed(0)} ms (${rate(MiB, td)}) to ${d.length} bytes, inflate ${ti.toFixed(1)} ms`)
  }
  console.log(`deflate at its slowest: ${(slow * 1000 / MiB).toFixed(1)} MiB/s, which is ${Math.floor(slow * 250 / 1024)} KiB in a quarter second`)
  // inflate's dearest input: the smallest dynamic blocks there are, each of which has three tables built and gives no byte
  const smallest = built(() => { for (let k = 0; k < 8; k++) { const [l] = header(0, lens(257, { 256: 1 }), [0], [[18, 127], [18, 107], [1], [0]], lens(19, { 18: 1, 0: 2, 1: 2 })); code(l[256]!) } })
  const blocks = cat(times(smallest, Math.floor(MiB / smallest.length)), deflate(new Uint8Array(0)))
  gives(() => inflate(blocks), new Uint8Array(0), 'a stream of empty dynamic blocks is not read as empty')
  check(zlibSays(blocks)?.length === 0, 'zlib does not read a stream of empty dynamic blocks as empty')
  const tb = timed(() => tried(() => inflate(blocks)))
  console.log(`inflate at its slowest: ${(blocks.length / MiB).toFixed(2)} MiB of empty dynamic blocks (${Math.floor(blocks.length * 8 / smallest.length)} of them) in ${tb.toFixed(0)} ms, ${rate(blocks.length, tb)} of input; zlib takes ${timed(() => zlib.inflateRawSync(blocks)).toFixed(0)} ms`)
}

const args = process.argv.slice(2), roots = args.filter(a => !a.startsWith('--'))
if (args.includes('--vectors')) { vectors(); process.exit(0) }
const t0 = performance.now(), tmp = mkdtempSync(join(tmpdir(), 'deflate-check-'))
try {
  const from = roots.length ? roots : [join(import.meta.dir, '../..')]
  const prose = corpus(from, /\.(md|txt)$/), source = corpus(from, /\.(ts|tsx|js|py|c|h|go|rs)$/), json = corpus(from, /\.json$/), stock = new Map<string, number>()
  console.log(`text: ${prose.length} bytes of prose, ${source.length} of source, ${json.length} of JSON; bun ${Bun.version}, zlib ${process.versions.zlib}; load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores`)
  const all = inputs(prose, source, json), limits = await roundTrips(tmp, all)
  console.log(`round trips: ${checks} checks on ${all.length} inputs (${(all.reduce((sum, [, x]) => sum + x.length, 0) / MiB).toFixed(0)} MiB), ${failed.length} failed: deflate's output read back by inflate, zlib and libdeflate, also when made to write only stored, only fixed or only dynamic blocks, or blocks of a million tokens; 15 kinds of zlib stream and 2 of libdeflate read by inflate`)
  console.log(limits)
  const { streams, report } = corruption(prose)
  console.log(`corrupt streams:\n${report.join('\n')}`)
  console.log(python(tmp, all, streams, stock))
  console.log(await codeLengths(tmp))
  speeds(all, stock)
} catch (e) {
  check(false, `the check itself broke: ${e instanceof Error ? e.stack : e}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failed.length} failed, in ${((performance.now() - t0) / 1000).toFixed(0)} s`)
for (const f of failed.slice(0, 40)) console.log(`FAILED ${f}`)
process.exit(failed.length ? 1 : 0)
