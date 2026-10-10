import { deflate, inflate } from './deflate'
import { type Change, type Kind, type Status, KINDS, STATUSES, bytesOf, idOf } from './spec'

// Spec packs: the sealed, compressed form of a set of changes. Pure logic over bytes; the caller reads and writes the
// files and names each by the hash of its bytes, so one set of changes must always give the same bytes. This comment
// is the format's specification; tools/aesp.py reads the same format without the mod, and tools/pack-check.ts holds
// the two to each other.
//
// FORMAT, version 1
//   file    = "AESP" 0x00 0x01 , block+
//   block   = rawLength:varint , packedLength:varint , CRC-32 of the raw bytes:u32 little-endian , raw DEFLATE (RFC 1951) of the raw bytes
//   payload = the blocks' raw bytes joined = strings , writers , changes , and nothing after
//   strings = count:varint , { byteLength:varint , UTF-8 bytes }     every text value, once, referred to by its index from 0
//   writers = count:varint , { 6 bytes of writer id , by:string index , via:string index }
//   changes = count:varint , { change }                               sorted by (ms, n, writer, id, the other fields)
//   change  = 8 bytes of record id , ms:varint , n:varint , writer:varint index , fieldCount:varint , { field }
//   field   = tag:varint , byteLength:varint , bytes
//   varint  = unsigned LEB128 in at most 8 bytes, of a value at most 2^53 - 1, with no zero byte padding it out
// ms is the milliseconds since 1970 less those of the change before (less 0 for the first): never negative, since
// changes are sorted. A string index is a varint.
//   tag 1 kind    one byte, an index into KINDS (area, spec, decision)
//   tag 2 under   the parent's 8 id bytes, or no bytes for the root
//   tag 3 title   a string index
//   tag 4 why     a string index
//   tag 5 status  one byte, an index into STATUSES (proposed, accepted, superseded, dropped), then the 8 id bytes of replacedBy or nothing
//   tag 6 ref     one byte "+" or "-", then a string index for the rest; once per ref, in the change's order
// A writer puts a change's fields in tag order. A reader takes them in any order, skips a tag it does not know by its
// length, and refuses one of tags 1 to 5 given twice or any known tag whose bytes are not exactly its value.
// LIMITS a reader holds: a block's raw bytes number 1 to 262144 and every block but the last is full; a file has at
// most 16 blocks (4 MiB of payload); packedLength is at most rawLength + rawLength/8 + 64, which any DEFLATE writer
// stays under; a count is no more than what is left could hold; strings are well-formed UTF-8.
// A reader takes any DEFLATE stream of a block's raw bytes, not only the one pack writes, and DEFLATE leaves a few
// bits unread (after its last code, and before a stored block): two files can hold the same changes, and a flip of
// such a bit passes every check here. What says a file is the one that was sealed is the hash in its name.
// An id is 8 bytes read as 13 groups of bits from the top, 4 then twelve times 5, each a character of a-z2-7; a
// writer id is 6 bytes as 12 lowercase hex characters.
//
// WHAT PACK NORMALISES, so that equal changes give equal bytes: a replacedBy of "" is the same as none, and unpack
// gives none (what spec.ts's clean gives); refs of [] is the same as no refs; half of a surrogate pair in a text
// becomes U+FFFD, as UTF-8 cannot carry it; properties Change does not name are dropped. Everything else comes back
// as it went in, including `under` without `kind` and a change that sets nothing.

// The engine's namespaces are slow to read from a loop, so what a loop needs of them is taken once, here.
const U8 = Uint8Array, MapOf = Map, SetOf = Set, Fail = Error, hex = parseInt
const { floor, min, max } = Math, { isSafeInteger, MAX_SAFE_INTEGER: MAX } = Number, { isArray } = Array, { stringify } = JSON
const enc = new TextEncoder(), dec = new TextDecoder()

/** A pack's first six bytes: "AESP", a NUL so that no tool takes the file for text, and the format version. */
export const MAGIC: Uint8Array = new U8([0x41, 0x45, 0x53, 0x50, 0, 1])

