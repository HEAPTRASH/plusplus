// Raw DEFLATE (RFC 1951), both ways, for the spec packs: the runtime has no compression of its own. Pure logic over
// typed arrays. What deflate writes zlib reads (in Python, zlib.decompress(data, -15)), and inflate reads what zlib writes.

// A loop that reads a global runs 30 to 50 times slower in this runtime, so the ones used are taken once, here.
const U8 = Uint8Array, U16 = Uint16Array, U32 = Uint32Array, I32 = Int32Array, F64 = Float64Array
const imul = Math.imul, min = Math.min, max = Math.max, ceil = Math.ceil

// A match length (3..258) is one of symbols 257..285 and a distance (1..32768) one of 0..29: a base, then extra bits.
const LBASE = new U16([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258])
const LEXTRA = new U8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0])
const DBASE = new U16([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577])
const DEXTRA = new U8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13])
// A dynamic block sends its two codes as their lengths, run-length coded and Huffman coded again: 0..15 is a length,
// 16 repeats the one before it 3..6 times, 17 and 18 stand for 3..10 and 11..138 zeros. PEXTRA: the bits that say how
// many. ORDER: the order the block lists that code-length code's own lengths in.
const PEXTRA = new U8(19).fill(2, 16).fill(3, 17).fill(7, 18)
const ORDER = new U8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])
// The fixed block's code lengths. Its literal/length code counts 288 symbols; the last two never stand in valid data.
const FIXLIT = new U8(288).fill(8).fill(9, 144, 256).fill(7, 256, 280), FIXDIST = new U8(30).fill(5)

// ---- inflate ----

// A decode table answers this many bits of input at once. Ten bits is a table of 2 KiB: text seldom has a longer
// code, and a stream of nothing but empty blocks, three tables to each, still reads at megabytes a second.
// ponytail: a longer code is walked a bit at a time instead of through second-level tables; it would matter only for
// data coded mostly in codes past ten bits.
const FAST = 10, MASK = (1 << FAST) - 1

/**
 * A Huffman code set up for decoding. `fast`, indexed by the next FAST bits of input, holds symbol << 4 | length for
 * a code that short and 0 for anything else; `count` (codes of each length) and `syms` (symbols in code order) hold
 * the whole code for `walk`.
 */
type Code = { fast: Uint16Array; count: Uint16Array; syms: Uint16Array }
const code = (): Code => ({ fast: new U16(1 << FAST), count: new U16(16), syms: new U16(288) })
const START = new U16(16)

/**
 * Sets `c` up for the canonical code with these lengths (0: the symbol has no code). Returns the code space left
 * over in units of 2^-15: 0 for a complete code, negative for an over-subscribed one, which is not set up.
 */
function build(c: Code, lens: Uint8Array): number {
  const { fast, count, syms } = c, n = lens.length
  count.fill(0)
  for (let i = 0; i < n; i++) count[lens[i]!]!++
  count[0] = 0
  let left = 1 << 15
  for (let l = 1; l < 16; l++) left -= count[l]! << (15 - l)
  if (left < 0) return left
  // the symbols by length, then by value: the order their codes count up in
  for (let l = 1, at = 0; l < 16; l++) { START[l] = at; at += count[l]! }
  for (let i = 0; i < n; i++) if (lens[i]) syms[START[lens[i]!]!++] = i
  fast.fill(0)
  for (let l = 1, k = 0, v = 0; l <= FAST; l++, v <<= 1)
    for (let m = count[l]!; m > 0; m--, k++, v++) {
      let at = 0
      for (let b = 0; b < l; b++) at |= ((v >> b) & 1) << (l - 1 - b) // a code's first bit is the lowest bit read
      for (const e = (syms[k]! << 4) | l; at <= MASK; at += 1 << l) fast[at] = e
    }
  return left
}

/** The code the bits of `bb` start with, lowest bit first, found the slow way: symbol << 4 | length, or 0 for none. */
function walk(c: Code, bb: number): number {
  const { count, syms } = c
  for (let l = 1, v = 0, first = 0, at = 0; l < 16; l++, v <<= 1) {
    v |= (bb >>> (l - 1)) & 1
    const m = count[l]!
    if (v - first < m) return (syms[at + v - first]! << 4) | l
    at += m; first = (first + m) << 1
  }
  return 0
}

