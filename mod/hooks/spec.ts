import { SEP } from './core'

// Specs and decisions: the records a project keeps about what its code must do and why. Pure logic; specs.ts stores
// and serves them. A record is never edited in place: every file holds changes, and the tree is their fold. Like git:
// `log` and `show` read the history, `diff` sets two folds side by side.

/** What a record is: an area groups others, a spec says what must hold, a decision says what was chosen and why. */
export const KINDS = ['area', 'spec', 'decision'] as const
export type Kind = (typeof KINDS)[number]

/** Where a record stands. A record an agent writes starts proposed; a person accepts or drops it. */
export const STATUSES = ['proposed', 'accepted', 'superseded', 'dropped'] as const
export type Status = (typeof STATUSES)[number]

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** The id eight bytes spell: 13 characters, the first from the top four bits (so always a letter), then five bits each. */
export function idOf(bytes: Uint8Array): string {
  let bits = 0n
  for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(bytes[i] ?? 0)
  let id = ''
  for (let shift = 60n; shift >= 0n; shift -= 5n) id += ALPHABET[Number((bits >> shift) & 31n)]
  return id
}

/** The eight bytes of an id, or undefined when it is not one. */
export function bytesOf(id: string): Uint8Array | undefined {
  if (!/^[a-p][a-z2-7]{12}$/.test(id)) return undefined
  let bits = 0n
  for (const ch of id) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(ch))
  const out = new Uint8Array(8)
  for (let i = 7; i >= 0; i--, bits >>= 8n) out[i] = Number(bits & 255n)
  return out
}

/** When a change was made, on a hybrid logical clock: wall milliseconds, then a counter that orders changes within one. */
export type Stamp = { ms: number; n: number }

/**
 * One change to one record as its writer made it: the unit both file formats store. The change that creates a record
 * carries `kind` and `under`, which never change afterwards; any change may set the other fields, and a field left
 * out is untouched.
 */
export type Change = {
  /** The record's id: 13 characters of lowercase base32 (a-z, 2-7), 64 random bits. */
  id: string
  at: Stamp
  /** The writer: 12 hex characters, random each time the module loads, kept nowhere else. */
  writer: string
  /** Whose work it was (a name, never an address) and what made it: "person", or "agent" and the model's id. */
  by: string
  via: string
  kind?: Kind
  /** The parent record's id, "" for the root. */
  under?: string
  /** The record in one line: for a spec or a decision, the rule itself. */
  title?: string
  /** The reason, and what was turned down. */
  why?: string
  /** Set together with `replacedBy`: one register, so a record is never superseded and accepted at once. */
  status?: Status
  /** The record that took this one's place; "" for none. */
  replacedBy?: string
  /** Code the record governs, each added ("+src/money.ts", "+src/billing/**", "+src/money.ts#round") or removed ("-..."). */
  refs?: readonly string[]
}

// The engine's namespaces are slow to read from a loop, so what a loop needs of them is taken once, here.
const { parse, stringify } = JSON, { isSafeInteger } = Number, { isArray } = Array, { min } = Math, MapOf = Map, SetOf = Set, DateOf = Date
const NOWORDS: string[] = []

/** The most a change may carry. Held on every change read, whoever wrote the file, and on every add. */
export const LIMITS = { title: 200, why: 2048, refs: 32, ref: 300, name: 80 } as const

declare const sound: unique symbol
/** A change that has been through `clean`: the only kind the fold takes, so nothing read from a file skips the limits. */
export type Sound = Change & { readonly [sound]: true }

/**
 * Which of two changes comes first: by wall time, then counter, then writer, then the text of the change itself.
 * A total order, so every replica names the same winner; 0 only for two copies of one change.
 */
export function order(a: Change, b: Change): number {
  if (a === b) return 0
  const d = a.at.ms - b.at.ms || a.at.n - b.at.n
  if (d !== 0 || a.writer !== b.writer) return d || (a.writer < b.writer ? -1 : 1)
  if (same(a, b)) return 0
  const x = toLine(a), y = toLine(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Whether two changes with one stamp and writer say the same: the usual tie, one change read from two files, settled without writing either out. */
const same = (a: Change, b: Change) =>
  a.id === b.id && a.by === b.by && a.via === b.via && a.kind === b.kind && a.under === b.under && a.title === b.title && a.why === b.why &&
  a.status === b.status && a.replacedBy === b.replacedBy && a.refs?.length === b.refs?.length && (a.refs?.every((r, i) => r === b.refs![i]) ?? true)

// ponytail: a stamp at the very top of the whole numbers leaves nothing to tick to, and the next change is discarded
// as it is read; `ahead` flags the file that holds one, and taking that file out is the cure
/**
 * The stamp for a writer's next change: `now` (Date.now()), or one past the clock when the clock is not behind it.
 * The clock is the greatest stamp in all the writer has read (`Tree.clock`), so its changes sort after what it saw.
 */
export const tick = (clock: Stamp, now: number): Stamp => (now > clock.ms ? { ms: now, n: 0 } : { ms: clock.ms, n: clock.n + 1 })

/** Whether a stamp is more than a day past `now`: some writer's clock was wrong. The fold honours it all the same. */
export const ahead = (at: Stamp, now: number) => at.ms > now + 86_400_000

const ID = /^[a-p][a-z2-7]{12}$/ // what bytesOf accepts, without its BigInt work
const WRITER = /^[0-9a-f]{12}$/
// control characters as a reader meets them: C0 and C1 but tab and newline, the Unicode line breaks, the bidi overrides
const CTRL = '\\0-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069'
// what a why, a reference and a one-line field may not hold; a replace costs several tests here, so each is tested for first
const BLOCK = new RegExp(`[${CTRL}]`), ODD = new RegExp(`[${CTRL}\\t\\n]`), INLINE = new RegExp(`[${CTRL}\\t\\n${SEP}]`)
const BREAK = /[\t\n\v\f\r\x85\u2028\u2029]+/g, HALF = /[\ud800-\udbff]$/, all = (re: RegExp) => new RegExp(re, 'g')
const BLOCKS = all(BLOCK), INLINES = all(INLINE)
const HALVES = /[\ud800-\udfff]/, LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Text in which every half of a surrogate pair that stands alone is U+FFFD: what UTF-8 makes of it, so a change reads the same from a segment as from a pack. */
const whole = (s: string) => (HALVES.test(s) ? s.replace(LONE, '\ufffd') : s)

/** The first `max` characters, never half of a pair. */
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max).replace(HALF, '') : s)
/** One line: breaks and tabs become a space, the other control characters and § go. */
const tidy = (s: string) => (INLINE.test(s) ? s.replace(BREAK, ' ').replace(INLINES, '') : s).trim()
const one = (s: string, max: number) => cut(tidy(whole(s)), max).trimEnd()
const count = (x: unknown): x is number => isSafeInteger(x) && (x as number) >= 0

/**
 * A change within the limits, or undefined for one that cannot be kept. What discards it: an id `bytesOf` rejects
 * (as `under` or `replacedBy` too), a writer that is not 12 lowercase hex characters, a stamp that is not two whole
 * numbers from 0 up, a kind or status off the lists, a field of the wrong type, or setting nothing at all. Text is
 * repaired instead. A title, `by` and `via` become one line, cut to length, with no control character and no § (§
 * parts a line ID from its code, so a title holding it could pass for a line of a file); a why keeps tab and newline
 * of the control characters; half of a surrogate pair standing alone becomes U+FFFD everywhere, as UTF-8 would have it,
 * so the line and the packed form of a change are one text; a ref that is too long, unsigned or holds a control character is left out, a ref named
 * twice keeps its last sign, and refs past the limit are left out.
 */