const BLOCK = 256 << 10, BLOCKS = 16, NONE = new U8(0)
const WRITER = /^[0-9a-f]{12}$/
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

// CRC-32 as zlib and PNG compute it: polynomial 0xedb88320, bits reflected, start and end inverted.
const CRC = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[i] = c
}
function crc32(d: Uint8Array): number {
  let c = -1
  for (let i = 0, n = d.length; i < n; i++) c = CRC[(c ^ d[i]!) & 255]! ^ (c >>> 8)
  return ~c >>> 0
}

// ---- writing ----

// One buffer for the call in hand; pack is synchronous, so two calls never share it.
let out: Uint8Array = NONE, len = 0
function room(n: number) {
  if (len + n <= out.length) return
  const grown = new U8(max(2 * out.length, len + n, 1 << 12))
  grown.set(out.subarray(0, len))
  out = grown
}
/** Writes a varint. Milliseconds pass 32 bits, so the number is taken apart by division, not by shifts. */
function num(v: number) {
  room(8)
  for (; v >= 128; v = floor(v / 128)) out[len++] = (v % 128) | 128
  out[len++] = v
}
function raw(b: Uint8Array) {
  room(b.length)
  out.set(b, len)
  len += b.length
}
/** How many bytes a varint takes. */
function size(v: number): number {
  let n = 1
  for (; v >= 128; v = floor(v / 128)) n++
  return n
}
/** How many bytes a text takes as UTF-8, half pairs counted as the U+FFFD they become. */
function utf8(s: string): number {
  let n = 0
  for (let i = 0, end = s.length; i < end; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < end && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) n += 4, i++
    else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}

/**
 * A text with every half of a surrogate pair that lacks its other half made U+FFFD, as UTF-8 would have it. Spelled
 * out because the engine's /[\ud800-\udfff]/u misses a first half that stands before U+E000 to U+FFFF.
 */
function text(s: string): string {
  let out = '', from = 0
  for (let i = 0, n = s.length; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c < 0xd800 || c > 0xdfff) continue
    if (c < 0xdc00 && i + 1 < n && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++
    else (out += `${s.slice(from, i)}\ufffd`), (from = i + 1)
  }
  return from ? out + s.slice(from) : s
}
function refuse(i: number, what: string): never {
  throw new Fail(`pack: change ${i} ${what}`)
}

/** A change as a pack holds it, a new object with its fields in a fixed order; throws for one a pack cannot hold. `i` is its place, for the message. */
function norm(c: Change, i: number): Change {
  if (typeof c !== 'object' || c === null) refuse(i, 'is not a change')
  const { id, at, writer, by, via, kind, under, title, why, status, replacedBy, refs } = c
  if (typeof id !== 'string' || !bytesOf(id)) refuse(i, `has an id that is not one: ${stringify(id)}`)
  if (typeof writer !== 'string' || !WRITER.test(writer)) refuse(i, `has a writer that is not 12 hex characters: ${stringify(writer)}`)
  if (typeof at !== 'object' || at === null || !isSafeInteger(at.ms) || at.ms < 0 || !isSafeInteger(at.n) || at.n < 0)
    refuse(i, `has a stamp that is not two whole numbers from 0 up: ${stringify(at)}`)
  if (typeof by !== 'string' || typeof via !== 'string') refuse(i, 'has a by or via that is not text')
  const o: Change = { id, at: { ms: at.ms, n: at.n }, writer, by: text(by), via: text(via) }
  if (kind !== undefined) KINDS.includes(kind) ? (o.kind = kind) : refuse(i, `has a kind off the list: ${stringify(kind)}`)
  if (under !== undefined) under === '' || (typeof under === 'string' && bytesOf(under)) ? (o.under = under) : refuse(i, `is under an id that is not one: ${stringify(under)}`)
  if (title !== undefined) typeof title === 'string' ? (o.title = text(title)) : refuse(i, 'has a title that is not text')
  if (why !== undefined) typeof why === 'string' ? (o.why = text(why)) : refuse(i, 'has a why that is not text')
  if (status !== undefined) STATUSES.includes(status) ? (o.status = status) : refuse(i, `has a status off the list: ${stringify(status)}`)
  if (replacedBy !== undefined && replacedBy !== '') {
    if (typeof replacedBy !== 'string' || !bytesOf(replacedBy)) refuse(i, `is replaced by an id that is not one: ${stringify(replacedBy)}`)
    // the two are one register and one field of the format
    if (status === undefined) refuse(i, 'has a replacedBy and no status')
    o.replacedBy = replacedBy
  }
  if (refs !== undefined) {
    if (!isArray(refs)) refuse(i, 'has refs that are not a list')
    for (const r of refs) if (typeof r !== 'string' || (r[0] !== '+' && r[0] !== '-')) refuse(i, `has a ref that does not open with + or -: ${stringify(r)}`)
    if (refs.length) o.refs = refs.map(text)
  }
  return o
}