/** Whether a code leaving `left` over is one zlib decodes with: a complete one, or a single code of one bit. */
const usable = (c: Code, left: number) => left === 0 || (left === 1 << 14 && c.count[1] === 1)

const FIXL = code(), FIXD = code(), LIT = code(), DIST = code(), PRE = code()
build(FIXL, FIXLIT); build(FIXD, FIXDIST)
const PLENS = new U8(19), LENS = new U8(286 + 30)
const fail = (what: string) => new Error(`inflate: ${what}`)

/**
 * The bytes a raw DEFLATE stream holds. Throws on a stream that is malformed or cut short, and when the output would
 * pass limit bytes (64 MiB when not given). Bytes after the final block count as malformed.
 */
export function inflate(data: Uint8Array, limit = 64 << 20): Uint8Array {
  const n = data.length
  // bb holds the next bc bits of input, lowest first, all of them real: nothing is read past the end
  let out = new U8(min(limit, max(1024, n * 4))), op = 0, ip = 0, bb = 0, bc = 0, last = 0
  const fill = () => { while (bc < 24 && ip < n) { bb |= data[ip++]! << bc; bc += 8 } }
  const take = (k: number) => {
    if (k > bc) throw fail('the stream is cut short')
    const v = bb & ((1 << k) - 1)
    bb >>>= k; bc -= k
    return v
  }
  const bits = (k: number) => (fill(), take(k))
  const symbol = (c: Code) => {
    fill()
    const e = c.fast[bb & MASK] || walk(c, bb)
    if (!e) throw fail('bits that are no code')
    take(e & 15)
    return e >>> 4
  }
  const room = (k: number) => {
    if (!(op + k <= limit)) throw fail(`the output passes ${limit} bytes`)
    const grown = new U8(min(limit, max(out.length * 2, op + k)))
    grown.set(out.subarray(0, op)); out = grown
  }
  do {
    last = bits(1)
    const type = bits(2)
    let lit = FIXL, dist = FIXD
    if (type === 0) {
      ip -= bc >>> 3; bb = bc = 0 // stored bytes start at the next byte boundary: whole bytes read ahead go back
      if (ip + 4 > n) throw fail('the stream is cut short')
      const len = data[ip]! | (data[ip + 1]! << 8)
      if ((len ^ 0xffff) !== (data[ip + 2]! | (data[ip + 3]! << 8))) throw fail('a stored block whose length check fails')
      if ((ip += 4) + len > n) throw fail('the stream is cut short')
      if (op + len > out.length) room(len)
      out.set(data.subarray(ip, ip + len), op); ip += len; op += len
      continue
    }
    if (type === 3) throw fail('a block of no known type')
    if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4
      if (hlit > 286 || hdist > 30) throw fail('more codes than there are symbols')
      PLENS.fill(0)
      for (let i = 0; i < hclen; i++) PLENS[ORDER[i]!] = bits(3)
      if (build(PRE, PLENS)) throw fail('a code-length code that is not complete')
      for (let i = 0; i < hlit + hdist;) {
        const s = symbol(PRE)
        if (s < 16) { LENS[i++] = s; continue }
        if (s === 16 && !i) throw fail('a repeat with no length before it')
        const v = s === 16 ? LENS[i - 1]! : 0, rep = (s === 18 ? 11 : 3) + bits(PEXTRA[s]!)
        if (i + rep > hlit + hdist) throw fail('more code lengths than the block declares')
        LENS.fill(v, i, i + rep); i += rep
      }
      if (!LENS[256]) throw fail('a block with no end-of-block code')
      lit = LIT; dist = DIST
      const dl = build(DIST, LENS.subarray(hlit, hlit + hdist))
      // a block of literals alone may come with no distance code at all
      if (!usable(LIT, build(LIT, LENS.subarray(0, hlit))) || !(usable(DIST, dl) || dl === 1 << 15)) throw fail('a code that is over-subscribed or incomplete')
    }
    for (;;) {
      const s = symbol(lit)
      if (s < 256) { if (op === out.length) room(1); out[op++] = s; continue }
      if (s === 256) break
      if (s > 285) throw fail('a length code that is not one')
      // symbol() left nine bits or more unless the input ran out, so a length's extra bits (five at most) need no fill
      const len = LBASE[s - 257]! + take(LEXTRA[s - 257]!), d = symbol(dist), from = op - DBASE[d]! - bits(DEXTRA[d]!)
      if (from < 0) throw fail('a distance that reaches before the output')
      if (op + len > out.length) room(len)
      // byte by byte: the copy may overlap its own output (distance 1 repeats one byte)
      for (let i = from, end = from + len; i < end;) out[op++] = out[i++]!
    }
  } while (!last)
  if (ip - (bc >>> 3) !== n) throw fail('bytes after the final block')
  return op === out.length ? out : out.slice(0, op)
}