export function clean(raw: unknown): Sound | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as { [K in keyof Change]?: unknown }, at = c.at as { ms?: unknown; n?: unknown } | null | undefined
  if (typeof c.id !== 'string' || !ID.test(c.id) || typeof c.writer !== 'string' || !WRITER.test(c.writer)) return undefined
  if (typeof at !== 'object' || at === null || !count(at.ms) || !count(at.n)) return undefined
  if (typeof c.by !== 'string' || typeof c.via !== 'string') return undefined
  const out: Change = { id: c.id, at: { ms: at.ms, n: at.n }, writer: c.writer, by: one(c.by, LIMITS.name), via: one(c.via, LIMITS.name) }
  if (c.kind !== undefined) {
    const under = c.under ?? ''
    if (!KINDS.includes(c.kind as Kind) || typeof under !== 'string' || (under !== '' && !ID.test(under))) return undefined
    out.kind = c.kind as Kind, out.under = under
  }
  if (c.title !== undefined) {
    if (typeof c.title !== 'string') return undefined
    out.title = one(c.title, LIMITS.title)
  }
  if (c.why !== undefined) {
    if (typeof c.why !== 'string') return undefined
    const why = whole(c.why)
    out.why = cut(BLOCK.test(why) ? why.replace(BLOCKS, '') : why, LIMITS.why)
  }
  if (c.status !== undefined) {
    const by = c.replacedBy ?? ''
    if (!STATUSES.includes(c.status as Status) || typeof by !== 'string' || (by !== '' && !ID.test(by))) return undefined
    out.status = c.status as Status
    if (by !== '' && c.status === 'superseded') out.replacedBy = by
  }
  if (c.refs !== undefined) {
    if (!isArray(c.refs)) return undefined
    const seen = new MapOf<string, string>()
    for (const raw of c.refs) {
      if (typeof raw !== 'string' || raw.length < 2 || raw.length > LIMITS.ref + 1 || (raw[0] !== '+' && raw[0] !== '-') || ODD.test(raw)) continue
      const r = whole(raw), k = r.slice(1)
      if (seen.size < LIMITS.refs || seen.has(k)) seen.set(k, r)
    }
    if (seen.size) out.refs = [...seen.values()]
  }
  return out.kind || out.status || out.refs || out.title !== undefined || out.why !== undefined ? (out as Sound) : undefined
}

/**
 * A change as one line of JSON, keys in a fixed order: id, at as [ms, n], writer, by, via, then only the fields it
 * sets. What a loose file holds, what a person reviews in a pull request, and the text `order` falls back on.
 */
export function toLine(c: Change): string {
  const { id, writer, by, via, kind, under, title, why, status, replacedBy, refs } = c
  return stringify({ id, at: [c.at.ms, c.at.n], writer, by, via, kind, under, title, why, status, replacedBy, refs })
}

/** The change a line holds, cleaned; undefined for anything that is not one. Never throws. */
export function fromLine(line: string): Sound | undefined {
  // no line `toLine` writes comes near this length; a longer one is refused before it costs a parse
  if (line.length > 1 << 17) return undefined
  let o: unknown
  try {
    o = parse(line)
  } catch {
    return undefined
  }
  if (typeof o !== 'object' || o === null) return undefined
  const at: unknown = (o as { at?: unknown }).at
  return isArray(at) && at.length === 2 ? clean({ ...o, at: { ms: at[0], n: at[1] } }) : undefined
}

/**
 * A new record's id from eight random bytes, or undefined when its first four characters hold no digit: an id that
 * could be read as a word is drawn again by the caller (about half are).
 */
export function mint(bytes: Uint8Array): string | undefined {
  const id = idOf(bytes)
  return /[2-7]/.test(id.slice(0, 4)) ? id : undefined
}

/** One id's say on one reference: the highest-ordered change that adds or removes it, and the next say on the same file or glob. */
type Ref = { key: string; of: Node; by: Change; on: boolean; next: Ref | undefined }

/** One id as the fold holds it: the change that won each register, then the place the last survey gave it. */
export type Node = {
  id: string
  /** The highest-ordered change of any sort. */
  last: Change
  /** The lowest-ordered change that creates. Until one is read the id is no record: its changes wait here. */
  made: Change | undefined
  title: Change | undefined
  why: Change | undefined
  /** The highest-ordered change that sets a status; it carries `replacedBy` too, so the two are one register. */
  status: Change | undefined
  /** Its say on each reference it has ever named. */
  refs: Map<string, Ref> | undefined
  /** The next record whose id starts with the same six characters. */
  twin: Node | undefined
  state: Status
  /** The record it is listed under: the parent it names, or the root when that parent cannot be one. */
  up: Node | undefined
  kids: Node[] | undefined
  sorted: boolean
  /** Levels below the root, -1 for a record that is in no list. */
  depth: number
}

/**
 * The fold of every change read so far. `fold` takes changes in any order, any number of times, and always arrives at
 * the same tree; the lists the tools read are drawn up again on the first question after a fold that changed something.
 */
export type Tree = {
  /** Every id met. */
  nodes: Map<string, Node>
  /** The greatest stamp folded: what a writer ticks from. */
  clock: Stamp
  /** How many folds changed something. */
  rev: number
  /** The ids `stale` marked. */
  stale: Set<string>
  /** Records by the first six characters of their id. */
  heads: Map<string, Node>
  /** What the top-level records hang under; it is no record itself. */
  root: Node
  /** The survey: the `rev` it was drawn up at, every record in a list, the parents named but absent, the ids without a creation. */
  seen: number
  listed: Node[]
  missing: string[]
  loose: string[]
  /** Every say on a reference, chained by the file it names and by the glob it is: where `governing` and `stale` look. */
  files: Map<string, Ref>
  globs: Map<string, Ref>
}

const NONE: Node[] = []
// every field from the start, so all nodes have one shape
const node = (id: string, last: Change): Node => ({
  id, last, made: undefined, title: undefined, why: undefined, status: undefined, refs: undefined, twin: undefined,
  state: 'proposed', up: undefined, kids: undefined, sorted: false, depth: -1,
})

/** The file a reference names, without its "#symbol". */
const file = (ref: string) => {
  const h = ref.lastIndexOf('#')
  return h > 0 && ref.indexOf('/', h) < 0 ? ref.slice(0, h) : ref
}

/** A tree with nothing folded into it. */
export const empty = (): Tree => ({
  nodes: new MapOf(), clock: { ms: 0, n: 0 }, rev: 0, stale: new SetOf(), heads: new MapOf(),
  root: node('', { id: '', at: { ms: 0, n: 0 }, writer: '', by: '', via: '' }), seen: -1, listed: [], missing: [], loose: [],
  files: new MapOf(), globs: new MapOf(),
})

/**
 * Folds changes into a tree, in place, and returns it. Each register keeps the one change that wins it, so folding a
 * file again changes nothing, and one more file folded in gives what folding everything from `empty()` gives; when a
 * file goes away, fold what is left from `empty()`. Linear in the changes: a caller with very many folds them a slice
 * at a time.
 */
