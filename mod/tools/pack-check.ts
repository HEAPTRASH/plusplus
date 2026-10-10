// Holds hooks/pack.ts and tools/aesp.py to each other, then reports what a pack saves. Development only: it needs bun,
// the file system and python3 (every distinct python3 it finds is used; /usr/bin/python3 is often an older one).
//   bun tools/pack-check.ts [sets]    sets: how many random sets of changes to cross-check, 3000 unless given
// 1. each random set is packed, written under the name its hash gives it, dumped and verified by aesp.py, and the
//    dump compared, as text, with the changes that went in and with what unpack reads;
// 2. packs are damaged (a bit flipped, cut short, a byte added, the version raised) and both readers must refuse the
//    same files, and aesp.py verify must refuse any file whose name is no longer its hash; a damaged pack that is
//    read must be a flip of a bit DEFLATE does not read, and give the payload and the changes of the sound one;
// 3. aesp.py is run from a folder that holds modules named like the ones it imports, which must not run;
// 4. a realistic set of 2,000 changes is sized as JSON lines, as gzip of those, and as packs, and timed.
// Exits 1 on any failure.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { inflate } from '../hooks/deflate.ts'
import { batches, pack, unpack } from '../hooks/pack.ts'
import { type Change, KINDS, STATUSES, clean, idOf, toLine } from '../hooks/spec.ts'

const HERE = import.meta.dir, AESP = join(HERE, 'aesp.py'), DIR = mkdtempSync(join(tmpdir(), 'pack-check-'))
const SETS = Number(process.argv[2] ?? 3000)

let checks = 0
const failed: string[] = []
const check = (ok: boolean, what: string) => { checks++; if (!ok && failed.length < 40) failed.push(what.slice(0, 400)) }

