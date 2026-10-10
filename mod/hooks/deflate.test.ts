import { expect, test } from 'claude-code/testing'
import { deflate, inflate } from './deflate'

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0))
/** Bytes as a string, a char each: what the tables below hold. */
const chars = (x: Uint8Array) => {
  let s = ''
  for (let i = 0; i < x.length; i++) s += String.fromCharCode(x[i]!)
  return s
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
/** Bit strings, first bit lowest, as bytes: the order DEFLATE lays its bits in. */
const packed = (bits: string) => {
  const out = new Uint8Array((bits.length + 7) >> 3)
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') out[i >> 3]! |= 1 << (i & 7)
  return out
}

/** Random numbers from a seed (mulberry32). */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rnd = rng(1), ri = (k: number) => Math.floor(rnd() * k), pick = <T>(of: readonly T[]) => of[ri(of.length)]!
const noise = (n: number, alphabet = 256) => Uint8Array.from({ length: n }, () => ri(alphabet))

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
 * lopsided enough for Huffman trees deeper than the format allows. tools/deflate-check.ts has the same function.
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

// zlib 1.2.12 wrote these, through python (tools/deflate-check.ts --vectors)
const ZLIB = {
  stored: 'AR0A4v9zdG9yZWQ6IHRoZSBieXRlcyBhcyB0aGV5IGFyZQ==',
  fixed: 'S8usSE1RSM5PSS3WUUjDwbFSyMtXKElMyklVKMlXKE7NSwEA',
  dynamic: 'JZHJAcQwCANboQRzGEz/je0o+zIJAgZxzK1szdviWrbVWpc9Nz/HPHiryKJYJGji8r61jEJPNboq3ld2Y+1OW6Nr3uF7+P/IL7pt9aXQDx3caeXq6UFzT00p' +
    'jbua2wJokQxE/koMEMYRhYs4zlrkKYs6DhkV0YpG/56yiy5VkfQXNORJvyw6p2bkMC0fc3MhqANLiaoSvipIq2Gu0bZa4x72ua6FUxuTsaud7yha/vUhS5Xj' +
    'JhV9qe2hSz/6zbkyh4phps1l7gwEs7A8Wf8Cvle6RcP8HvSrPVAQQYmbbLnvfLeSWSe+uI4MbhTYjNhdde6Riks+estSf3I3/pdOeR5X9sfoErHfUb77ZN3v' +
    'QLparg5Y3v4D',
  everyLength: 'BOFBrWzbtm1LKvSll7jpA2IvNtMHmg6nwamFjUEIs//f//f//b//9//+7//+7//+73//+9///ve///3vv//++++///7777///vvvv3///v379+/fv3///v37' +
    '9+/fv3///v379/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f7/X6/3+/3+/1+v9/v9/v9fr/f7/f7/X6/3+/3+/1+v9/v9/v9fr/f7/f7/X6/' +
    '3+/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu/7vu9777333nvvvffee++9995777333nvv' +
    'vffee++9995777333nvvvffee++9995777333nvvvffee++9995777333nvvvffee++9995777333nvvvffee++99967u7u7u7u7u7u7u7u7u7u7u7u7u7u7' +
    'u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7' +
    'u7u7u7tt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt' +
    '27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27Zt27ZVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVRUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+/wAAAP//BcEHAQAADAKgrOo8/RMMQJ3TgTqn' +
    'A3VOB+qcDtQ5HahzOlDndKDO6UCd04E6pwN1TgfqnO4B',
}

// Streams the same tool put together bit by bit, for what no compressor writes: [what it is, the stream, the bytes
// zlib reads from it]. No bytes: zlib refuses the stream, or stops before its end.
const CRAFTED: [string, string, string?][] = [
  ['stored: no bytes at all', 'AQAA//8=', ''],
  ['stored: bits set in the padding before the length', '+QEA/v9h', 'a'],
  ['stored: a length whose check fails', 'AQEA/f9h'],
  ['stored: fewer bytes than the length says', 'AQIA/f9h'],
  ['a block of the type that does not exist', 'Bw=='],
  ['fixed: the end of block and nothing else', 'AwA=', ''],
  ['fixed: bits set after the end, within the last byte', 'A/w=', ''],
  ['fixed: a byte after the final block', 'AwAA'],
  ['fixed: a block that is not the last, and then nothing', 'SgQA'],
  ['an empty stored block that is not the last, then a fixed one', 'AAAA//9LBAA=', 'a'],
  ['fixed: a match of 258 that overlaps itself at distance 1', 'SxwFAA==', 'a'.repeat(259)],
  ['fixed: a distance that reaches the first byte', 'S0wCQgA=', 'ababa'],
  ['fixed: a distance one byte past the first', 'S0wCIgA='],
  ['fixed: a match before any byte', 'AwIA'],
  ['fixed: length code 286', 'SxwDAA=='],
  ['fixed: length code 287', 'SxwHAA=='],
  ['fixed: distance code 30', 'SwQ+AA=='],
  ['fixed: distance code 31', 'SwR+AA=='],
  ['fixed: 258 bytes from distance 32768', 'q0gcBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAK' +
    'RsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEw' +
    'CkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsHo/f8A', 'x' + 'a'.repeat(32767) + 'x' + 'a'.repeat(257)],
  ['fixed: distance 32768 with 32767 bytes to reach into', 'SxwFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApG' +
    'wSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAK' +
    'RsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGAfD+fwA='],
  ['dynamic: one code of one bit, for the end of block', 'BeDbkiRJkizL/v9fIwA=', ''],
  ['dynamic: literals and no distance code at all', 'BeDbkiRJkizLfiv+/08gEA==', 'aa'],
  ['dynamic: one distance code, of one bit', 'DeDbkiRJkizLfiv+/08QoQU=', 'aaaa'],
  ['dynamic: the bit a lone distance code leaves unused', 'DeDbkiRJkizLfiv+/08QoQc='],
  ['dynamic: a match when there is no distance code', 'DeDbkiRJkizLfiv+/08QgQU='],
  ['dynamic: one distance code, of two bits', 'BeDbkiRJkizLfiv+/08gBQ=='],
  ['dynamic: an incomplete distance code', 'BeHbkiRJkizLfiv+/08gUQ=='],
  ['dynamic: an over-subscribed distance code', 'BeLbkiRJkizLfiv+/08gIgY='],
  ['dynamic: an incomplete literal/length code', 'BeDbkiRJkizLfiv9/08QCA=='],
  ['dynamic: an over-subscribed literal/length code', 'BeDbkiRJkizLfivi/38EQg=='],
  ['dynamic: no code for the end of block', 'BeDbkiRJkizLfivi/38F'],
  ['dynamic: 286 literal/length codes and 30 distance codes', '7f3bkiRJkizLfiv+/0/QjxD+CFo=', 'a'.repeat(259)],
  ['dynamic: 287 literal/length codes', '9eDbkiRJkizLfiv+/0/gpwQ='],
  ['dynamic: 31 distance codes', 'Bf7bkiRJkizLfiv+/08g4pcE'],
  ['dynamic: an incomplete code-length code', 'BeABCAAAAAAgIA=='],
  ['dynamic: a code-length code of one code', 'BeABBAAAAAAAAA=='],
  ['dynamic: an over-subscribed code-length code', 'BeABBAAAAEAQCA=='],
  ['dynamic: a repeat with no length before it', 'BeDbkiRJkizLXgA='],
  ['dynamic: zeros running past the last code', 'BeDbkiRJkizL/v93Aw=='],
  ['dynamic: a repeat running past the last code', 'BeDbkiRJkizL/v9P4x0='],
  ['dynamic: a repeat running from the literal lengths into the distance lengths', 'DePbkiRJkizLfiv9/+sH0B03', 'a\xffa\xffa'],
  ['dynamic: zeros running from the literal lengths into the distance lengths', 'HeLbkiRJkizLfiv+/08QvSAW', 'aaaaaa'],
]

test('inflate gives back what deflate took: a seeded fuzz over random, repetitive and lopsided bytes', async () => {
  const back = (x: Uint8Array, what: string) => expect(same(inflate(deflate(x)), x), what).toBe(true)
  for (let round = 0; round < 300; round++) {
    const alphabet = pick([1, 2, 3, 4, 16, 64, 256])
    back(round & 1 ? woven(ri(5000), alphabet) : noise(ri(1500), alphabet), `round ${round}`)
  }
  // enough tokens for several blocks, copies from the far end of the window, the longest runs, and text
  back(woven(200_000, 4), 'woven, 4 values'); back(woven(200_000, 256), 'woven, 256 values'); back(new Uint8Array(200_000), 'zeros')
  back(new TextEncoder().encode(Array.from({ length: 8000 }, (_, i) => `record ${(i * 7919) % 1000} is ${pick(['proposed', 'accepted', 'dropped'])}`).join('\n')), 'text')
})

test('deflate keeps to the format at its edges: nothing, one symbol, bytes that will not compress, a full block, both length limits', async () => {
  const back = (x: Uint8Array, what: string) => {
    const d = deflate(x)
    expect(same(inflate(d), x), what).toBe(true)
    return d.length
  }
  expect(chars(deflate(new Uint8Array(0)))).toBe('\x03\x00')
  for (const n of [1, 2, 3, 4, 258, 259, 1000]) back(new Uint8Array(n).fill(7), `${n} bytes alike`)
  // stored blocks are the worst it does: five bytes for each 16 KiB or less
  for (const n of [65535, 65536, 131073]) expect(back(noise(n), `${n} random bytes`)).toBeLessThanOrEqual(n + 5 * (1 + (n >> 14)) + 1)
  // 16384 literals fill a block to its last token: it goes out stored, and the stream ends on an empty block
  expect(back(unrepeated(16384), 'a block exactly full')).toBe(16384 + 5 + 2)
  // a code that would pass 15 bits, and a code-length code that would pass 7: tools/deflate-check.ts counts that these two get there
  back(skewed(30, 3, 400000, 9), 'the 15-bit limit'); back(skewed(127, 1.08, 6000, 2, 2), 'the 7-bit limit')
})

test('inflate reads what real zlib wrote: a stored, a fixed and a dynamic block, and codes of every length', async () => {
  expect(chars(inflate(bytes(ZLIB.stored)))).toBe('stored: the bytes as they are')
  expect(chars(inflate(bytes(ZLIB.fixed)))).toBe('fixed codes, fixed codes, fixed codes: no table to send')
  expect(chars(inflate(bytes(ZLIB.dynamic)))).toBe(Array.from({ length: 120 }, (_, i) => i * i).join(' '))
  // 15 byte values, 1, 2, 3, 5, 8 ... 987 of each: codes of 1 to 15 bits, and between the values runs of unused ones
  // of every size. Then a second block: eight values as often as each other, for the code that repeats a length.
  let deep = ''
  for (let k = 0, a = 1, b = 2; k < 15; k++, [a, b] = [b, a + b]) deep += String.fromCharCode([1, 3, 6, 10, 20, 40, 41, 80, 81, 82, 120, 160, 200, 201, 240][k]!).repeat(a)
  expect(chars(inflate(bytes(ZLIB.everyLength)))).toBe(deep + 'abcdefgh'.repeat(12))
})

test('inflate takes the streams zlib takes and refuses the ones zlib refuses', async () => {
  for (const [what, stream, want] of CRAFTED) {
    if (want === undefined) expect(() => inflate(bytes(stream)), what).toThrow(/^inflate: /)
    else expect(chars(inflate(bytes(stream))), what).toBe(want)
  }
})

test('a stream cut short throws; a damaged one throws or returns, never hangs, and throws no error but its own', async () => {
  const sound: Uint8Array[] = [...Object.values(ZLIB), ...CRAFTED.flatMap(([, stream, want]) => (want === undefined || want.length > 4000 ? [] : [stream]))].map(bytes)
  sound.push(deflate(noise(300, 4)), deflate(woven(600, 26)), deflate(skewed(24, 1.62, 3000, 1, 5)))
  let read = 0
  for (const s of sound) {
    for (let n = 0; n < s.length; n++) expect(() => inflate(s.subarray(0, n)), `${n} bytes of ${s.length}`).toThrow(/the stream is cut short/)
    // every bit of the short ones in turn
    for (let bit = 0; bit < s.length * 8 && s.length < 400; bit++) {
      const damaged = s.slice()
      damaged[bit >> 3]! ^= 1 << (bit & 7)
      try {
        inflate(damaged)
        read++
      } catch (e) {
        expect(e instanceof Error && e.message.startsWith('inflate: '), String(e)).toBe(true)
      }
    }
  }
  expect(read).toBeGreaterThan(0) // DEFLATE carries no checksum: a flipped bit often still reads, as other bytes
})

test('inflate stops at its limit, which is 64 MiB unless given', async () => {
  const x = noise(5000, 4), d = deflate(x)
  expect(inflate(d, 5000).length).toBe(5000)
  expect(() => inflate(d, 4999)).toThrow(/the output passes 4999 bytes/)
  // a fixed block: a zero, 260112 copies of 258 bytes from one byte back, the end. 33 bytes over 64 MiB, from 413 KiB
  const bomb = packed('110' + '00110000' + '1100010100000'.repeat(260_112) + '0000000')
  expect(() => inflate(bomb)).toThrow(/the output passes 67108864 bytes/)
  expect(() => inflate(bomb, 1 << 20)).toThrow(/the output passes 1048576 bytes/)
})