export function fold(t: Tree, changes: Iterable<Sound>): Tree {
  const { nodes, heads } = t
  let { ms, n: tally } = t.clock, moved = false
  for (const c of changes) {
    let n = nodes.get(c.id)
    if (!n) nodes.set(c.id, (n = node(c.id, c))), moved = true
    else if (order(n.last, c) < 0) n.last = c, moved = true
    if (c.kind && (!n.made || order(c, n.made) < 0)) {
      const head = c.id.slice(0, 6)
      if (!n.made) n.twin = heads.get(head), heads.set(head, n)
      n.made = c, moved = true
    }
    if (c.title !== undefined && (!n.title || order(n.title, c) < 0)) n.title = c, moved = true
    if (c.why !== undefined && (!n.why || order(n.why, c) < 0)) n.why = c, moved = true
    if (c.status && (!n.status || order(n.status, c) < 0)) n.status = c, moved = true
    if (c.refs) {
      const refs = (n.refs ??= new MapOf())
      for (const r of c.refs) {
        const key = r.slice(1), on = r.charCodeAt(0) === 43, cur = refs.get(key)
        if (!cur) {
          // the first say on a reference joins the chain of what it names, and stays there: a removal only turns it off
          const g = file(key), chain = g.indexOf('*') < 0 ? t.files : t.globs, ref: Ref = { key, of: n, by: c, on, next: chain.get(g) }
          chain.set(g, ref), refs.set(key, ref)
        } else if (order(cur.by, c) < 0) cur.by = c, cur.on = on
        else continue
        moved = true
      }
    }
    if (c.at.ms > ms || (c.at.ms === ms && c.at.n > tally)) ms = c.at.ms, tally = c.at.n
  }
  t.clock = { ms, n: tally }
  if (moved) t.rev++
  return t
}

/** Children in creation order, then by id. */
const byBirth = (a: Node, b: Node) => a.made!.at.ms - b.made!.at.ms || a.made!.at.n - b.made!.at.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Draws up the lists again if a fold changed something since the last time. A record hangs under the parent it names
 * when that parent is a record created before it, and under the root otherwise: a parent that is not here means a file
 * is missing, and since a parent always sorts before its child no set of changes can make a loop. A record is dropped
 * only while its drop is the highest-ordered change it has; any later change brings it back as proposed. A dropped
 * record's parent is not missed: dropping the record that names it is how a person clears a parent that will not come back.
 */
function survey(t: Tree): Tree {
  if (t.seen === t.rev) return t
  // ponytail: every list is drawn up afresh, 15 to 60 ms per 100,000 records, on the first question after a fold
  // that changed anything; keep them up change by change if a store ever nears a million records
  const { root } = t, missing = new SetOf<string>(), loose: string[] = [], listed: Node[] = []
  for (const n of t.nodes.values()) n.kids = undefined, n.sorted = false, n.depth = -1
  root.kids = [], root.sorted = false
  for (const n of t.nodes.values()) {
    const m = n.made, s = n.status
    if (!m) {
      loose.push(n.id)
      continue
    }
    n.state = !s || (s.status === 'dropped' && order(s, n.last) < 0) ? 'proposed' : s.status!
    const p = m.under === '' ? root : t.nodes.get(m.under!)
    n.up = p === root || (p?.made && order(p.made, m) < 0) ? p! : root
    if (n.state === 'dropped') continue
    if (n.up === root && m.under !== '') missing.add(m.under!)
    ;(n.up.kids ??= []).push(n)
  }
  for (const todo = [root]; todo.length; ) {
    const p = todo.pop()!
    for (const k of p.kids ?? NONE) k.depth = p.depth + 1, listed.push(k), todo.push(k)
  }
  t.listed = listed, t.missing = [...missing].sort(), t.loose = loose.sort(), t.seen = t.rev
  return t
}

const kids = (p: Node): Node[] => {
  if (!p.sorted) p.kids?.sort(byBirth), p.sorted = true
  return p.kids ?? NONE
}
const titleOf = (n: Node) => n.title?.title ?? ''
const live = (n: Node) => n.depth >= 0 && n.state !== 'superseded'
/** The references a record has now, sorted. */
function refsOf(n: Node): string[] {
  const out: string[] = []
  if (n.refs) for (const r of n.refs.values()) if (r.on) out.push(r.key)
  return out.sort()
}

/** Parents that records which are not dropped name but that are not here, or were created after their child. While there are any, a file of the store is missing and nothing should be added. */
export const missing = (t: Tree): string[] => survey(t).missing

/** The ids of the records that name such a parent, oldest first: restoring the file or dropping these is what clears `missing`. */
export const orphans = (t: Tree): string[] => kids(survey(t).root).filter(n => n.made!.under !== '').map(n => n.id)

/** Whether a made record is in no list though it is not dropped: one of its ancestors is. */
const buried = (n: Node) => n.depth < 0 && n.state !== 'dropped'

/** The dropped record a record is hidden under, its nearest dropped ancestor; undefined for a record that is listed, is dropped itself, or is no record. */
export function hiddenUnder(t: Tree, id: string): string | undefined {
  let n = survey(t).nodes.get(id)
  if (!n?.made || !buried(n)) return undefined
  while (n.up && n.state !== 'dropped') n = n.up
  return n.id
}

/** How many records are hidden under a dropped one: in no list, no count and no export, though not dropped themselves. */
export function hidden(t: Tree): number {
  let n = 0
  for (const x of survey(t).nodes.values()) if (x.made && buried(x)) n++
  return n
}

/** Ids that have changes but no creating change: the file with the creation has not arrived. They are in no list. */
export const loose = (t: Tree): string[] => survey(t).loose

/** A record as the tools show it: the fold of its changes when it was asked for. */
export type Rec = {
  id: string
  kind: Kind
  /** The parent it names, "" for the root. */
  under: string
  title: string
  why: string
  status: Status
  /** The record that took its place, "" unless it is superseded. */
  replacedBy: string
  refs: string[]
  /** Who created it, with what, and when. */
  by: string
  via: string
  at: Stamp
  /** In the lists and in force: not dropped, under nothing dropped, not superseded. */
  live: boolean
  stale: boolean
}

const view = (t: Tree, n: Node): Rec => {
  const m = n.made!
  return {
    id: n.id, kind: m.kind!, under: m.under!, title: titleOf(n), why: n.why?.why ?? '', status: n.state,
    replacedBy: (n.state === 'superseded' && n.status!.replacedBy) || '', refs: refsOf(n),
    by: m.by, via: m.via, at: { ms: m.at.ms, n: m.at.n }, live: live(n), stale: live(n) && t.stale.has(n.id),
  }
}

/** The record with this id, dropped or not; undefined when the id is no record. */
export function get(t: Tree, id: string): Rec | undefined {
  const n = survey(t).nodes.get(id)
  return n?.made ? view(t, n) : undefined
}

/** How a record's id is shown: its shortest prefix no other record shares, never under six characters. */
export function short(t: Tree, id: string): string {
  let len = 6
  for (let m = t.heads.get(id.slice(0, 6)); m; m = m.twin) while (m.id !== id && len < 13 && m.id.startsWith(id.slice(0, len))) len++
  return id.slice(0, len)
}