/** A seeded generator, so a failure is the same failure on every run. */
const dice = (a: number) => (n: number) => {
  a = (a + 0x6d2b79f5) | 0
  let x = Math.imul(a ^ (a >>> 15), a | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) % n
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const tried = <T>(f: () => T): T | Error => { try { return f() } catch (e) { return e instanceof Error ? e : new Error(String(e)) } }

/** The interpreters to referee with: each python3 found that reports a version not already taken. */
const pythons = [...new Map(['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
  .map(p => [spawnSync(p, ['--version'], { encoding: 'utf8' }).stdout?.trim(), p] as const).filter(([v]) => v).reverse()).entries()].map(([version, path]) => ({ version, path }))
if (!pythons.length) throw new Error('pack-check needs python3')

/** Runs aesp.py isolated (-I): what it prints, and how it left. */
const aesp = (python: string, args: string[], cwd = DIR, script = AESP, flags = ['-I']) => {
  const r = spawnSync(python, [...flags, script, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status }
}

// ---- 1. random sets, both readers ----

const W = ['0a1b2c3d4e5f', 'ffffffffffff', '000000000000', '00000000000a', 'deadbeef0123']
const BITS = ['money', 'is', 'whole', 'cents', 'the', 'router', 'never', 'moves', 'a', 'thread', 'ids', 'are', 'minted', 'above', 'the line count',
  '設計', 'naïve', 'Ωμέγα', '\u05e2\u05d1\u05e8\u05d9\u05ea', 'e\u0301', '\u{1f600}', '\u{1f469}\u200d\u{1f4bb}', '\u{10ffff}', '\ufeff', '\uffff', '"', '\\', '/', '\n', '\r\n', '\t', '\0', '\x1f', '\x7f', '\x85', '\u2028', '\u2029', '§', '</script>',
  '\ud800', '\udfff', '\udc00\ud800'] // the last three are halves of pairs, which a pack stores as U+FFFD
/** A random change pack accepts: any field set or not, text of any length and script, many refs, stamps at the edges of 32, 41 and 53 bits. */
function random(rnd: (n: number) => number): Change {
  const id = () => idOf(Uint8Array.from({ length: 8 }, () => (rnd(4) ? rnd(256) : rnd(2) * 255)))
  const words = (most: number) => Array.from({ length: rnd(most + 1) }, () => BITS[rnd(rnd(3) ? 15 : BITS.length)]!).join(rnd(8) ? ' ' : '')
  const edge = [0, 2 ** 32, 2 ** 41, 2 ** 53 - 40, 1_760_000_000_000][rnd(5)]!
  const c: Change = {
    id: id(), at: { ms: edge + rnd(40) - (edge && rnd(2) ? 20 : 0), n: rnd(3) ? rnd(4) : rnd(2 ** 31) * 2 ** 21 + rnd(2 ** 21) },
    writer: W[rnd(W.length)]!, by: ['ada', 'grace', '', 'Zoë 設計'][rnd(4)]!, via: ['person', 'agent claude-opus-5-5', ''][rnd(3)]!,
  }
  if (rnd(3) === 0) c.kind = KINDS[rnd(3)]
  if (rnd(3) === 0) c.under = rnd(2) ? id() : ''
  if (rnd(2)) c.title = words(8)
  if (rnd(3) === 0) c.why = words(rnd(12) ? 30 : 1500)
  if (rnd(3) === 0) c.status = STATUSES[rnd(4)]
  if (c.status && rnd(2)) c.replacedBy = rnd(3) ? id() : ''
  if (rnd(3) === 0) c.refs = Array.from({ length: rnd(10) ? rnd(4) : rnd(80) }, () => '+-'[rnd(2)] + ['src/', 'src/hooks/', '', 'src/billing/**/'][rnd(4)]! + words(2))
  return c
}
/** A change as a pack gives it back, by the rules pack.ts states and none of its code. */
function canon(c: Change): Change {
  const fix = (s: string) => Array.from(s, ch => (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff' ? '\ufffd' : ch)).join('')
  const o: Change = { ...c, by: fix(c.by), via: fix(c.via) }
  if (o.title !== undefined) o.title = fix(o.title)
  if (o.why !== undefined) o.why = fix(o.why)
  if (!o.replacedBy) delete o.replacedBy
  if (o.refs?.length) o.refs = o.refs.map(fix)
  else delete o.refs
  return o
}

type Made = { path: string; bytes: Uint8Array; lines: string[] }
const made: Made[] = []
const rnd = dice(20261009)
let changesMade = 0, bytesMade = 0
for (let s = 0; s < SETS; s++) {
  const cs = Array.from({ length: s % 50 === 0 ? 600 + rnd(600) : rnd(4) ? rnd(12) : rnd(150) }, () => random(rnd))
  for (let k = rnd(4); k > 0 && cs.length; k--) cs.push({ ...cs[rnd(cs.length)]! })
  const bytes = pack(cs), back = tried(() => unpack(bytes))
  const want = [...new Set(cs.map(c => toLine(canon(c))))].sort()
  if (back instanceof Error) { check(false, `set ${s}: unpack refuses what pack wrote: ${back.message}`); continue }
  const lines = back.map(toLine)
  check(want.join('\n') === lines.slice().sort().join('\n'), `set ${s}: unpack does not give back the changes`)
  const path = join(DIR, `${sha(bytes).slice(0, 16)}.aesp`)
  writeFileSync(path, bytes)
  made.push({ path, bytes, lines })
  changesMade += lines.length, bytesMade += bytes.length
}
for (const { path: python, version } of pythons)
  for (let a = 0; a < made.length; a += 100) {
    const some = made.slice(a, a + 100), paths = some.map(m => m.path)
    const dump = aesp(python, ['dump', ...paths]), verify = aesp(python, ['verify', ...paths])
    check(dump.code === 0 && dump.err === '', `${version}: dump of sets ${a}.. left with ${dump.code}: ${dump.err}`)
    check(dump.out === some.map(m => m.lines.map(l => l + '\n').join('')).join(''), `${version}: dump of sets ${a}.. is not, to the byte, the changes as toLine writes them`)
    check(verify.code === 0 && verify.out === some.map(m => `ok ${m.path}: ${m.lines.length} changes\n`).join(''), `${version}: verify of sets ${a}..: ${verify.out.split('\n').find(l => !l.startsWith('ok'))} ${verify.err}`)
  }
console.log(`1. ${made.length} random sets, ${changesMade} changes, ${bytesMade} bytes of packs: packed, read back by unpack and by aesp.py dump and verify under ${pythons.map(p => p.version).join(' and ')}`)

// ---- 2. damage ----

const BAD = join(DIR, 'bad')
mkdirSync(BAD)
type Hurt = { name: string; how: string; bytes: Uint8Array; js: string[] | Error; named: string; sound: Made }
/** The payload of a pack of one block, and where its DEFLATE stream starts. */
const stream = (b: Uint8Array) => {
  let at = 6
  for (let k = 0; k < 2; k++) { while (b[at]! >= 128) at++; at++ }
  return { at: at + 4, raw: Buffer.from(inflate(b.subarray(at + 4), 256 << 10)) }
}
const hurt: Hurt[] = []
const small = made.filter(m => m.bytes.length < 4000)
for (let k = 0; k < 2500; k++) {
  const m = small[rnd(small.length)]!, b = m.bytes.slice(), kind = rnd(10)
  let how: string, bytes: Uint8Array = b
  if (kind < 6) { const bit = rnd(b.length * 8); b[bit >> 3]! ^= 1 << (bit & 7); how = `bit ${bit} of ${b.length * 8} flipped` }
  else if (kind < 8) { const n = rnd(b.length); bytes = b.subarray(0, n); how = `cut to ${n} of ${b.length} bytes` }
  else if (kind < 9) { bytes = Uint8Array.from([...b, rnd(256)]); how = 'a byte added' }
  else { b[5] = 2 + rnd(254); how = `version ${b[5]}` }
  // under a name that is no hash, so the readers' own checks decide; and under the sound pack's name, which no damaged file may keep
  const name = join(BAD, `damaged-${k}.aesp`), named = join(BAD, `${k}`, m.path.split('/').at(-1)!)
  mkdirSync(join(BAD, `${k}`))
  writeFileSync(name, bytes), writeFileSync(named, bytes)
  hurt.push({ name, how, bytes, js: tried(() => unpack(bytes).map(toLine)), named, sound: m })
}
let refused = 0, harmless = 0
for (const { path: python, version } of pythons)
  for (let a = 0; a < hurt.length; a += 100) {
    const some = hurt.slice(a, a + 100)
    const verdicts = aesp(python, ['verify', ...some.map(h => h.name)]).out.split('\n'), kept = aesp(python, ['verify', ...some.map(h => h.named)])
    check(kept.code === 1 && kept.out.split('\n').filter(l => l.startsWith('FAIL ')).length === some.length, `${version}: verify passes a damaged file under the name of the sound one (${a}..)`)
    some.forEach((h, i) => {
      const ok = verdicts[i]?.startsWith('ok '), line = verdicts[i] ?? ''
      check(ok === !(h.js instanceof Error) && line.includes(h.name), `${version}: ${h.how}: aesp.py says "${line.slice(line.indexOf('.aesp') + 5)}" and unpack ${h.js instanceof Error ? `throws "${h.js.message}"` : 'reads it'}`)
      if (h.js instanceof Error) { check(/^pack: /.test(h.js.message), `${h.how}: unpack throws an error that is not its own: ${h.js.message}`); if (python === pythons[0]!.path) refused++; return }
      // read by both: then both must read the same changes
      if (python === pythons[0]!.path) harmless++
      const dump = aesp(python, ['dump', h.name])
      check(dump.code === 0 && dump.out === h.js.map(l => l + '\n').join(''), `${version}: ${h.how}: both readers take it and read different changes`)
    })
    const one = aesp(python, ['dump', some.find(h => h.js instanceof Error)!.name])
    check(one.code === 1 && one.out === '' && one.err.startsWith('FAIL '), `${version}: dump of a damaged file prints "${one.out.slice(0, 80)}" and leaves with ${one.code}`)
  }
const flips = hurt.filter(h => !(h.js instanceof Error))
console.log(`2. ${hurt.length} damaged packs: ${refused} refused by both readers, ${harmless} read by both as the sound pack's changes (each a flipped bit that DEFLATE leaves unread: ${flips.filter(h => Number(h.how.split(' ')[1]) >> 3 === h.bytes.length - 1).length} in the last byte, ${flips.filter(h => Number(h.how.split(' ')[1]) >> 3 !== h.bytes.length - 1).length} in the padding of a stored block), all ${hurt.length} refused by verify under the sound pack's name`)
// DEFLATE leaves bits unread: those after the end-of-block code in the last byte, and those that pad a stored block's
// header to a whole byte. A flip there is the one damage a reader cannot see, and it changes nothing a reader gives.
for (const h of flips) {
  const bit = Number(h.how.split(' ')[1]), was = stream(h.sound.bytes)
  check(/^bit \d+ of \d+ flipped$/.test(h.how) && bit >> 3 >= was.at && stream(h.bytes).raw.equals(was.raw), `${h.how} is read, and it is not a flip of a bit DEFLATE leaves unread`)
  check((h.js as string[]).join('\n') === h.sound.lines.join('\n'), `${h.how} is read as other changes than the sound pack's`)
}

// ---- 3. a folder that plants modules ----

const TRAP = join(DIR, 'trap'), MARK = join(TRAP, 'RAN')
mkdirSync(TRAP)
for (const m of ['zlib', 'json', 'hashlib', 're', 'os', 'sitecustomize', 'usercustomize', 'encodings'])
  writeFileSync(join(TRAP, `${m}.py`), `open(${JSON.stringify(MARK)}, 'a').write('${m}\\n')\nraise SystemExit('planted ${m} ran')\n`)
copyFileSync(AESP, join(TRAP, 'aesp.py'))
const sound = made.find(m => m.lines.length > 3)!
for (const { path: python, version } of pythons) {
  // the control: this folder does catch an import that looks in it
  const control = spawnSync(python, ['-c', 'import json'], { cwd: TRAP, encoding: 'utf8' })
  check(existsSync(MARK) && control.status !== 0, `${version}: the trap folder catches nothing, so the test below proves nothing`)
  rmSync(MARK, { force: true })
  for (const [what, script, flags] of [['run from the folder', AESP, []], ['a copy inside the folder', join(TRAP, 'aesp.py'), []], ['a copy inside the folder, with -I', join(TRAP, 'aesp.py'), ['-I']]] as const)
    for (const verb of ['dump', 'verify']) {
      const r = aesp(python, [verb, sound.path], TRAP, script, [...flags])
      check(r.code === 0 && !existsSync(MARK) && (verb === 'dump' ? r.out === sound.lines.map(l => l + '\n').join('') : r.out.startsWith('ok ')), `${version}: ${verb}, ${what}: ${existsSync(MARK) ? `ran planted ${readFileSync(MARK, 'utf8')}` : r.err || r.out}`)
      rmSync(MARK, { force: true })
    }
}
console.log(`3. run from, and copied into, a folder that plants zlib.py, json.py, hashlib.py, re.py, os.py and three more: none of them ran`)

// ---- 4. what a pack saves ----

/** Words as this mod's own comments and code use them: drawn one at a time, so common ones come up as often as they do there. */
const corpus = readdirSync(join(HERE, '../hooks')).filter(f => /\.tsx?$/.test(f)).map(f => readFileSync(join(HERE, '../hooks', f), 'utf8')).join('\n').match(/[A-Za-z][a-z']+/g)!
function realistic(count: number, seed: number): Change[] {
  const rnd = dice(seed), word = () => corpus[rnd(corpus.length)]!
  const prose = (lo: number, hi: number) => {
    const want = lo + rnd(hi - lo + 1)
    let s = ''
    while (s.length < want) s += (s ? (rnd(12) ? ' ' : rnd(3) ? '. ' : ', ') : '') + word()
    return (s[0]?.toUpperCase() ?? '') + s.slice(1, want).trimEnd()
  }
  const dirs = ['src/billing', 'src/billing/invoices', 'src/hooks', 'src/router', 'src/ui/components', 'src/ui/panes', 'src/store', 'test/billing', 'tools', 'docs/decisions']
  const files = Array.from({ length: 160 }, () => `${dirs[rnd(dirs.length)]}/${word().toLowerCase()}${rnd(3) ? '' : `-${word().toLowerCase()}`}.${rnd(5) ? 'ts' : 'tsx'}`)
  const ref = () => (rnd(8) ? '+' : '-') + (rnd(6) ? files[rnd(files.length)]! + (rnd(5) ? '' : `#${word()}`) : `${dirs[rnd(dirs.length)]}/**`)
  const writers = Array.from({ length: 14 }, (_, i) => ({ writer: sha(new Uint8Array([i])).slice(0, 12), by: ['ada', 'grace', 'linus', 'barbara', 'ken'][i % 5]!, via: i % 3 ? 'agent claude-opus-5-5' : 'person' }))
  const ids: string[] = [], out: Change[] = []
  let ms = 1_750_000_000_000
  while (out.length < count) {
    ms += rnd(4) ? rnd(90_000) : rnd(40_000_000)
    const who = { ...writers[rnd(writers.length)]!, at: { ms, n: rnd(20) ? 0 : 1 + rnd(3) } }, roll = rnd(10), id = () => ids[rnd(ids.length)]!
    const fresh = idOf(Uint8Array.from({ length: 8 }, () => rnd(256)))
    const c = clean(
      roll < 6 || ids.length < 5 ? { ...who, id: fresh, kind: KINDS[rnd(8) ? 1 + rnd(2) : 0], under: ids.length && rnd(5) ? id() : '', title: prose(30, 80), why: prose(0, 600), refs: Array.from({ length: 1 + rnd(3) }, ref), status: 'proposed' }
        : roll < 8 ? { ...who, id: id(), status: STATUSES[1 + rnd(3)], replacedBy: id() }
        : roll < 9 ? { ...who, id: id(), title: prose(30, 80), why: prose(0, 600) }
        : { ...who, id: id(), refs: Array.from({ length: 1 + rnd(3) }, ref) },
    )
    if (!c) throw new Error('the realistic set made a change clean() discards')
    if (c.kind) ids.push(c.id)
    out.push(c)
  }
  return out
}
const timed = (f: () => unknown, reps = 9) => { const t: number[] = []; for (let r = 0; r < reps; r++) { const a = performance.now(); f(); t.push(performance.now() - a) } return t.sort((x, y) => x - y)[reps >> 1]! }
const set = realistic(2000, 42), jsonl = new TextEncoder().encode(set.map(c => toLine(c) + '\n').join(''))
const whole = pack(set), groups = batches(set), packs = groups.map(g => pack(g)), split = packs.reduce((n, p) => n + p.length, 0)
const pct = (n: number) => `${((100 * n) / jsonl.length).toFixed(1)}%`
check(unpack(whole).map(toLine).sort().join('\n') === set.map(toLine).sort().join('\n'), 'the realistic set does not round trip')
const paths = packs.map(p => { const path = join(DIR, `${sha(p).slice(0, 16)}.aesp`); writeFileSync(path, p); return path })
for (const { path: python, version } of pythons)
  check(aesp(python, ['dump', ...paths]).out === groups.flat().map(c => toLine(c) + '\n').join(''), `${version}: the realistic set, packed in batches, is not dumped as it was written`)
console.log(`4. a realistic set of ${set.length} changes (titles 30-80 characters, reasons 0-600, 1-3 path refs from ${160} files in 10 folders)`)
console.log(`   JSON lines                    ${String(jsonl.length).padStart(8)} bytes  100.0%`)
console.log(`   gzip -6 of the JSON lines     ${String(gzipSync(jsonl, { level: 6 }).length).padStart(8)} bytes  ${pct(gzipSync(jsonl, { level: 6 }).length).padStart(6)}`)
console.log(`   gzip -9 of the JSON lines     ${String(gzipSync(jsonl, { level: 9 }).length).padStart(8)} bytes  ${pct(gzipSync(jsonl, { level: 9 }).length).padStart(6)}`)
console.log(`   one pack of them all          ${String(whole.length).padStart(8)} bytes  ${pct(whole.length).padStart(6)}`)
console.log(`   ${packs.length} packs from batches()        ${String(split).padStart(8)} bytes  ${pct(split).padStart(6)}   (${groups.map(g => g.length).join(', ')} changes; ${packs.map(p => p.length).join(', ')} bytes)`)
console.log(`   times under bun, median of 9: pack of all ${timed(() => pack(set)).toFixed(1)} ms, unpack ${timed(() => unpack(whole)).toFixed(1)} ms, batches ${timed(() => batches(set)).toFixed(1)} ms, pack of one batch ${timed(() => pack(groups[0]!)).toFixed(1)} ms, unpack of one ${timed(() => unpack(packs[0]!)).toFixed(1)} ms`)

rmSync(DIR, { recursive: true, force: true })
console.log(failed.length ? `\nFAILED ${failed.length}${failed.length === 40 ? ' or more' : ''} of ${checks} checks:\n${failed.map(f => `  ${f}`).join('\n')}` : `\nall ${checks} checks pass`)
process.exit(failed.length ? 1 : 0)