// ---- deflate ----

// The match search is zlib's at level 6, with zlib's numbers: how many earlier positions to try (a quarter as many
// once a match of GOOD is in hand), the length past which no better match is looked for one byte on, the length that
// ends a search, and how far away a three-byte match is still worth its distance.
const CHAIN = 128, GOOD = 8, LAZY = 16, NICE = 128, FAR = 4096
// ponytail: a block is cut after this many tokens (literals and matches), as zlib cuts it, not where the data changes
// character; a splitter would earn its keep on input that mixes kinds of data, a percent or so.
const TOKENS = 16384

// HEAD: the latest position whose three bytes hash to each value; PREV: for a position (mod the 32 KiB window), the one
// before it with the same hash. Kept across calls so that a small input does not pay for allocating them.
const HEAD = new I32(1 << 15), PREV = new I32(1 << 15)
// A block's tokens: a literal's byte with distance 0, or a match's length with its distance.
const TLEN = new U16(TOKENS), TDIST = new U16(TOKENS)
// How often the block uses each literal/length symbol, each distance symbol, and each code-length symbol.
const LFREQ = new U32(286), DFREQ = new U32(30), PFREQ = new U32(19)
// The block's code lengths run-length coded: the code-length symbols, and the extra bits of each.
const RSYM = new U8(286 + 30), REXTRA = new U8(286 + 30)

// LSYM[length] and DSYM (through dsym) give the symbol; distances past 256 share an entry per 128, as in zlib.
const LSYM = new U16(259), DSYM = new U8(512)
for (let s = 0; s < 29; s++) LSYM.fill(257 + s, LBASE[s]!, 259)
for (let s = 0; s < 30; s++) for (let d = DBASE[s]!; d <= 32768; d += d > 256 ? 128 : 1) DSYM[d > 256 ? 256 + ((d - 1) >> 7) : d - 1] = s
const dsym = (d: number) => (d > 256 ? DSYM[256 + ((d - 1) >> 7)]! : DSYM[d - 1]!)

/**
 * Huffman code lengths of at most `limit` bits for symbols used `freq` times each; an unused symbol gets 0. At least
 * two symbols get a code, so the code is complete even for a block that uses one symbol or none.
 */
function lengths(freq: Uint32Array, limit: number): Uint8Array {
  const lens = new U8(freq.length), syms: number[] = []
  for (let i = 0; i < freq.length; i++) if (freq[i]) syms.push(i)
  for (let i = 0; syms.length < 2; i++) if (!freq[i]) syms.push(i)
  syms.sort((a, b) => freq[a]! - freq[b]! || a - b)
  // Huffman's tree by two queues: leaves 0..m-1 in rising weight, then the nodes joining them, made in rising weight
  const m = syms.length, weight = new F64(2 * m), parent = new U16(2 * m), depth = new U8(2 * m), count = new U16(64)
  for (let i = 0; i < m; i++) weight[i] = freq[syms[i]!] || 1
  for (let k = m, a = 0, b = m; k < 2 * m - 1; k++)
    for (let two = 0; two < 2; two++) {
      const x = a < m && (b === k || weight[a]! <= weight[b]!) ? a++ : b++
      weight[k]! += weight[x]!; parent[x] = k
    }
  for (let i = 2 * m - 3; i >= 0; i--) depth[i] = min(63, depth[parent[i]!]! + 1)
  for (let i = 0; i < m; i++) count[depth[i]!]!++
  // Past the limit, as miniz does it: every code too long is cut to the limit, which over-subscribes the code; then,
  // until it fits, one code at the limit moves beside a shorter one, which grows a bit to make the room.
  // ponytail: not the best code within the limit (package-merge finds that). A block of 16384 tokens almost never has
  // a tree this deep, so it would matter only with far larger blocks.
  let over = -(1 << limit)
  for (let l = limit + 1; l < 64; l++) count[limit]! += count[l]!
  for (let l = 1; l <= limit; l++) over += count[l]! << (limit - l)
  for (; over > 0; over--) {
    let l = limit - 1
    while (!count[l]) l--
    count[l]!--; count[l + 1]! += 2; count[limit]!--
  }
  // the rarest symbols take the longest codes
  for (let l = limit, i = 0; l > 0; l--) for (let k = count[l]!; k > 0; k--) lens[syms[i++]!] = l
  return lens
}