/**
 * The record an id or a prefix of one names: its id, or the sorted candidates when several match, or undefined. Only
 * the first word of `text` counts, so a line pasted whole resolves; nothing under six characters does.
 */
export function resolve(t: Tree, text: string): string | string[] | undefined {
  const q = /\S*/.exec(text.trimStart())![0].toLowerCase(), hits: string[] = []
  for (let m = t.heads.get(q.slice(0, 6)); m; m = m.twin) if (m.id.startsWith(q)) hits.push(m.id)
  return hits.length > 1 ? hits.sort() : hits[0]
}

const COUNTED = /^\+\d+(?: |$)/
const row = (t: Tree, n: Node, hidden = n.kids?.length ?? 0, marks = true): string => {
  const title = titleOf(n), flag = n.state === 'dropped' || n.state === 'superseded' || !marks || !t.stale.has(n.id) ? n.state : 'stale'
  // a title that itself opens with "+3" is told from a count by always having a count before it
  return `${short(t, n.id)} ${n.made!.kind}${flag === 'accepted' ? '' : `!${flag}`}${hidden > 0 || COUNTED.test(title) ? ` +${hidden}` : ''}${title && ` ${title}`}`
}

/**
 * A record in one line: "<short id> <kind>[!<status>] [+<n>] <title>". The status is given only when it is not
 * accepted, and reads "stale" for a record `stale` marked; +n counts the children not shown (all of them, unless
 * `hidden` says otherwise). The title is last and never opens with a count of its own, so the line parses one way.
 */
export function line(t: Tree, id: string, hidden?: number): string {
  const n = survey(t).nodes.get(id)
  return n?.made ? row(t, n, hidden) : ''
}

/**
 * The records under one record (`under`, an id or a prefix of one) or under the root, a line each, indented a space
 * per level, `depth` levels down. Past `limit` lines it keeps the shallowest first and ends with a line that says how
 * many are left out and how to narrow; a branch cut short shows in its parent's +n. Empty when `under` names no one
 * record.
 */
export function outline(t: Tree, { under, depth = 2, limit = 60 }: { under?: string; depth?: number; limit?: number } = {}): string {
  const hit = under ? resolve(survey(t), under) : ''
  const top = hit === '' ? survey(t).root : typeof hit === 'string' ? t.nodes.get(hit) : undefined
  if (!top) return ''
  // breadth first: how many children of each record are shown, always its first ones
  const shown = new MapOf<Node, number>([[top, 0]])
  let room = limit, more = 0, final: [Node, Node] | undefined
  for (let layer = [top], d = 0; d < depth && layer.length; d++) {
    const next: Node[] = []
    for (const p of layer) {
      const open = shown.has(p) && room > 0
      for (const k of open ? kids(p) : p.kids ?? NONE) {
        if (open && room > 0) room--, shown.set(k, 0), shown.set(p, shown.get(p)! + 1), final = [k, p]
        else more++
        next.push(k)
      }
    }
    layer = next
  }
  // the closing line is one of the `limit`, so the last record picked makes way for it
  if (more && final) more++, shown.delete(final[0]), shown.set(final[1], shown.get(final[1])! - 1)
  const lines: string[] = []
  for (const todo: [Node, number][] = [[top, -1]]; todo.length; ) {
    const [p, level] = todo.pop()!, n = shown.get(p)!
    if (p !== top) lines.push(' '.repeat(level) + row(t, p, (p.kids?.length ?? 0) - n))
    if (n) for (let ks = kids(p), i = n - 1; i >= 0; i--) todo.push([ks[i]!, level + 1])
  }
  if (more) lines.push(`… ${more} more: narrow with under=<id>, a smaller depth, or search`)
  return lines.join('\n')
}

/** What narrows a search: how many lines at most, one kind, one status ("stale" for the records `stale` marked). */
export type Query = { limit?: number; kind?: Kind; status?: Status | 'stale' }

/**
 * Records whose title, references or why match, oldest first, at most `limit`, grouped under a "# " line that gives
 * their ancestors' titles; `hits` counts every match. A record at the root has no such line. `what` is a pattern, or
 * plain text: then every word of it must be somewhere in the record, in any case and any order (its first 400
 * characters and 16 words; the rest is not read), and no pattern is ever built from it, so text from a model cannot be
 * made slow. `opts` is the limit or a `Query`; with a kind or a status an
 * empty text finds every record of that sort. Dropped records are searched only when the status asked for is dropped.
 */
export function search(t: Tree, what: RegExp | string, opts: number | Query = 20): { text: string; hits: number } {
  // ponytail: tries every listed record in one go, 100 to 400 ms per 100,000 with whys of a few hundred characters;
  // a store that large wants a cursor here, so the caller can take it a part at a time
  const { limit = 20, kind, status }: Query = typeof opts === 'number' ? { limit: opts } : opts
  const words = typeof what === 'string' ? cut(what, 400).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16) : NOWORDS
  const has = (s: string) => typeof what !== 'string' && ((what.lastIndex = 0), what.test(s))
  const hit = (n: Node) => {
    if ((kind && n.made!.kind !== kind) || (status && (status === 'stale' ? !(live(n) && t.stale.has(n.id)) : n.state !== status))) return false
    if (typeof what === 'string') {
      if (!words.length) return kind !== undefined || status !== undefined
      let hay = `${titleOf(n)}\n${n.why?.why ?? ''}`
      if (n.refs) for (const r of n.refs.values()) if (r.on) hay += `\n${r.key}`
      hay = hay.toLowerCase()
      return words.every(w => hay.includes(w))
    }
    if (has(titleOf(n)) || has(n.why?.why ?? '')) return true
    if (n.refs) for (const r of n.refs.values()) if (r.on && has(r.key)) return true
    return false
  }
  const pool = status === 'dropped' ? [...survey(t).nodes.values()].filter(n => n.made) : survey(t).listed
  const found = pool.filter(hit).sort(byBirth)
  const groups = new MapOf<Node, string[]>([[t.root, []]])
  for (const n of found.slice(0, limit)) {
    let g = groups.get(n.up!)
    if (!g) groups.set(n.up!, (g = []))
    g.push((n.up === t.root ? '' : ' ') + row(t, n))
  }
  const lines: string[] = []
  for (const [up, group] of groups) {
    const crumbs: string[] = []
    for (let p = up; p !== t.root; p = p.up!) crumbs.unshift(titleOf(p) || short(t, p.id))
    if (crumbs.length) lines.push(`# ${crumbs.join(' > ')}`)
    lines.push(...group)
  }
  if (found.length > limit) lines.push(`… ${found.length - limit} more: narrow the pattern`)
  return { text: lines.join('\n'), hits: found.length }
}

/**
 * Whether a glob matches a whole path. "*" stays inside one name; "**" crosses directories, and where a name would
 * start, "**" and the slash after it also stand for no directory at all. It goes back only to the last star of each
 * sort and never through a regular expression, so a pattern from someone else's file cannot be made slow.
 */