/** What tells two changes with one stamp, writer and id apart. */
const rest = (c: Change) => stringify([c.by, c.via, c.kind, c.under, c.title, c.why, c.status, c.replacedBy, c.refs])

/** The order of a pack: wall time, counter, writer, id, then the text of the other fields. 0 only for two changes equal in every field. */
function cmp(a: Change, b: Change): number {
  const d = a.at.ms - b.at.ms || a.at.n - b.at.n
  if (d !== 0) return d
  if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  const x = rest(a), y = rest(b)
  return x < y ? -1 : x > y ? 1 : 0
}

type Pair = { c: Change; from: Change }
/** Each change normalised beside the one it came from, in pack order, equal ones once. */
function sorted(changes: readonly Change[]): Pair[] {
  const all = changes.map((from, i): Pair => ({ c: norm(from, i), from })).sort((a, b) => cmp(a.c, b.c))
  return all.filter((p, i) => i === 0 || cmp(all[i - 1]!.c, p.c) !== 0)
}

/** The key of a writers entry: the id is 12 characters and `by` is counted, so no two entries share one. */
const seat = (c: Change) => `${c.writer}${c.by.length}:${c.by}${c.via}`

/** The payload of normalised, sorted changes. Strings are numbered as they are first met, walking the changes in order: by and via where a writer is new, then title, why and the refs. */
function payload(rows: readonly Change[]): Uint8Array {
  const strings = new MapOf<string, number>(), seats = new MapOf<string, number>(), who: [string, number, number][] = []
  const str = (s: string) => {
    let i = strings.get(s)
    if (i === undefined) strings.set(s, (i = strings.size))
    return i
  }
  const sat = rows.map(c => {
    const key = seat(c)
    let w = seats.get(key)
    if (w === undefined) seats.set(key, (w = who.length)), who.push([c.writer, str(c.by), str(c.via)])
    if (c.title !== undefined) str(c.title)
    if (c.why !== undefined) str(c.why)
    if (c.refs) for (const r of c.refs) str(r.slice(1))
    return w
  })
  len = 0
  num(strings.size)
  for (const s of strings.keys()) {
    const b = enc.encode(s)
    num(b.length), raw(b)
  }
  num(who.length)
  for (const [w, by, via] of who) {
    room(6)
    for (let k = 0; k < 12; k += 2) out[len++] = hex(w.slice(k, k + 2), 16)
    num(by), num(via)
  }
  num(rows.length)
  const index = (tag: number, s: string) => {
    const i = strings.get(s)!
    num(tag), num(size(i)), num(i)
  }
  let ms = 0
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r]!, { kind, under, title, why, status, replacedBy, refs } = c
    raw(bytesOf(c.id)!)
    num(c.at.ms - ms), num(c.at.n), num(sat[r]!)
    ms = c.at.ms
    num(+(kind !== undefined) + +(under !== undefined) + +(title !== undefined) + +(why !== undefined) + +(status !== undefined) + (refs?.length ?? 0))
    if (kind !== undefined) num(1), num(1), num(KINDS.indexOf(kind))
    if (under !== undefined) num(2), num(under ? 8 : 0), raw(under ? bytesOf(under)! : NONE)
    if (title !== undefined) index(3, title)
    if (why !== undefined) index(4, why)
    if (status !== undefined) num(5), num(replacedBy ? 9 : 1), num(STATUSES.indexOf(status)), raw(replacedBy ? bytesOf(replacedBy)! : NONE)
    if (refs)
      for (const ref of refs) {
        const i = strings.get(ref.slice(1))!
        num(6), num(1 + size(i)), num(ref.charCodeAt(0)), num(i)
      }
  }
  return out.slice(0, len)
}