/** The canonical codes for these lengths, each with its bits reversed: the form the stream takes them in. */
function codes(lens: Uint8Array): Uint16Array {
  const out = new U16(lens.length), next = new U16(16)
  for (let i = 0; i < lens.length; i++) next[lens[i]!]!++
  for (let l = 1, v = 0, k = 0; l < 16; l++) { k = next[l]!; next[l] = v; v = (v + k) << 1 }
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i]!
    if (!l) continue
    for (let b = 0, v = next[l]!++; b < l; b++) out[i]! |= ((v >> b) & 1) << (l - 1 - b)
  }
  return out
}
const FIXLC = codes(FIXLIT), FIXDC = codes(FIXDIST)

/** Raw DEFLATE (RFC 1951) of data. */
export function deflate(data: Uint8Array): Uint8Array {
  // ponytail: one pass, start to end, with no way to stop halfway. The slowest input (random bytes of a few values)
  // goes at about 6 MiB/s, so past a MiB or so the caller has to cut its data into pieces; cutting here would cost the
  // matches across the cuts.
  const n = data.length
  // No block is written larger than it would be stored, and storing costs under six bytes a block (of 16 KiB or more)
  // and five for every 64 KiB, so this is room enough for any input.
  const out = new U8(n + (n >> 11) + 64)
  let op = 0, bb = 0, bc = 0, nt = 0, start = 0
  /** Appends the low k bits of v (k <= 16). */
  const put = (v: number, k: number) => {
    bb |= v << bc; bc += k
    while (bc >= 8) { out[op++] = bb; bb >>>= 8; bc -= 8 }
  }
  const hash = (i: number) => imul((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!, 0x9e3779b1) >>> 17
  const insert = (i: number) => {
    if (i + 3 > n) return
    const h = hash(i)
    PREV[i & 32767] = HEAD[h]!; HEAD[h] = i
  }
  /** The longest earlier copy of what is at `i`, as length << 16 | distance; 0 when none is longer than `have`. */
  const find = (i: number, have: number) => {
    const top = min(258, n - i)
    if (top < 3 || have >= top) return 0
    let best = have, at = -1
    for (let j = HEAD[hash(i)]!, tries = have < GOOD ? CHAIN : CHAIN >> 2; j >= 0 && i - j <= 32768 && tries > 0; j = PREV[j & 32767]!, tries--) {
      // a longer match has to agree at `best`, so most candidates fall at the first comparison
      if (data[j + best] !== data[i + best] || data[j] !== data[i]) continue
      let l = 1
      while (l < top && data[j + l] === data[i + l]) l++
      if (l <= best) continue
      best = l; at = j
      if (l >= NICE || l === top) break
    }
    return at < 0 || (best === 3 && i - at > FAR) ? 0 : (best << 16) | (i - at)
  }
  /** Writes the tokens gathered, which stand for data[start..end), as one block of the smallest kind. */
  const block = (end: number, final: boolean) => {
    LFREQ[256] = 1
    const ll = lengths(LFREQ, 15), dl = lengths(DFREQ, 15), size = end - start
    let hlit = 286, hdist = 30, hclen = 19, runs = 0
    while (hlit > 257 && !ll[hlit - 1]) hlit--
    while (hdist > 1 && !dl[hdist - 1]) hdist--
    // the two sets of lengths as one sequence, run-length coded
    LENS.set(ll.subarray(0, hlit)); LENS.set(dl.subarray(0, hdist), hlit)
    const run = (s: number, extra: number) => { RSYM[runs] = s; REXTRA[runs++] = extra; PFREQ[s]!++ }
    for (let i = 0, all = hlit + hdist; i < all;) {
      const v = LENS[i]!
      let k = 1
      while (i + k < all && LENS[i + k] === v) k++
      i += k
      if (v) { run(v, 0); k-- }
      for (; v && k >= 3; k -= min(k, 6)) run(16, min(k, 6) - 3)
      for (; !v && k >= 11; k -= min(k, 138)) run(18, min(k, 138) - 11)
      if (!v && k >= 3) { run(17, k - 3); k = 0 }
      while (k-- > 0) run(v, 0)
    }
    const pl = lengths(PFREQ, 7), pc = codes(pl)
    while (hclen > 4 && !pl[ORDER[hclen - 1]!]) hclen--
    // each kind's size in bits, from the bit the block starts at
    let dynamic = 17 + 3 * hclen, fixed = 3
    for (let r = 0; r < runs; r++) dynamic += pl[RSYM[r]!]! + PEXTRA[RSYM[r]!]!
    for (let s = 0; s < 286; s++) {
      const extra = s > 256 ? LEXTRA[s - 257]! : 0
      dynamic += LFREQ[s]! * (ll[s]! + extra); fixed += LFREQ[s]! * (FIXLIT[s]! + extra)
    }
    for (let s = 0; s < 30; s++) { dynamic += DFREQ[s]! * (dl[s]! + DEXTRA[s]!); fixed += DFREQ[s]! * (5 + DEXTRA[s]!) }
    const stored = 3 + ((5 - bc) & 7) + 32 + 8 * size + 40 * max(0, ceil(size / 65535) - 1)
    if (stored <= min(dynamic, fixed)) {
      // data that will not compress goes out as it is, 65535 bytes at most to a block
      for (let a = start; ;) {
        const len = min(65535, end - a)
        put(final && a + len === end ? 1 : 0, 3)
        if (bc) put(0, 8 - bc)
        out[op++] = len; out[op++] = len >> 8; out[op++] = ~len; out[op++] = ~len >> 8
        out.set(data.subarray(a, a + len), op); op += len
        if ((a += len) === end) break
      }
    } else {
      const own = dynamic < fixed, lb = own ? ll : FIXLIT, lc = own ? codes(ll) : FIXLC, db = own ? dl : FIXDIST, dc = own ? codes(dl) : FIXDC
      put((final ? 1 : 0) | (own ? 4 : 2), 3)
      if (own) {
        put(hlit - 257, 5); put(hdist - 1, 5); put(hclen - 4, 4)
        for (let i = 0; i < hclen; i++) put(pl[ORDER[i]!]!, 3)
        for (let r = 0; r < runs; r++) { put(pc[RSYM[r]!]!, pl[RSYM[r]!]!); put(REXTRA[r]!, PEXTRA[RSYM[r]!]!) }
      }
      for (let t = 0; t < nt; t++) {
        const v = TLEN[t]!, d = TDIST[t]!
        if (!d) { put(lc[v]!, lb[v]!); continue }
        const s = LSYM[v]!, ds = dsym(d)
        put(lc[s]!, lb[s]!); put(v - LBASE[s - 257]!, LEXTRA[s - 257]!)
        put(dc[ds]!, db[ds]!); put(d - DBASE[ds]!, DEXTRA[ds]!)
      }
      put(lc[256]!, lb[256]!)
    }
    nt = 0; start = end
    LFREQ.fill(0); DFREQ.fill(0); PFREQ.fill(0)
  }
  /** Adds a token; `end` is where the input stands after it. */
  const token = (v: number, d: number, end: number) => {
    TLEN[nt] = v; TDIST[nt++] = d
    if (d) { LFREQ[LSYM[v]!]!++; DFREQ[dsym(d)]!++ } else LFREQ[v]!++
    if (nt === TOKENS) block(end, false)
  }
  HEAD.fill(-1)
  for (let i = 0; i < n;) {
    let m = find(i, 2)
    insert(i)
    // lazy matching: while the match one byte on is longer, this byte goes out as a literal and that match is taken
    for (let next = 0; m && m >>> 16 < LAZY && (next = find(i + 1, m >>> 16)); m = next) {
      token(data[i]!, 0, i + 1)
      insert(++i)
    }
    if (!m) { token(data[i]!, 0, ++i); continue }
    const len = m >>> 16
    for (let k = 1; k < len; k++) insert(i + k)
    token(len, m & 0xffff, (i += len))
  }
  block(n, true)
  if (bc) put(0, 8 - bc)
  return out.slice(0, op)
}