function glob(g: string, p: string): boolean {
  const G = g.length, P = p.length
  let i = 0, j = 0, si = -1, sj = 0, di = -1, dj = 0, dirs = false
  for (;;) {
    if (i < G && g.charCodeAt(i) === 42) {
      if (g.charCodeAt(i + 1) !== 42) {
        si = ++i, sj = j
        continue
      }
      const lead = i === 0 || g.charCodeAt(i - 1) === 47
      while (g.charCodeAt(i) === 42) i++
      dirs = lead && g.charCodeAt(i) === 47
      if (dirs) i++
      else if (i === G) return true
      di = i, dj = j, si = -1
    } else if (i < G && j < P && g.charCodeAt(i) === p.charCodeAt(j)) i++, j++
    else if (i === G && j === P) return true
    else if (si >= 0 && sj < P && p.charCodeAt(sj) !== 47) i = si, j = ++sj
    else if (di < 0 || (dirs ? (dj = p.indexOf('/', dj) + 1) === 0 : ++dj > P)) return false
    else i = di, j = dj, si = -1
  }
}

/** How tightly a reference covers a path: -1 when it does not, the length of a glob's literal prefix when it matches, and more than any of those for the file itself. */
function grip(ref: string, path: string): number {
  if (ref === path) return 1e9
  const g = file(ref), star = g.indexOf('*')
  return star < 0 ? (g === path ? 1e9 : -1) : glob(g, path) ? star : -1
}

/**
 * Whether a reference covers a file path, both written from the repository root with forward slashes: the path
 * itself, with or without "#symbol", or a glob in which "**" crosses directories and "*" does not.
 */
export const covers = (ref: string, path: string) => grip(ref, path) >= 0

/**
 * The live records whose references cover a path, most specific first: a reference to the file itself, then globs by
 * the length of their literal prefix, then older before newer. Dropped and superseded records are left out. A path is
 * looked up, and only the distinct globs are tried, so the size of the store hardly shows.
 */
export function governing(t: Tree, path: string): Rec[] {
  const best = new MapOf<Node, number>(), f = file(path)
  const weigh = (r: Ref | undefined, w: number, only?: string) => {
    for (; r; r = r.next) if (r.on && live(r.of) && (only === undefined || r.key === only) && (best.get(r.of) ?? -1) < w) best.set(r.of, w)
  }
  weigh(survey(t).files.get(path), 1e9)
  if (f !== path) weigh(t.files.get(f), 1e9, path) // a file whose own name holds a "#" is filed as if that were a symbol
  for (const [g, r] of t.globs) if (glob(g, path)) weigh(r, g.indexOf('*'))
  return [...best].sort((a, b) => b[1] - a[1] || byBirth(a[0], b[0])).map(h => view(t, h[0]))
}

/**
 * Marks the live specs and decisions that no longer govern anything: none of their references covers one of `paths`,
 * the files that exist (from git). Returns how many; the marks stand until the next call, and show as "!stale".
 */
export function stale(t: Tree, paths: Iterable<string>): number {
  // ponytail: sorts the paths and walks every reference in one go, 100 to 250 ms for 100,000 records against
  // 50,000 paths; call it when git's list of files changes, not before each read
  const all = new SetOf(paths), sorted = [...all].sort(), alive = new SetOf<Node>()
  for (const [f, first] of t.files) {
    const here = all.has(f)
    for (let r: Ref | undefined = first; r; r = r.next) if (r.on && (here || (r.key !== f && all.has(r.key)))) alive.add(r.of)
  }
  for (const [g, first] of t.globs) {
    // a glob is tried on the paths that share its literal prefix, which sit together once sorted
    const head = g.slice(0, g.indexOf('*'))
    let lo = 0, hi = sorted.length, hit = false
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid]! < head) lo = mid + 1
      else hi = mid
    }
    for (; !hit && lo < sorted.length && sorted[lo]!.startsWith(head); lo++) hit = glob(g, sorted[lo]!)
    if (hit) for (let r: Ref | undefined = first; r; r = r.next) if (r.on) alive.add(r.of)
  }
  t.stale = new SetOf()
  for (const n of survey(t).listed) if (n.state !== 'superseded' && n.made!.kind !== 'area' && !alive.has(n)) t.stale.add(n.id)
  return t.stale.size
}

/** For a one-line header: the records in force, how many of them are still proposed, are areas, and are marked stale. */
export function counts(t: Tree): { live: number; proposed: number; areas: number; stale: number } {
  const c = { live: 0, proposed: 0, areas: 0, stale: 0 }
  for (const n of survey(t).listed) {
    if (n.state === 'superseded') continue
    c.live++
    if (n.state === 'proposed') c.proposed++
    if (n.made!.kind === 'area') c.areas++
    if (t.stale.has(n.id)) c.stale++
  }
  return c
}

/** The tree with its lists drawn up as of the last fold: after this `listed`, `missing`, `loose` and every node's `state`, `up`, `kids` and `depth` are current. */
export const fresh = (t: Tree): Tree => survey(t)

/**
 * The records listed straight under one record (its full id) or under the root (""), oldest first. Superseded ones
 * are among them and say so; dropped ones are not. Empty for an id that is no record.
 */
export function children(t: Tree, id = ''): Rec[] {
  const p = id === '' ? survey(t).root : survey(t).nodes.get(id)
  return p ? kids(p).map(n => view(t, n)) : []
}

/**
 * Every record in the lists under one record or the root, parents before children and siblings oldest first, each
 * with its level below where the walk began. Lazy: a caller with a large store takes a few thousand and awaits.
 */
export function* walk(t: Tree, id = ''): Generator<{ rec: Rec; depth: number }, void, undefined> {
  const top = id === '' ? survey(t).root : survey(t).nodes.get(id)
  if (!top) return
  for (const todo: [Node, number][] = [[top, -1]]; todo.length; ) {
    const [p, depth] = todo.pop()!
    if (p !== top) yield { rec: view(t, p), depth }
    for (let ks = kids(p), i = ks.length - 1; i >= 0; i--) todo.push([ks[i]!, depth + 1])
  }
}

/**
 * The listed records in outline order, a record's children only where `open` holds its id: the rows a browser shows,
 * however large the store, since nothing closed is walked. Each node's `depth`, `kids` and `state` are current.
 */
export function unfolded(t: Tree, open: ReadonlySet<string>): Node[] {
  const out: Node[] = []
  for (const todo = kids(survey(t).root).slice().reverse(); todo.length; ) {
    const n = todo.pop()!
    out.push(n)
    if (open.has(n.id)) for (let ks = kids(n), i = ks.length - 1; i >= 0; i--) todo.push(ks[i]!)
  }
  return out
}

/**
 * The listed records that hold every word of `text`, in any case and order, in their id, kind, standing (and "stale" for
 * one `stale` marked), title, why or references, oldest first: a browser's filter. No pattern is built from the text.
 */
export function matching(t: Tree, text: string): Node[] {
  const words = cut(text, 400).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16)
  const hit = (n: Node) => {
    let hay = `${n.id} ${n.made!.kind} ${n.state}${n.state !== 'superseded' && t.stale.has(n.id) ? ' stale' : ''} ${titleOf(n)}\n${n.why?.why ?? ''}`
    if (n.refs) for (const r of n.refs.values()) if (r.on) hay += `\n${r.key}`
    hay = hay.toLowerCase()
    return words.every(w => hay.includes(w))
  }
  return survey(t).listed.filter(hit).sort(byBirth)
}