/** The bytes of a pack holding changes, the same bytes whatever order they are given in. */
export function pack(changes: readonly Change[]): Uint8Array {
  try {
    const data = payload(sorted(changes).map(p => p.c))
    if (data.length > BLOCK * BLOCKS)
      throw new Fail(`pack: ${data.length} bytes of changes are more than the ${BLOCK * BLOCKS} one pack holds; cut them with batches first`)
    len = 0
    raw(MAGIC)
    for (let a = 0; a < data.length; a += BLOCK) {
      const piece = data.subarray(a, min(a + BLOCK, data.length)), packed = deflate(piece), crc = crc32(piece)
      num(piece.length), num(packed.length)
      room(4)
      for (let k = 0; k < 4; k++) out[len++] = (crc >>> (8 * k)) & 255
      raw(packed)
    }
    return out.slice(0, len)
  } finally {
    out = NONE
  }
}

// ---- reading ----

// What is being read: `end` moves in to a field's last byte while the field is read, so nothing reads past it.
let src: Uint8Array = NONE, pos = 0, end = 0
/** The place of the next n bytes, stepped over. */
function take(n: number): number {
  if (n > end - pos) throw new Fail('pack: cut short')
  pos += n
  return pos - n
}
function int(): number {
  let v = 0, unit = 1
  for (let k = 0; k < 8; k++, unit *= 128) {
    if (pos >= end) throw new Fail('pack: cut short')
    const b = src[pos++]!
    v += (b & 127) * unit
    if (b >= 128) continue
    if ((b === 0 && k > 0) || v > MAX) break
    return v
  }
  throw new Fail('pack: a number that is padded, over eight bytes or past 2^53')
}
/** A count of things at least `least` bytes each; one that what is left could not hold is refused before anything is set aside for it. */
function count(least: number, what: string): number {
  const n = int()
  if (n * least > end - pos) throw new Fail(`pack: ${n} ${what} cannot fit in the ${end - pos} bytes left`)
  return n
}
const id = () => idOf(src.subarray(take(8), pos))

/** Whether the bytes from `at` to `stop` are well-formed UTF-8: every sequence whole, none longer than it need be, no half of a surrogate pair, nothing past U+10FFFF. */
function wellFormed(d: Uint8Array, at: number, stop: number): boolean {
  while (at < stop) {
    const b = d[at++]!
    if (b < 0x80) continue
    // how many bytes follow this one, and the range the first of them must be in (the Unicode standard's table 3-7)
    let more = 1, lo = 0x80, hi = 0xbf
    if (b >= 0xe0 && b <= 0xef) more = 2, b === 0xe0 ? (lo = 0xa0) : b === 0xed && (hi = 0x9f)
    else if (b >= 0xf0 && b <= 0xf4) more = 3, b === 0xf0 ? (lo = 0x90) : b === 0xf4 && (hi = 0x8f)
    else if (b < 0xc2 || b > 0xdf) return false
    if (at + more > stop || d[at]! < lo || d[at]! > hi) return false
    for (at++; --more; at++) if ((d[at]! & 0xc0) !== 0x80) return false
  }
  return true
}
// The engine's decoder drops a byte order mark that opens the bytes; a text may open with one, so it is put back.
const DROPS = dec.decode(new U8([0xef, 0xbb, 0xbf])) === ''
function decode(d: Uint8Array, at: number, stop: number): string {
  const s = dec.decode(d.subarray(at, stop))
  return DROPS && stop - at >= 3 && d[at] === 0xef && d[at + 1] === 0xbb && d[at + 2] === 0xbf ? `\ufeff${s}` : s
}