/** The ids of the records in force that are still proposed, oldest first: what "accept all" accepts. */
export const proposed = (t: Tree): string[] => survey(t).listed.filter(n => n.state === 'proposed').sort(byBirth).map(n => n.id)

/** The ids of the records in force that `stale` last marked, oldest first. */
export const stales = (t: Tree): string[] => survey(t).listed.filter(n => n.state !== 'superseded' && t.stale.has(n.id)).sort(byBirth).map(n => n.id)

/** The most changes `feed` folds in one go unless told otherwise: under bun a slice this size takes a few milliseconds. */
export const SLICE = 4000

/**
 * Folds `changes[from]` and the `max - 1` after it, and returns where the next slice starts (`changes.length` when
 * done). The fold in slices: `for (let i = 0; i < cs.length; ) (i = feed(t, cs, i)), await $.clock.sleep(0)` arrives
 * at the tree one `fold` gives, and no slice is long however large the store. A question between slices is answered
 * from what has been fed so far.
 */
export function feed(t: Tree, changes: readonly Sound[], from = 0, max: number = SLICE): number {
  const to = min(changes.length, from + (max > 0 ? max : SLICE))
  if (from < to) fold(t, from === 0 && to === changes.length ? changes : changes.slice(from, to))
  return to
}

/** The day of a stamp, "2026-10-09", in UTC; a stamp past the year 9999 has none and says so. */
export const day = (at: Stamp): string => (at.ms <= 253_402_300_799_999 ? new DateOf(at.ms).toISOString().slice(0, 10) : 'after-9999')

/** What one change set, in words: "created decision", `title "..."`, "why", "accepted", "superseded by <id>", "+src/a.ts -src/b.ts". */
function did(c: Change, name: (id: string) => string): string {
  const parts: string[] = []
  if (c.kind) parts.push(`created ${c.kind}${c.under ? ` under ${name(c.under)}` : ''}`)
  if (c.title !== undefined) parts.push(`title "${c.title}"`)
  if (c.why !== undefined) parts.push('why')
  // a record is proposed from its creation: that much is not said twice
  if (c.status && !(c.kind && c.status === 'proposed')) parts.push(c.status === 'superseded' && c.replacedBy ? `superseded by ${name(c.replacedBy)}` : c.status)
  if (c.refs?.length) parts.push(c.refs.join(' '))
  return parts.join(', ')
}

/**
 * The history, newest first, a line a change: "<id> <day> <by> via <via>: <what it set>". For one record when `id`
 * (a full id) is given, else for all; a change read from two files is told once. With `t` ids are shortened as the
 * tree shortens them, without it they are written whole. It sorts what it is handed: give it a slice of a large store.
 */
export function log(changes: Iterable<Change>, id?: string, t?: Tree): string[] {
  const mine: Change[] = [], name = (x: string) => (t ? short(t, x) : x), out: string[] = []
  for (const c of changes) if (id === undefined || c.id === id) mine.push(c)
  mine.sort((a, b) => order(b, a))
  for (const [i, c] of mine.entries()) if (i === 0 || order(mine[i - 1]!, c) !== 0) out.push(`${name(c.id)} ${day(c.at)} ${c.by} via ${c.via}: ${did(c, name)}`)
  return out
}

/** A record in full: its line, why, references, standing, who made it and when, what replaced it, its parent and its children. Empty when the id (a full one) is no record. */
export function detail(t: Tree, id: string): string {
  const r = get(t, id)
  if (!r) return ''
  return [
    line(t, id, 0),
    r.why && `why: ${r.why}`,
    r.refs.length ? `refs: ${r.refs.join(' ')}` : '',
    `${r.id} ${r.status}${r.stale ? ', stale (its refs cover no file)' : ''}, by ${r.by} via ${r.via}, ${day(r.at)}`,
    r.replacedBy && `replaced by ${line(t, r.replacedBy, 0) || `${r.replacedBy} (not here)`}`,
    r.under && `under ${line(t, r.under, 0) || `${r.under} (not here)`}`,
    outline(t, { under: id, depth: 1, limit: 30 }),
  ].filter(Boolean).join('\n')
}

/**
 * A record as `git show` would give it: `detail`, then "history:" and its `log`, newest first, indented a space. An
 * id with changes but no creation gets a line saying so above its history; empty when nothing is known of the id.
 */
export function show(t: Tree, changes: Iterable<Change>, id: string): string {
  const head = detail(t, id), past = log(changes, id, t)
  if (!head && !past.length) return ''
  return [head || `${id} has changes but none that creates it: a file of the store is missing`, 'history:', ...past.map(l => ` ${l}`)].join('\n')
}

/** What `diff` found: the ids added, dropped and changed, each oldest first, then the same as lines and as one text. */
export type Diff = { added: string[]; dropped: string[]; changed: string[]; lines: string[]; text: string }

/** The references a record holds in one tree and not in the other, signed and sorted. */
function refsApart(o: Node, n: Node): string[] {
  const out: string[] = [], on = (x: Node, k: string) => x.refs?.get(k)?.on === true
  if (n.refs) for (const r of n.refs.values()) if (r.on && !on(o, r.key)) out.push(`+${r.key}`)
  if (o.refs) for (const r of o.refs.values()) if (r.on && !on(n, r.key)) out.push(`-${r.key}`)
  return out.sort((a, b) => (a.slice(1) < b.slice(1) ? -1 : a.slice(1) > b.slice(1) ? 1 : a < b ? -1 : 1))
}

/**
 * What differs between two folds, as `git diff` between two commits: "+ <line>" for a record only `after` has,
 * "- <line>" for one dropped since `before` (its line says "!dropped") or no longer in the store at all ("(gone)"),
 * and "~ <line>: ..." for one that changed, naming each field: `title "old" -> "new"`, "proposed -> accepted",
 * "kind", "why", "moved under <id>", "replaced by <id>", then references added and removed. Added first, then dropped,
 * then changed, each oldest first; `text` is "no difference" when nothing differs. A record dropped in both is left
 * out, as is one that is new and already dropped. A record hidden under a dropped ancestor counts as dropped, as the
 * lists have it, and its line says "(under a dropped record)". Stale marks are neither compared nor shown: they come from the files,
 * not from the store.
 */
export function diff(before: Tree, after: Tree): Diff {
  survey(before), survey(after)
  const added: Node[] = [], dropped: Node[] = [], changed: Node[] = [], what = new MapOf<Node, string>()
  for (const n of after.nodes.values()) {
    if (!n.made) continue
    const o = before.nodes.get(n.id)
    // a record that was not there, or was hidden under a dropped one, and is in the lists now
    if (!o?.made || (buried(o) && n.depth >= 0)) {
      if (n.depth >= 0) added.push(n), what.set(n, `+ ${row(after, n, 0, false)}`)
      continue
    }
    if (n.depth < 0) {
      if (o.depth >= 0) dropped.push(n), what.set(n, `- ${row(after, n, 0, false)}${buried(n) ? ' (under a dropped record)' : ''}`)
      continue
    }
    const parts: string[] = [], m = n.made, was = o.made, by = (x: Node) => (x.state === 'superseded' && x.status!.replacedBy) || ''
    if (m.kind !== was.kind) parts.push(`kind ${was.kind} -> ${m.kind}`)
    if (m.under !== was.under) parts.push(`moved under ${m.under ? short(after, m.under) : 'the root'}`)
    if (titleOf(n) !== titleOf(o)) parts.push(`title "${titleOf(o)}" -> "${titleOf(n)}"`)
    if (n.state !== o.state) parts.push(`${o.state} -> ${n.state}`)
    if (by(n) !== by(o) && n.state === 'superseded') parts.push(by(n) ? `replaced by ${short(after, by(n))}` : 'replaced by nothing')
    if ((n.why?.why ?? '') !== (o.why?.why ?? '')) parts.push('why')
    const apart = refsApart(o, n)
    if (apart.length) parts.push(apart.join(' '))
    if (parts.length) changed.push(n), what.set(n, `~ ${row(after, n, 0, false)}: ${parts.join(', ')}`)
  }
  for (const o of before.nodes.values()) if (o.made && o.depth >= 0 && !after.nodes.get(o.id)?.made) dropped.push(o), what.set(o, `- ${row(before, o, 0, false)} (gone)`)
  const lines = [added, dropped, changed].flatMap(group => group.sort(byBirth).map(n => what.get(n)!)), ids = (group: Node[]) => group.map(n => n.id)
  return { added: ids(added), dropped: ids(dropped), changed: ids(changed), lines, text: lines.join('\n') || 'no difference' }
}

/**
 * What an agent hands in to add a record. `kind` is a decision unless said; `under` and `replaces` are ids or prefixes.
 * In a batch `key` is a name of the caller's choosing for this add, one word, and a later add of the batch may give it
 * as its `under`.
 */
export type Add = { title: string; why?: string; refs?: readonly string[]; kind?: Kind; under?: string; replaces?: string; key?: string }

/** Who is writing: this load's writer id, whose work it is, and what made it. */
export type Who = Pick<Change, 'writer' | 'by' | 'via'>