/** The blocks' raw bytes, joined; every length is bounded and every checksum held before a byte is believed. */
function open(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 6 || MAGIC.some((m, i) => i < 5 && bytes[i] !== m) || bytes[5] === 0)
    throw new Fail('pack: not a pack: it does not open with "AESP", a NUL and a version')
  if (bytes[5]! > MAGIC[5]!) throw new Fail(`pack: version ${bytes[5]} is newer than this reader, which reads up to ${MAGIC[5]}`)
  src = bytes, pos = 6, end = bytes.length
  const parts: Uint8Array[] = []
  let total = 0
  for (let b = 0; pos < end || b === 0; b++) {
    if (total !== b * BLOCK) throw new Fail(`pack: block ${b} follows one that is not full`)
    if (b === BLOCKS) throw new Fail(`pack: more than ${BLOCKS} blocks`)
    const size = int(), packed = int()
    if (size < 1 || size > BLOCK) throw new Fail(`pack: block ${b} says it holds ${size} bytes; a block holds 1 to ${BLOCK}`)
    if (packed > size + floor(size / 8) + 64) throw new Fail(`pack: block ${b} is ${packed} bytes packed, too many for the ${size} it holds`)
    const at = take(4), crc = (src[at]! | (src[at + 1]! << 8) | (src[at + 2]! << 16) | (src[at + 3]! << 24)) >>> 0, from = take(packed)
    let piece: Uint8Array
    try {
      piece = inflate(bytes.subarray(from, from + packed), size)
    } catch (e) {
      throw new Fail(`pack: block ${b} is damaged (${e instanceof Fail ? e.message : e})`)
    }
    if (piece.length !== size) throw new Fail(`pack: block ${b} holds ${piece.length} bytes and says ${size}`)
    if (crc32(piece) !== crc) throw new Fail(`pack: block ${b} fails its checksum`)
    parts.push(piece), (total += size)
  }
  if (parts.length === 1) return parts[0]!
  const all = new U8(total)
  let at = 0
  for (const p of parts) all.set(p, at), (at += p.length)
  return all
}

/** The changes a pack holds, in the order pack wrote them. Throws, saying what is wrong, for bytes that are not a pack, a pack of a newer version, or a damaged block; a field it does not know is skipped. */
export function unpack(bytes: Uint8Array): Change[] {
  try {
    src = open(bytes), pos = 0, end = src.length
    const strings = new Array<string>(count(1, 'strings'))
    for (let i = 0; i < strings.length; i++) {
      const n = int(), at = take(n)
      if (!wellFormed(src, at, pos)) throw new Fail(`pack: string ${i} is not UTF-8`)
      strings[i] = decode(src, at, pos)
    }
    const str = (): string => {
      const s = strings[int()]
      if (s === undefined) throw new Fail('pack: a string index past the table')
      return s
    }
    const who = new Array<[string, string, string]>(count(8, 'writers'))
    for (let i = 0; i < who.length; i++) {
      let w = ''
      for (let k = take(6); k < pos; k++) w += HEX[src[k]!]
      who[i] = [w, str(), str()]
    }
    const changes = new Array<Change>(count(12, 'changes'))
    let ms = 0
    for (let i = 0; i < changes.length; i++) {
      const c: Change = { id: id(), at: { ms: (ms += int()), n: int() }, writer: '', by: '', via: '' }, w = who[int()]
      if (ms > MAX) throw new Fail(`pack: change ${i} is stamped past 2^53`)
      if (!w) throw new Fail(`pack: change ${i} names a writer past the table`)
      ;[c.writer, c.by, c.via] = w
      let kind: Kind | undefined, under: string | undefined, title: string | undefined, why: string | undefined
      let status: Status | undefined, replacedBy: string | undefined, refs: string[] | undefined, seen = 0
      for (let f = count(2, 'fields'); f > 0; f--) {
        const tag = int(), n = int(), outer = end, stop = take(n) + n
        pos = stop - n, end = stop
        if (tag >= 1 && tag <= 5 && seen & (1 << tag)) throw new Fail(`pack: change ${i} gives field ${tag} twice`)
        seen |= tag <= 5 ? 1 << tag : 0
        if (tag === 1) kind = KINDS[src[take(1)]!]
        else if (tag === 2) under = n ? id() : ''
        else if (tag === 3) title = str()
        else if (tag === 4) why = str()
        else if (tag === 5) (status = STATUSES[src[take(1)]!]), (replacedBy = pos < end ? id() : undefined)
        else if (tag === 6) {
          const sign = src[take(1)]!
          if (sign !== 43 && sign !== 45) throw new Fail(`pack: change ${i} has a ref that is neither added nor removed`)
          ;(refs ??= []).push((sign === 43 ? '+' : '-') + str())
        } else pos = stop
        if (pos !== stop || (tag === 1 && !kind) || (tag === 5 && !status)) throw new Fail(`pack: change ${i} has a field ${tag} that is not one`)
        end = outer
      }
      if (kind) c.kind = kind
      if (under !== undefined) c.under = under
      if (title !== undefined) c.title = title
      if (why !== undefined) c.why = why
      if (status) c.status = status
      if (replacedBy) c.replacedBy = replacedBy
      if (refs) c.refs = refs
      changes[i] = c
    }
    if (pos !== end) throw new Fail(`pack: ${end - pos} bytes after the last change`)
    return changes
  } finally {
    src = NONE
  }
}

/**
 * Cuts changes into groups that each pack to roughly limit bytes of raw payload or less, so one pack call stays quick
 * and one file stays small. The default is one block, 256 KiB. The groups hold the changes as given, in pack order
 * and equal ones once, so the same changes are always cut the same way; a change larger than limit is a group of its
 * own. Throws for a change pack would refuse.
 */
// ponytail: the sort is one synchronous piece of work, n log n in all the changes; past about a hundred thousand the
// caller should cut by file first.
export function batches(changes: readonly Change[], limit: number = BLOCK): Change[][] {
  const groups: Change[][] = [], strings = new SetOf<string>(), seats = new SetOf<string>()
  const str = (s: string) => {
    if (strings.has(s)) return 0
    const n = utf8(s)
    return strings.add(s), n + size(n)
  }
  // an upper bound on what a change adds to its group's payload: exact but for an index, taken as its widest, 3 bytes
  const cost = (c: Change, ms: number) => {
    let n = 8 + size(c.at.ms - ms) + size(c.at.n) + 3 + size(5 + (c.refs?.length ?? 0))
    const key = seat(c)
    if (!seats.has(key)) seats.add(key), (n += 12 + str(c.by) + str(c.via))
    if (c.kind !== undefined) n += 3
    if (c.under !== undefined) n += 10
    if (c.title !== undefined) n += 5 + str(c.title)
    if (c.why !== undefined) n += 5 + str(c.why)
    if (c.status !== undefined) n += 11
    if (c.refs) for (const r of c.refs) n += 6 + str(r.slice(1))
    return n
  }
  let group: Change[] = [], used = 12, ms = 0
  for (const { c, from } of sorted(changes)) {
    let n = cost(c, ms)
    if (used + n > limit && group.length) {
      groups.push(group), strings.clear(), seats.clear()
      group = [], used = 12, n = cost(c, 0)
    }
    group.push(from), (used += n), (ms = c.at.ms)
  }
  if (group.length) groups.push(group)
  return groups
}