const VERB = /^(added|fixed|updated|implemented|renamed|changed|removed|refactored)(?![\w-])/i
/** A reference as it is stored: no "./" in front, and a directory written with a trailing slash covers what is under it. */
const refOf = (r: string) => r.trim().replace(/^\.\//, '').replace(/\/$/, '/**')
/** A title with case, punctuation and spacing taken out, to tell two that say the same. */
const gist = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** An add as the checks read it: every field of its type, and `odd` saying which was not. */
type Asked = { kind: Kind; title: string; why: string; refs: string[]; under: string; replaces: string; key: string; odd: string | undefined }

/** Reads anything as an add and never throws: null and "" are a field left out, one reference may come as a text, and a field of another type is named in `odd`. */
function ask(raw: unknown): Asked {
  const a = (typeof raw === 'object' && raw !== null && !isArray(raw) ? raw : {}) as { [K in keyof Add]?: unknown }
  const text = (x: unknown) => (typeof x === 'string' ? x : ''), wrong = (k: keyof Add) => a[k] != null && typeof a[k] !== 'string'
  const list: unknown[] = typeof a.refs === 'string' ? [a.refs] : isArray(a.refs) ? a.refs : []
  const odd =
    a !== raw ? 'an add is an object: {title, why, refs}'
    : wrong('title') ? 'the title is not text'
    : wrong('why') ? 'the why is not text'
    : a.kind != null && !KINDS.includes(a.kind as Kind) ? `kind is one of ${KINDS.join(', ')}`
    : (a.refs != null && typeof a.refs !== 'string' && !isArray(a.refs)) || list.some(r => typeof r !== 'string') ? 'refs is a list of texts: files, globs or file#symbol'
    : wrong('under') ? 'under is not text: give the id of the parent'
    : wrong('replaces') ? 'replaces is not text: give the id of the record it supersedes'
    : wrong('key') ? 'key is not text'
    : undefined
  return {
    kind: KINDS.includes(a.kind as Kind) ? (a.kind as Kind) : 'decision', title: text(a.title), why: text(a.why), refs: list.filter((r): r is string => typeof r === 'string').map(refOf),
    under: text(a.under).trim(), replaces: text(a.replaces).trim(), key: text(a.key).trim(), odd,
  }
}

/** The one live record `text` names, or why there is none. */
function pick(t: Tree, what: string, text: string): Node | string {
  const hit = resolve(t, text), said = `${what} "${cut(tidy(text), 40)}"`
  if (hit === undefined) return `${said} matches no record`
  if (typeof hit !== 'string') return `${said} matches ${hit.length} records: ${hit.map(id => short(t, id)).join(', ')}`
  const n = t.nodes.get(hit)!
  return live(n) ? n : `${said} is ${n.depth < 0 && n.state !== 'dropped' ? 'under a dropped record' : n.state}: ${row(t, n)}`
}

/** Why an add is turned down by what it says alone, whatever the store holds. */
function unfit(a: Asked): string | undefined {
  const { kind, why, refs } = a, title = tidy(a.title)
  if (a.odd) return a.odd
  if (!title) return 'the title is empty'
  if (title.length > LIMITS.title) return `the title is ${title.length} characters, over the limit of ${LIMITS.title}: state the rule in one line and put the rest in why`
  const verb = VERB.exec(title)?.[0]
  if (verb) return `the title opens with "${verb}", which says what was done: write the rule or the choice itself ("Amounts are integer cents", not "Changed amounts to cents")`
  if (kind !== 'area' && !refs.length) return `a ${kind} needs a ref: the file, glob or file#symbol it governs`
  if (kind !== 'area' && !why.trim()) return `a ${kind} needs a why: the reason, and what was turned down`
  if (why.length > LIMITS.why) return `the why is ${why.length} characters, over the limit of ${LIMITS.why}`
  if (refs.length > LIMITS.refs) return `${refs.length} refs, over the limit of ${LIMITS.refs}: use a glob`
  const odd = refs.find(r => !r || r.length > LIMITS.ref || ODD.test(r))
  if (odd !== undefined) return `ref "${cut(tidy(odd), 40)}" is empty, over ${LIMITS.ref} characters or holds a control character`
  if (a.key && (a.key.length > 40 || INLINE.test(a.key) || a.key.includes(' '))) return 'key is one word of at most 40 characters'
  return undefined
}

/** Why each add of a batch is turned down, read as asked. */
function judge(t: Tree, asks: readonly Asked[]): (string | undefined)[] {
  const gone = survey(t).missing, some = `${gone.length} parent${gone.length > 1 ? 's are' : ' is'} named but not here (${gone.slice(0, 3).join(', ')})`
  const keys = new MapOf<string, number>(), said = new MapOf<string, number>(), taken = new MapOf<Node, number>(), out: (string | undefined)[] = []
  const one = (a: Asked, i: number): string | undefined => {
    const bad = unfit(a)
    if (bad) return bad
    if (gone.length) return `the store is incomplete: ${some}, so a file of it is missing; nothing is added until it is back or a person drops the record that names it (/spec status)`
    const g = gist(tidy(a.title)), same = said.get(g)
    if (same !== undefined) return `the same title as add[${same}] of this call`
    if (a.key && keys.has(a.key)) return `key "${a.key}" is add[${keys.get(a.key)}]'s too`
    if (a.key && resolve(t, a.key) !== undefined) return `key "${a.key}" reads as the id of a record: pick another`
    const parent = a.under ? keys.get(a.under) : undefined, later = a.under && parent === undefined ? asks.findIndex(x => x.key === a.under) : -1
    if (parent !== undefined && out[parent]) return `under "${a.under}" is add[${parent}], which is turned down`
    if (later >= 0) return later === i ? `under "${a.under}" is this add itself` : `under "${a.under}" is add[${later}], which comes after this one: put the parent first`
    const up = a.under && parent === undefined ? pick(t, 'under', a.under) : undefined
    if (typeof up === 'string') return up
    if (a.replaces && asks.some(x => x.key === a.replaces)) return `replaces "${a.replaces}" is an add of this call: only a record already in the store is replaced`
    const old = a.replaces ? pick(t, 'replaces', a.replaces) : undefined
    if (typeof old === 'string') return old
    if (old && taken.has(old)) return `add[${taken.get(old)}] of this call replaces ${short(t, old.id)} already`
    let twin: Node | undefined
    for (const f of a.refs.map(file))
      for (let r = (f.includes('*') ? t.globs : t.files).get(f); r; r = r.next)
        if (r.on && r.of !== old && live(r.of) && gist(titleOf(r.of)) === g && (!twin || byBirth(r.of, twin) < 0)) twin = r.of
    if (twin) return `exists: ${row(t, twin)}`
    if (old) taken.set(old, i)
    return undefined
  }
  for (const [i, a] of asks.entries()) {
    out.push(one(a, i))
    // what a later add is held against, whether or not this one stands
    const g = gist(tidy(a.title))
    if (g && !said.has(g)) said.set(g, i)
    if (a.key && !keys.has(a.key)) keys.set(a.key, i)
  }
  return out
}

/**
 * Why an add is turned down, or undefined when it may be written. The title must be the rule or the choice itself:
 * not empty, not over the limit, not opening with a changelog verb. A spec or a decision needs a reference and a why.
 * `under` and `replaces` must each name one live record, and nothing is added while a parent is missing. A live
 * record on the same file or glob (whatever the symbol) whose title is the same but for case, punctuation and spacing
 * is answered with "exists: " and its line. Whatever is handed in is read, never trusted: a field of the wrong type is
 * a reason, not a throw.
 */
export const refuse = (t: Tree, add: Add): string | undefined => judge(t, [ask(add)])[0]

/**
 * `refuse` for a batch written together: a reason or undefined for each add, in order. Beyond what `refuse` checks,
 * an add may give as `under` the `key` of an add before it in the batch; a key must be one word, the key of one add
 * only, and not readable as a record's id; two adds may not say the same title, nor replace the same record; and an
 * add under one that is turned down is turned down with it. Write the batch only when every entry is undefined.
 */
export const refuseAll = (t: Tree, adds: readonly unknown[]): (string | undefined)[] => judge(t, adds.map(ask))

/**
 * Where a record with these references belongs when no parent is named: the deepest live area one of whose own
 * references covers every one of them (the tightest such, then the oldest, among equals), or "" for the root.
 */
export function home(t: Tree, refs: readonly string[]): string {
  let best: Node | undefined, tight = -1
  // ponytail: a glob counts as covered when the area's glob matches its text, which is right for "dir/**" inside
  // "dir/**" and wrong for a "*" set against a "**"; exact glob containment if records land in the wrong area
  const paths = refs.map(r => file(refOf(r)))
  if (paths.length)
    for (const n of survey(t).listed) {
      if (n.made!.kind !== 'area' || n.state === 'superseded' || (best && n.depth < best.depth)) continue
      for (const a of refsOf(n)) {
        const g = min(...paths.map(p => grip(a, p)))
        if (g >= 0 && (!best || n.depth > best.depth || g > tight || (g === tight && byBirth(n, best) < 0))) best = n, tight = g
      }
    }
  return best?.id ?? ''
}

/** The changes that write one add, or why they cannot be made. `keyed` gives the id of the batch's add with that key. */
function build(t: Tree, a: Asked, id: string, at: Stamp, who: Who, keyed?: (key: string) => string | undefined): Sound[] | string {
  if (a.odd || !tidy(a.title)) return a.odd ?? 'the title is empty'
  const old = a.replaces ? resolve(survey(t), a.replaces) : undefined
  if (a.replaces && typeof old !== 'string') return `replaces "${cut(tidy(a.replaces), 40)}" names no one record`
  const up = a.under ? keyed?.(a.under) ?? resolve(t, a.under) : typeof old === 'string' ? t.nodes.get(old)!.made!.under : home(t, a.refs)
  if (typeof up !== 'string') return `under "${cut(tidy(a.under), 40)}" names no one record`
  const made = clean({ id, at, ...who, kind: a.kind, under: up, title: a.title, why: a.why || undefined, status: 'proposed', refs: a.refs.map(r => `+${r}`) })
  const over = typeof old === 'string' ? clean({ id: old, at: { ms: at.ms, n: at.n + 1 }, ...who, status: 'superseded', replacedBy: id }) : undefined
  if (!made || (typeof old === 'string' && !over)) return ID.test(id) ? 'the stamp or the writer is not one a change may carry' : `"${cut(tidy(id), 40)}" is not a record id`
  return over ? [made, over] : [made]
}

/**
 * The changes that write an accepted add (ask `refuse` first): one that creates the record as proposed, and, when it
 * replaces a record, a second with the next counter that marks that record superseded by it. With no parent named a
 * replacement goes where the record it replaces is, and anything else goes `home`. Empty when it cannot be written;
 * `compose` does the same for one add or many and gives the reason.
 */
export function record(t: Tree, add: Add, id: string, at: Stamp, who: Who): Sound[] {
  const made = build(t, ask(add), id, at, who)
  return typeof made === 'string' ? [] : made
}

/**
 * Checks a batch of adds and turns it into changes, all or none: the changes in the order to write them, or a text
 * saying why nothing is written (for a refusal a line per add, "add[i] "<title>": <reason or fine>"). `ids[i]` is the
 * new id of `adds[i]`, drawn by the caller with `mint`; `at` is the first stamp, `tick(t.clock, now)`, and each change
 * after it takes the next counter, so the whole batch sorts after all the tree has read. An add placed by key goes
 * under that add's new id.
 */
export function compose(t: Tree, adds: readonly unknown[], ids: readonly string[], at: Stamp, who: Who): Sound[] | string {
  // ponytail: an add with no parent named is homed in the store as it stands, never under an area of its own batch;
  // an agent that wants it there says so with the area's key
  const asks = adds.map(ask), why = judge(t, asks), out: Sound[] = [], keys = new MapOf<string, string>()
  if (!asks.length) return 'add is empty'
  if (why.some(Boolean)) return asks.map((a, i) => `add[${i}] "${cut(tidy(a.title), 60)}": ${why[i] ?? 'fine'}`).join('\n')
  if (ids.length !== asks.length || new SetOf(ids).size !== ids.length) return `${asks.length} adds need ${asks.length} ids, no two alike`
  let n = at.n
  for (const [i, a] of asks.entries()) {
    const id = ids[i]!
    if (t.nodes.has(id)) return `add[${i}]: the id ${id} is taken`
    const made = build(t, a, id, { ms: at.ms, n }, who, key => keys.get(key))
    if (typeof made === 'string') return `add[${i}] "${cut(tidy(a.title), 60)}": ${made}`
    out.push(...made), (n += made.length)
    if (a.key) keys.set(a.key, id)
  }
  return out
}
