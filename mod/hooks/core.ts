export const SEP = '§'

/** What the model saw of one file: its lines, one anchor per line, and the next anchor to mint. */
export type FileState = { lines: string[]; anchors: string[]; minted: number }

export type Edit = { from?: string; to?: string; after?: string; before?: string; text?: string; find?: string; replace?: string; rename?: string; delete?: boolean }

/**
 * Anchors are numbers: 1-999 cost one token on Claude's tokenizer, where words cost two to four.
 * Two rules keep a number from being taken for a line number:
 * - every ID is minted well above the file's line count, so a line number from Grep is never an ID;
 * - IDs are permuted, so no arithmetic leads from a line's position to its ID.
 * The block runs from `from`, so the IDs of a re-anchored file never repeat ones the model may still hold.
 */
export function fresh(lines: string[], from = 2 * lines.length + 1): FileState {
  from = Math.max(from, lines.length + Math.max(lines.length, 100) + 1) // headroom: the file can double (or gain 100 lines) first
  const n = Math.max(lines.length, 1)
  let s = Math.max(1, Math.floor(n * 0.618))
  while (gcd(s, n) !== 1) s++
  return { lines, anchors: lines.map((_, i) => String(from + ((i * s) % n))), minted: from + n }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** Whether some ID is now at or below the line count (the file grew past it), so a number could be either. */
export const ambiguous = (st: FileState) => st.anchors.some(a => Number(a) <= st.lines.length)

/** Myers diff: for each line of b, the index of the line of a it keeps, or -1 when it is new. */
export function match(a: readonly string[], b: readonly string[]): number[] {
  const m = new Array<number>(b.length).fill(-1)
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) m[s] = s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) m[--eb] = --ea
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, M = B.length, off = n + M + 1
  if (n === 0 || M === 0) return m
  // ponytail: keeps one V per step, O(D*(N+M)) memory; linear-space Myers if huge rewrites matter
  const v = new Int32Array(2 * off + 1), trace: Int32Array[] = []
  const down = (v: Int32Array, k: number, d: number) => k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
  search: for (let d = 0; d <= n + M; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = down(v, k, d) ? v[off + k + 1]! : v[off + k - 1]! + 1, y = x - k
      while (x < n && y < M && A[x] === B[y]) x++, y++
      v[off + k] = x
      if (x >= n && y >= M) break search
    }
  }
  let x = n, y = M
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d]!, k = x - y, pk = down(t, k, d) ? k + 1 : k - 1
    const px = d === 0 ? 0 : t[off + pk]!, py = d === 0 ? 0 : px - pk
    while (x > px && y > py) m[s + --y] = s + --x
    x = px, y = py
  }
  return m
}

/** Carries anchors from what the model last saw onto `lines`; changed lines get fresh ones. */
export function sync(prev: FileState | undefined, lines: string[]): FileState {
  if (!prev) return fresh(lines)
  const m = match(prev.lines, lines)
  let minted = Math.max(prev.minted, lines.length + 1)
  return { lines, anchors: m.map(i => (i < 0 ? String(minted++) : prev.anchors[i]!)), minted }
}

export function render(st: FileState, start = 0, end = st.lines.length): string {
  return st.lines.slice(start, end).map((l, i) => st.anchors[start + i] + SEP + l).join('\n')
}

export type Applied = { lines: string[]; warnings: string[] }

/** The lines after the edits (all against the same snapshot), or the reason they cannot apply. */
export function apply(st: FileState, edits: readonly Edit[]): Applied | string {
  const at = new Map(st.anchors.map((a, i) => [a, i]))
  // a 1-based line number (from Grep) is taken only where find checks that line's content
  const idx = (a: string, byNumber = false) => {
    const key = a.split(SEP)[0]!.trim(), n = Number(key) // tolerate "Anchor§code" pasted whole
    if (at.has(key) && n <= st.lines.length) throw `${key} is both an anchor and a line number now; read the file again for fresh anchors`
    const i = at.get(key) ?? (byNumber && Number.isInteger(n) && n >= 1 && n <= st.lines.length ? n - 1 : undefined)
    if (i === undefined) throw `unknown anchor "${a}" (its line changed, or it never existed)`
    return i
  }
  // a line that starts with one of this file's anchors was pasted from a read: drop the prefix
  const strip = (l: string) => (l.indexOf(SEP) > 0 && at.has(l.slice(0, l.indexOf(SEP))) ? l.slice(l.indexOf(SEP) + 1) : l)
  const body = (t = '') => (t === '' ? [] : t.replace(/\n$/, '').split('\n').map(strip))
  type Range = [number, number, string[], boolean]
  let ranges: Range[]
  // find edits over one range chain, each on the text the one before left: several renames in a file are one call
  const chained = new Map<string, Range>()
  try {
    ranges = edits.flatMap((e): Range[] => {
      const a = e.from ?? e.after ?? e.before
      if (e.find !== undefined) {
        const lo = e.from === undefined ? 0 : idx(e.from, true), hi = e.from === undefined ? st.lines.length : idx(e.to ?? e.from, true) + 1
        const prior = chained.get(`${lo}:${hi}`)
        // the range as one text, so find can span lines
        const old = (prior?.[2] ?? st.lines.slice(lo, hi)).join('\n'), rep = old.split(e.find).join(e.replace ?? '')
        if (e.find === '' || rep === old) throw `"${e.find}" not found ${e.from === undefined ? 'in the file' : 'in that range'}`
        if (prior) return (prior[2] = rep.split('\n')), []
        const range: Range = [lo, hi, rep.split('\n'), false]
        chained.set(`${lo}:${hi}`, range)
        return [range]
      }
      if (a === undefined) throw 'each edit needs from, after, before or find'
      const i = idx(a)
      return [e.from !== undefined ? [i, idx(e.to ?? e.from) + 1, body(e.text), true]
        : e.after !== undefined ? [i + 1, i + 1, body(e.text), true] : [i, i, body(e.text), true]]
    })
  } catch (err) {
    return String(err)
  }
  ranges.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  for (const [i, [a, b]] of ranges.entries()) {
    if (b < a) return '"to" comes before "from"'
    if (i && a < ranges[i - 1]![1])
      return ranges[i]![3] && ranges[i - 1]![3] ? 'edits overlap' : 'edits overlap: a find edit takes its whole range (the file, without from); narrow it with from/to, or send it in its own call'
  }
  // the silent failure of line edits: the line just outside the range copied into the new text
  const warnings: string[] = []
  const dup = (l: string | undefined, n: string | undefined) => l !== undefined && l === n && l.trim().length > 2
  for (const [a, b, rep, written] of ranges) {
    if (!written || !rep.length) continue
    if (dup(st.lines[a - 1], rep[0])) warnings.push(`first new line repeats the line above it (${st.anchors[a - 1]}); delete one if that was not meant`)
    if (dup(st.lines[b], rep.at(-1))) warnings.push(`last new line repeats the line below it (${st.anchors[b]}); delete one if that was not meant`)
    // flush-left text dropped between two indented lines is usually a lost indent (a docstring, a method body)
    const ind = (l?: string) => (l?.trim() ? l.length - l.trimStart().length : undefined)
    // a replacement is judged by the line it replaces, an insertion by its neighbours
    const was = a < b ? ind(st.lines.slice(a, b).find(l => l.trim()))
      : Math.min(ind(st.lines.slice(0, a).findLast(l => l.trim())) ?? 0, ind(st.lines.slice(b).find(l => l.trim())) ?? 0)
    if (was && rep.every(l => !l.trim() || ind(l) === 0))
      warnings.push(`new text is not indented, but the lines it ${a < b ? 'replaces are' : 'sits between are'} (by ${was}); re-indent if that was not meant`)
  }
  const out = st.lines.slice()
  for (const [a, b, rep] of ranges.reverse()) out.splice(a, b - a, ...rep)
  return { lines: out, warnings }
}

/** The kept lines with their anchors, runs split by "…". */
function blocks(st: FileState, keep: (i: number) => boolean): string {
  const out: string[] = []
  st.lines.forEach((l, i) => {
    if (keep(i)) out.push(st.anchors[i] + SEP + l)
    else if (out.length && out.at(-1) !== '…') out.push('…')
  })
  if (out.at(-1) === '…') out.pop()
  return out.join('\n')
}

/** The new lines of `next` (anchors `prev` never had), with `ctx` unchanged lines either side to show where they landed. */
export function changed(prev: FileState, next: FileState, ctx = 1): string {
  const old = new Set(prev.anchors), isNew = (i: number) => i >= 0 && i < next.lines.length && !old.has(next.anchors[i]!)
  return blocks(next, i => isNew(i) || (ctx > 0 && (isNew(i - 1) || isNew(i + 1))))
}

/** Lines matching `re`, with `ctx` lines around each. */
export function search(st: FileState, re: RegExp, ctx: number, within: (i: number) => boolean = () => true): { text: string; hits: number } {
  const keep = new Uint8Array(st.lines.length)
  let hits = 0
  st.lines.forEach((l, i) => {
    if (!within(i) || !re.test(l)) return
    hits++
    keep.fill(1, Math.max(0, i - ctx), i + ctx + 1)
  })
  return { text: blocks(st, i => keep[i] === 1), hits }
}

/** Where an anchor the model holds went: the current lines around its old place, freshly anchored. */
export function near(prev: FileState, cur: FileState, anchor: string, r = 3): string | undefined {
  const i = prev.anchors.indexOf(anchor.split(SEP)[0]!.trim())
  if (i < 0) return undefined
  const pos = new Map(cur.anchors.map((a, k) => [a, k]))
  for (let d = 1; d <= prev.lines.length; d++)
    for (const c of [pos.get(prev.anchors[i - d] ?? ''), pos.get(prev.anchors[i + d] ?? '')])
      if (c !== undefined) return render(cur, Math.max(0, c - r), c + r + 1)
  return undefined
}

/** Splits text into lines, remembering the line ending and whether it ends with one. */
export function split(text: string): { lines: string[]; eol: string; trailing: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', trailing = text.endsWith(eol)
  const lines = text === '' ? [] : text.split(eol)
  if (trailing) lines.pop()
  return { lines, eol, trailing }
}

// ---- whole files: create, delete, rename ----

/** What a path is now, as the caller found it: undefined when nothing is there. */
export type Kind = 'file' | 'dir' | undefined

/** One call's work sorted out: files to create (path, text), delete and move (from, to), and the line edits per file. */
export type Ops = { create: Map<string, string>; remove: string[]; move: Map<string, string>; groups: Map<string, Edit[]> }

/** A path spelled one way, so two edits naming one file meet: no "./", no doubled or trailing slash. */
export const tidy = (p: string) => p.replace(/\/{2,}/g, '/').replace(/^(\.\/)+(?=.)/, '').replace(/(.)\/$/, '$1')

/**
 * Sorts a call's edits into file operations and line edits, or says why the whole call cannot stand.
 * {text} alone creates, so it needs a path where nothing is; delete and rename need one where something is.
 */
export function ops(edits: readonly (Edit & { path?: string })[], path: string, kind: (p: string) => Kind): Ops | string {
  const o: Ops = { create: new Map(), remove: [], move: new Map(), groups: new Map() }
  const taken = new Set<string>()
  for (const { path: own, rename, delete: gone, ...x } of edits) {
    if (!(own ?? path)) return 'each edit needs a path, or give one path for all of them'
    const p = tidy(own ?? path), k = kind(p), lines = (x.from ?? x.after ?? x.before ?? x.find) !== undefined
    if (gone) {
      if (k !== 'file') return `${p}: ${k ? 'is a directory; delete takes one file' : 'no such file to delete'}`
      if (!o.remove.includes(p)) o.remove.push(p)
      continue
    }
    if (rename !== undefined) {
      const to = tidy(rename)
      if (!k) return `${p}: no such file to rename`
      if (o.move.has(p)) return `${p}: renamed twice`
      if (!to || to === p) return `${p}: rename needs another path`
      if (kind(to) || taken.has(to)) return `${p}: cannot rename to ${to}, which exists; delete that first`
      taken.add(to), o.move.set(p, to)
      if (!lines) continue
    } else if (!lines && x.text !== undefined) {
      if (k) return `${p}: exists already, so {text} alone cannot create it; edit it by ID or find, or delete it first`
      if (taken.has(p)) return `${p}: created twice`
      taken.add(p), o.create.set(p, x.text)
      continue
    }
    if (k !== 'file') return `${p}: ${k ? 'is a directory; line edits take a file' : 'no such file ({path, text} alone creates one)'}`
    o.groups.set(p, [...(o.groups.get(p) ?? []), x])
  }
  for (const p of o.remove) if (o.groups.has(p) || o.move.has(p)) return `${p}: delete takes the file whole; drop its other edits`
  for (const p of o.create.keys()) if (o.groups.has(p)) return `${p}: does not exist yet; put all of it in the one {text}`
  return o
}

/** Whether the real path `real` is under the folder `root` (itself a real path): the folder itself is not. */
export const inside = (real: string, root: string) => real.startsWith(`${root.replace(/\/$/, '')}/`)

/** Whether a path is a .git folder or goes through one. */
export const inGit = (p: string) => /(^|\/)\.git(\/|$)/.test(p)

/** A new file's lines with their IDs: all of a short one, the head and tail of a long one. */
export function created(st: FileState, max = 40): string {
  if (st.lines.length <= max) return render(st)
  return `${render(st, 0, 5)}\n…\n${render(st, st.lines.length - 5)}\n[${st.lines.length} lines; read with pattern for the IDs between]`
}

// ---- shell commands that edit a text file by script ----

/** A word of a command; `add` on a redirect target written with ">>": it is added to, never emptied. */
type Word = { t: string; dyn: boolean; add?: true }
type Seg = { words: Word[]; outs: Word[]; piped: boolean; doc?: string }

const DOC = /^<<(-?)\s*\\?(['"]?)([\w.-]+)\2/

/**
 * The index of the ")" that closes the "$(" whose body starts at `j` (the text's end when none does): quotes, nested
 * substitutions and heredoc bodies are stepped over, so a commit message quoting shell text closes where the shell closes it.
 * ponytail: a case pattern's lone ")" closes it early.
 */
function closing(cmd: string, j: number): number {
  const tags: { tag: string; strip: boolean }[] = []
  const next = (ch: string, at: number) => (cmd.indexOf(ch, at) < 0 ? cmd.length : cmd.indexOf(ch, at))
  for (let depth = 1; j < cmd.length; j++) {
    const c = cmd[j]!
    if (c === '\\') j++
    else if (c === "'" || c === '`') j = next(c, j + 1)
    else if (c === '"') {
      for (j++; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\') j++
        else if (cmd[j] === '$' && cmd[j + 1] === '(') j = closing(cmd, j + 2)
      }
    } else if (c === '<') {
      const doc = DOC.exec(cmd.slice(j, j + 80))
      if (doc && cmd[j + 2] !== '<') tags.push({ tag: doc[3]!, strip: doc[1] === '-' }), (j += doc[0].length - 1)
    } else if (c === '\n') {
      for (const d of tags.splice(0)) {
        while (j < cmd.length) {
          const e = next('\n', j + 1), line = cmd.slice(j + 1, e)
          j = e
          if ((d.strip ? line.replace(/^\t+/, '') : line) === d.tag) break
        }
      }
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return cmd.length
}

/**
 * A shell command as simple commands: words unquoted, output redirect targets apart, heredoc bodies attached.
 * ponytail: quotes, $(), heredocs and operators only; no expansion, and a word holding $ or a glob is marked dyn.
 */
export function shell(cmd: string): Seg[] {
  const segs: Seg[] = [], docs: { tag: string; strip: boolean; seg: Seg }[] = []
  let seg: Seg = { words: [], outs: [], piped: false }, w = '', has = false, dyn = false, redir: 'out' | 'add' | 'skip' | undefined
  const push = () => {
    if (has && redir !== 'skip') (redir ? seg.outs : seg.words).push({ t: w, dyn, ...(redir === 'add' ? { add: true as const } : {}) })
    if (has) (w = ''), (has = false), (dyn = false), (redir = undefined)
  }
  const end = (piped: boolean) => {
    push()
    if (seg.words.length || seg.outs.length) segs.push(seg)
    seg = { words: [], outs: [], piped }
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!, n = cmd[i + 1]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1), e = j < 0 ? cmd.length : j
      ;(w += cmd.slice(i + 1, e)), (has = true), (i = e)
    } else if (c === '"') {
      for (has = true, i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && '"\\$`\n'.includes(cmd[i + 1] ?? ' ')) w += cmd[++i] === '\n' ? '' : cmd[i]
        else if (cmd[i] === '$' && cmd[i + 1] === '(') {
          // "$( … )": its text is the word's, whatever quotes and operators it holds; never commands of this line
          const j = closing(cmd, i + 2)
          ;(w += cmd.slice(i, j + 1)), (dyn = true), (i = j)
        } else (dyn ||= cmd[i] === '$' || cmd[i] === '`'), (w += cmd[i])
      }
    } else if (c === '\\') {
      if (n !== '\n') (w += n ?? ''), (has = true)
      i++
    } else if ((c === '$' && n === '(') || c === '`') {
      // a command substitution stays one piece of its word, operators inside it included
      const j = c === '`' ? (cmd.indexOf('`', i + 1) < 0 ? cmd.length : cmd.indexOf('`', i + 1)) : closing(cmd, i + 2)
      ;(w += cmd.slice(i, j + 1)), (has = dyn = true), (i = j)
    } else if (c === ' ' || c === '\t') push()
    else if (c === '\n') {
      end(false)
      for (const d of docs.splice(0)) {
        const body: string[] = []
        for (let line = ''; i < cmd.length; body.push(line)) {
          const j = cmd.indexOf('\n', i + 1), e = j < 0 ? cmd.length : j
          ;(line = cmd.slice(i + 1, e)), (i = e)
          if ((d.strip ? line.replace(/^\t+/, '') : line) === d.tag) break
        }
        d.seg.doc = body.join('\n')
      }
    } else if (c === ';' || c === '(' || c === ')') end(false)
    else if (c === '|') (n === '|' ? end(false) : end(true)), (i += n === '|' || n === '&' ? 1 : 0)
    else if (c === '&' && n === '>') push(), (redir = cmd[i + 2] === '>' ? 'add' : 'out'), (i += cmd[i + 2] === '>' ? 2 : 1)
    else if (c === '&') end(false), (i += n === '&' ? 1 : 0)
    else if (c === '<') {
      const doc = DOC.exec(cmd.slice(i, i + 80))
      push()
      if (doc && cmd[i + 2] !== '<') docs.push({ tag: doc[3]!, strip: doc[1] === '-', seg }), (i += doc[0].length - 1)
      else (redir = 'skip'), (i += n === '<' ? 2 : 0)
    } else if (c === '>') {
      const fd = has && /^\d+$/.test(w) ? w : ''
      fd ? ((w = ''), (has = false)) : push()
      if (n === '>' || n === '|') i++
      // 2> is a log of errors and >&2 names no file: neither is taken for a target
      if (cmd[i + 1] === '&') (redir = 'skip'), i++
      else redir = fd === '2' ? 'skip' : n === '>' ? 'add' : 'out'
    } else if (c === '#' && !has) i = (cmd.indexOf('\n', i) < 0 ? cmd.length : cmd.indexOf('\n', i)) - 1
    else (dyn ||= c === '$' || c === '*' || c === '?' || c === '['), (w += c), (has = true)
  }
  end(false)
  return segs
}

/** What a command would rewrite: by which means, whether surely (else only where a path exists), the paths ('' for one not spelled out), and a plain substitution when it is one. */
export type ShellEdit = { by: string; certain: boolean; paths: string[]; cd?: string; sub?: { find: string; replace: string } }

const WRAP = new Set(['sudo', 'env', 'time', 'timeout', 'gtimeout', 'command', 'nice', 'nohup', 'exec', 'do', 'then', 'else', 'if', 'while', '!', '{'])
/** The options of a wrapper that take the next word with them. */
const WRAP_ARG: Record<string, RegExp> = { sudo: /^-[ughpCDRTU]$|^--(user|group|host|prompt)$/, env: /^-[uCS]$|^--(unset|chdir)$/, timeout: /^-[sk]$|^--(signal|kill-after)$/, gtimeout: /^-[sk]$|^--(signal|kill-after)$/, nice: /^-n$|^--adjustment$/, exec: /^-a$/ }
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'])
const EMIT = new Set(['cat', 'echo', 'printf', 'sed', 'gsed', 'awk', 'gawk', 'jq', 'yq', 'tr', 'envsubst', 'perl', 'cut', 'paste'])
const IN_PLACE: Record<string, RegExp> = { sed: /^(-[nEruzs]*i|--in-place)/, gsed: /^(-[nEruzs]*i|--in-place)/, perl: /^-[0-9pnlaswW]*i/, ruby: /^-[0-9pnla]*i/ }
const PLAIN = /^[^.*^$\\[\]+?(){}|&]+$/
const SHELL = /^(ba|z|da|k)?sh$/
/** A sed script line that writes the lines it selects to a file: "w FILE" under an address, or as a flag of s. */
const SED_W = /^\s*(?:(?:\d+|\$|\/[^/]*\/)(?:,(?:\d+|\$|\/[^/]*\/))?\s*|s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpI\d]*)w\s+(\S.*?)\s*$|^\s*w\s+(\S.*?)\s*$/
/** Perl's open for writing onto a path spelled out: open(F, ">file"), and open(my $f, '>>', 'file'). */
const PERL_OPEN = /\bopen\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*(['"])\s*(?:\+?>>?|\+<)(?::[\w():]+)?\s*(?:\1\s*,\s*(['"])([^'"$@]+)\2|([^'"$@>&\s][^'"$@]*?)\s*\1)/g
const PHP_PUT = /\bfile_put_contents\s*\(\s*(['"])([^'"$]+)\1/g
/** The files a unified diff rewrites: its "+++" lines (or git's "diff --git" ones), less the `strip` leading folders patch -pN takes off. */
function patched(diff: string, strip: number): string[] {
  const named = [...diff.matchAll(/^\+\+\+ ([^\t\n]+)/gm)].map(m => m[1]!.trim())
  const all = named.length ? named : [...diff.matchAll(/^diff --git \S+ (\S+)$/gm)].map(m => m[1]!)
  return all.filter(p => p !== '/dev/null').map(p => p.split('/').slice(strip).join('/')).filter(Boolean)
}

const name = (w?: Word) => w?.t.replace(/^.*\//, '') ?? ''

/** The words of the command a segment really runs: past assignments, sudo and the like, xargs, find -exec and package runners; a string for sh -c. */
function head(words: Word[]): Word[] | string {
  let ws = words
  for (;;) {
    const c = name(ws[0])
    if (!ws.length) return ws
    if (/^\w+=/.test(ws[0]!.t)) ws = ws.slice(1)
    else if (WRAP.has(c)) {
      // past the wrapper's own options (env -i, nice -n 5) and timeout's duration, to the command it runs
      let i = 1
      for (; ws[i]?.t.startsWith('-'); i++) if (WRAP_ARG[c]?.test(ws[i]!.t)) i++
      ws = ws.slice(/timeout$/.test(c) ? i + 1 : i)
    }
    else if (c === 'xargs' || (RUNNERS.has(c) && ws[1]?.t === 'run')) {
      let i = c === 'xargs' ? 1 : 2
      for (; ws[i]?.t.startsWith('-'); i++) if (/^-[InPLdEs]$|^--with$/.test(ws[i]!.t)) i++
      ws = ws.slice(i)
    } else if (c === 'find') {
      const i = ws.findIndex(w => /^-(exec|execdir|ok)$/.test(w.t))
      if (i < 0) return []
      ws = ws.slice(i + 1)
    } else if (SHELL.test(c) && /^-\w*c$/.test(ws[1]?.t ?? '')) return ws[2]?.t ?? ''
    else if (c === 'eval') return ws.slice(1).map(w => w.t).join(' ')
    else return ws
  }
}

/** The top-level arguments of the call whose "(" ends at `at`, quotes and nested brackets respected. */
function callArgs(src: string, at: number): string[] {
  const out: string[] = []
  let depth = 0, q = '', from = at
  for (let i = at; i < src.length; i++) {
    const c = src[i]!
    if (q) (c === '\\' && i++), c === q && (q = '')
    else if (c === '"' || c === "'" || c === '`') q = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && depth-- === 0) return [...out, src.slice(from, i).trim()]
    else if (c === ',' && depth === 0) out.push(src.slice(from, i).trim()), (from = i + 1)
  }
  return out
}

/** The text of a plain string literal (no interpolation), else undefined. */
const literal = (arg = '') => /^[rbu]?(['"`])([^'"`\\$]*)\1$/.exec(arg)?.[2]
const WRITE_MODE = /^[rbt]*[wax+][rbtwax+]*$/

const ARGV = { py: /^sys\.argv\[(\d+)\]$/, js: /^process\.argv\[(\d+)\]$/, rb: /^ARGV\[(\d+)\]$/ }
const PATH_OF = /^(?:pathlib\.)?Path\(\s*([^()]*?)\s*\)$/

/**
 * Whether an inline script writes a file: the paths it names ('' for one it computes); undefined when it only reads and
 * prints. A path is named by a string, by one of the script's own arguments (`argv`: sys.argv[1], process.argv[1], ARGV[0]),
 * by Path('…'), or by a variable set once to one of those. x.open(…, 'w') counts for the builtin open (io, codecs), for a
 * pathlib receiver, and for any other module (gzip, tarfile) only with a path spelled out.
 */
export function writes(lang: 'py' | 'js' | 'rb', src: string, argv: readonly string[] = []): string[] | undefined {
  const paths: string[] = []
  const each = (re: RegExp, f: (args: string[], m: RegExpExecArray) => void) => {
    for (let m; (m = re.exec(src)); ) f(callArgs(src, m.index + m[0].length), m)
  }
  /** What a variable was set to: the text after its first "name =", to the end of the statement. */
  const set = (v: string) => new RegExp(`(?:^|[^\\w.])${v}\\s*=(?!=)\\s*([^;\\n]+)`).exec(src)?.[1]?.trim()
  const named = (x = '', deep = 0): string => {
    const lit = literal(x), arg = ARGV[lang].exec(x), inner = PATH_OF.exec(x)
    if (lit !== undefined) return lit
    if (arg) return argv[Number(arg[1]) - (lang === 'rb' ? 0 : 1)] ?? ''
    if (inner) return named(inner[1], deep + 1)
    return deep < 3 && /^[A-Za-z_]\w*$/.test(x) ? named(set(x), deep + 1) : ''
  }
  if (lang === 'py') {
    /** The receiver of the method call at `at`: Path('…') or a name. */
    const receiver = (at: number) => /((?:pathlib\.)?Path\([^()]*\)|[A-Za-z_][\w.]*)\s*$/.exec(src.slice(0, at))?.[1] ?? ''
    const isPath = (x: string) => PATH_OF.test(x) || (/^[A-Za-z_]\w*$/.test(x) && /^(pathlib\.)?Path\(/.test(set(x) ?? ''))
    const mode = (a: string[]) => a.map(x => x.replace(/^mode\s*=\s*/, '')).some(x => WRITE_MODE.test(literal(x) ?? ''))
    each(/(\.\s*)?\bopen\s*\(/g, (a, m) => {
      const on = m[1] ? receiver(m.index) : ''
      if (!m[1] || /^(io|codecs)$/.test(on)) mode(a.slice(1)) && paths.push(named(a[0]))
      else if (isPath(on)) mode(a) && paths.push(named(on))
      // gzip.open('a.gz', 'wt'), tarfile.open(…): only a path spelled out, since most such files are made, not edited
      else if (named(a[0]) && mode(a.slice(1))) paths.push(named(a[0]))
    })
    each(/\.write_(text|bytes)\s*\(/g, (_a, m) => paths.push(named(receiver(m.index))))
    each(/\bfileinput\s*\.\s*(?:input|FileInput)\s*\(/g, a => a.some(x => /^inplace\s*=\s*(True|1)$/.test(x)) && paths.push(named(a[0])))
  } else if (lang === 'js') {
    each(/\b(writeFile(Sync)?|appendFile(Sync)?|createWriteStream|writeTextFile(Sync)?)\s*\(|\bBun\.write\s*\(/g, a => paths.push(named(a[0])))
  } else {
    each(/\b(File|IO)\.write\s*\(/g, a => paths.push(named(a[0])))
    each(/\bFile\.open\s*\(/g, a => WRITE_MODE.test(literal(a[1]) ?? '') && paths.push(named(a[0])))
  }
  return paths.length ? paths : undefined
}

/** The script an interpreter was handed inline (-c, -e, a heredoc on stdin), with its language and its own arguments ('' for one not spelled out); undefined when it runs a file. */
function inline(c: string, ws: Word[], doc?: string): { lang: 'py' | 'js' | 'rb'; src: string; argv: string[] } | undefined {
  const lang = /^(python[\d.]*|pypy3?)$/.test(c) ? 'py' : /^(node|bun|deno|tsx)$/.test(c) ? 'js' : c === 'ruby' ? 'rb' : undefined
  if (!lang) return undefined
  const flag = lang === 'py' ? /^-\w*c$/ : /^(-\w*[ep]|--eval|--print)$/
  const src = ws.flatMap((w, i) => (i && flag.test(ws[i - 1]!.t) ? [w.t] : /^--(eval|print)=/.test(w.t) ? [w.t.replace(/^[^=]*=/, '')] : []))
  // what follows the script is the script's: sys.argv[1] is the first word after it
  const last = ws.findLastIndex((_w, i) => i > 0 && flag.test(ws[i - 1]!.t))
  if (src.length) return { lang, src: src.join('\n'), argv: ws.slice(last + 1).filter(w => !w.t.startsWith('-')).map(w => (w.dyn ? '' : w.t)) }
  // python3 - <<EOF, node <<EOF: the heredoc is the script only when no file is named
  return doc !== undefined && ws.slice(1).every(w => w.t.startsWith('-')) ? { lang, src: doc, argv: [] } : undefined
}

/** The one plain substitution in the text, as a sed s command or a .replace('a', 'b') call. */
function substitution(sed: Word | undefined, src = ''): ShellEdit['sub'] {
  // a long script is no plain substitution, and the pattern backtracks on one made of its own delimiter
  const s = !sed || sed.dyn || sed.t.length > 400 ? undefined : /^s(.)(.+?)\1(.*?)\1[gI\d]*;?$/.exec(sed.t.trim())
  if (s) return PLAIN.test(s[2]!) && !/[\\&]/.test(s[3]!) ? { find: s[2]!, replace: s[3]! } : undefined
  const calls = [...src.matchAll(/\.replace(?:All)?\(\s*(['"])((?:(?!\1)[^\\])+)\1\s*,\s*(['"])((?:(?!\3)[^\\])*)\3\s*\)/g)]
  return calls.length === 1 ? { find: calls[0]![2]!, replace: calls[0]![4]! } : undefined
}

/**
 * Judges a Bash command before it runs: does it rewrite a text file in place by script (sed -i, perl -pi, an inline
 * python/node/ruby/bun script that writes a file it names, ed/ex, awk -i inplace, yq -i, replace-in-file, a patch from a
 * heredoc, or a redirect, tee, sponge, dd or truncation onto a file)? What a shell is handed as text (sh -c, eval, a
 * heredoc, an echo piped to sh) is judged as the commands it is. Formatters, build tools, git, test runners and scripts run from a file are never looked at, nor is the
 * text of a "$( … )" or of a heredoc no interpreter reads; a script that writes where it computes is let be: that is
 * how reports and temporary files are made. Unsure means undefined.
 */
export function shellEdit(command: string): ShellEdit | undefined {
  const segs = shell(command), loose: string[] = [], temp = new Set<string>()
  let cd: string | undefined, by = '', sub: ShellEdit['sub'], from = 0
  const path = (w: Word) => (w.dyn ? '' : w.t)
  for (const [i, seg] of segs.entries()) {
    const ws = head(seg.words)
    if (!seg.piped) from = i // where the pipeline this command is in begins
    /** The commands a shell was handed as text, judged as this line is; a sure rewrite among them is the verdict. */
    const within = (text: string): ShellEdit | undefined => {
      const inner = shellEdit(text)
      if (inner?.certain) return cd && !inner.cd ? { ...inner, cd } : inner
      // ponytail: a redirect inside sh -c is followed only when no cd of its own moves it
      if (inner && !inner.cd) loose.push(...inner.paths), (by ||= inner.by), (sub ??= inner.sub)
      return undefined
    }
    if (typeof ws === 'string') {
      const inner = within(ws)
      if (inner) return inner
      continue
    }
    const c = name(ws[0]), args = ws.slice(1), opts = args.filter(w => w.t.startsWith('-')).map(w => w.t)
    const certain = (how: string, paths: string[], sub?: ShellEdit['sub']): ShellEdit => ({ by: how, certain: true, paths, ...(cd ? { cd } : {}), ...(sub ? { sub } : {}) })
    const plain = args.filter(w => !w.t.startsWith('-')), first = head(segs[from]!.words)
    if (c === 'cd' && args[0] && !args[0].dyn) cd = args[0].t
    // a shell with no script file reads its commands from stdin: a heredoc, or text echoed down the pipe to it
    if (SHELL.test(c) && !plain.length) {
      const said = !seg.piped || i !== from + 1 || typeof first === 'string' ? undefined
        : /^(echo|printf)$/.test(name(first[0])) ? first.slice(1).filter(w => !w.t.startsWith('-')).map(w => w.t).join(' ')
        : name(first[0]) === 'cat' && first.length === 1 ? segs[from]!.doc : undefined
      const inner = within(seg.doc ?? said ?? '')
      if (inner) return inner
    }
    // yq -i EXPRESSION FILES: the expression is not a file
    if (c === 'yq' && opts.some(o => /^-[CMNPenrsvjy0]*i$|^--in-?place$/.test(o))) return certain('yq -i', plain.filter(w => !/^(e|ea|eval|eval-all)$/.test(w.t)).slice(1).map(path))
    // replace-in-file FROM TO FILES, by name or through npx: a tool that does nothing but rewrite in place
    const run = /^(npx|bunx|pnpx)$/.test(c) ? plain.slice(1) : plain
    if ((c === 'replace-in-file' || (run !== plain && name(plain[0]) === 'replace-in-file')) && !opts.some(o => /^--dry/.test(o))) {
      const [a, b] = run, isPlain = a && b && !a.dyn && !b.dyn && !opts.includes('--isRegex') && PLAIN.test(a.t)
      return certain('replace-in-file', run.slice(2).map(path), isPlain ? { find: a.t, replace: b.t } : undefined)
    }
    // a diff in a heredoc, applied: the files it names when it names any
    const applies = c === 'patch' ? !opts.some(o => /^--dry-run$|^-C$|^--check$/.test(o)) : c === 'git' && args[0]?.t === 'apply' && !opts.some(o => /^--(check|stat|numstat|summary)$/.test(o))
    if (applies && seg.doc !== undefined) {
      const p = args.findIndex(w => /^(-p|--strip)/.test(w.t)), n = p < 0 ? (c === 'git' ? 1 : 0) : Number(/\d+$/.exec(args[p]!.t)?.[0] ?? args[p + 1]?.t)
      const files = patched(seg.doc, n || 0)
      if (!files.length) return certain(c === 'git' ? 'git apply' : 'patch', [])
      loose.push(...files), (by ||= c === 'git' ? 'git apply' : 'patch')
    }
    // sed without -i prints: only its redirect counts, further down
    if ((c === 'sed' || c === 'gsed') && opts.some(o => IN_PLACE.sed!.test(o))) {
      const scripts = args.filter((_w, k) => args[k - 1]?.t === '-e')
      const rest = args.filter((w, k) => w.t && !w.t.startsWith('-') && !/^-(e|f)$/.test(args[k - 1]?.t ?? ''))
      if (!scripts.length && rest.length) scripts.push(rest.shift()!)
      return certain('sed -i', rest.map(path), scripts.length === 1 ? substitution(scripts[0]) : undefined)
    }
    // sed's w command writes a file without -i: sed -n 'w FILE', s/a/b/w FILE
    if (c === 'sed' || c === 'gsed') {
      const given = args.filter((_w, k) => args[k - 1]?.t === '-e'), scripts = given.length ? given : plain.slice(0, 1)
      for (const s of scripts) for (const line of s.dyn || s.t.length > 400 ? [] : s.t.split('\n')) {
        const m = SED_W.exec(line), file = m?.[2] ?? m?.[3]
        if (file) loose.push(file), (by ||= 'sed w')
      }
    }
    if (c === 'perl' || c === 'ruby') {
      // only the options before the script: what follows a script file is that script's own
      let k = 0, inPlace = false
      const scripts: Word[] = []
      for (; args[k]?.t.startsWith('-'); k++) {
        inPlace ||= IN_PLACE[c]!.test(args[k]!.t)
        if (/^-[0-9a-zA-Z]*[eE]$/.test(args[k]!.t) && args[k + 1]) scripts.push(args[++k]!)
      }
      if (inPlace && scripts.length) return certain(`${c} -i`, args.slice(k).map(path), scripts.length === 1 ? substitution(scripts[0]) : undefined)
      // perl -e 'open(F, ">file")': a file opened for writing by its name
      if (c === 'perl') for (const s of scripts) for (const m of s.dyn ? [] : s.t.matchAll(PERL_OPEN)) if ((m[3] ?? m[4]) !== '-') loose.push((m[3] ?? m[4])!), (by ||= 'a perl script')
    }
    if (c === 'php') for (const s of args.filter((w, k) => args[k - 1]?.t === '-r' && !w.dyn)) for (const m of s.t.matchAll(PHP_PUT)) loose.push(m[2]!), (by ||= 'a php script')
    if ((c === 'awk' || c === 'gawk') && args.some((w, k) => w.t === 'inplace' && /^(-i|--include)$/.test(args[k - 1]?.t ?? ''))) return certain('awk -i inplace', [])
    if (c === 'ed' && args.some(w => !w.t.startsWith('-'))) return certain('ed', [path(args.at(-1)!)])
    if (c === 'ex' && opts.some(o => /^-\w*[sc]$/.test(o))) return certain('ex', [path(args.at(-1)!)])
    if (/^n?vim?$/.test(c) && (opts.some(o => /^-[eE]s$/.test(o)) || args.some((w, k) => args[k - 1]?.t === '-c' && /(^|[\s:|])(wq?|x)!?$/.test(w.t)))) return certain(c, [path(args.at(-1)!)])
    const script = inline(c, ws, seg.doc)
    // a script counts by the files it names; one it computes (a temp folder, a joined path) is not known to be anyone's
    const out = script && writes(script.lang, script.src, script.argv)?.filter(Boolean)
    if (script && out?.length) loose.push(...out), (by ||= `a ${{ py: 'python', js: c, rb: 'ruby' }[script.lang]} script`), (sub ??= substitution(undefined, script.src))
    // text echoed onto a file: only from a command that prints text, never a build's or a test run's log
    const fed = seg.doc !== undefined || (typeof first !== 'string' && EMIT.has(name(first[0])))
    if (c === 'tee' && fed) loose.push(...plain.filter(w => !w.dyn).map(w => w.t)), (by ||= 'tee')
    // sponge soaks up the pipe and writes it over its file; dd of= and truncate -s 0 write over theirs
    if (c === 'sponge' && seg.piped) loose.push(...plain.filter(w => !w.dyn).map(w => w.t)), (by ||= 'sponge')
    if (c === 'dd') for (const w of args) if (!w.dyn && /^of=./.test(w.t)) loose.push(w.t.slice(3)), (by ||= 'dd')
    if (c === 'truncate') {
      const k = args.findIndex(w => /^(-s|--size)$/.test(w.t)), zero = k < 0 ? opts.some(o => /^(-s|--size=)0$/.test(o)) : args[k + 1]?.t === '0'
      if (zero) loose.push(...args.filter((w, j) => !w.t.startsWith('-') && !w.dyn && (k < 0 || j !== k + 1)).map(w => w.t)), (by ||= 'truncate')
    }
    // ": > file", or "> file" alone, empties the file; ">>" from nothing adds nothing
    if (!seg.words.length || (seg.words.length === 1 && /^(:|true)$/.test(seg.words[0]!.t))) for (const o of seg.outs) if (!o.dyn && !o.add) loose.push(o.t), (by ||= 'a redirect')
    if (EMIT.has(c)) for (const o of seg.outs) if (!o.dyn) temp.add(o.t), loose.push(o.t), (by ||= 'a redirect')
    // … > tmp && mv tmp file: the file is what gets rewritten
    const moved = c === 'mv' ? args.filter(w => !w.t.startsWith('-')) : []
    if (moved.length === 2 && temp.has(moved[0]!.t) && !moved[1]!.dyn) loose.push(moved[1]!.t)
  }
  const paths = [...new Set(loose)].filter(p => !/^\/dev\/|\.(log|out|err)$/.test(p))
  return paths.length ? { by, certain: false, paths, ...(cd ? { cd } : {}), ...(sub && by.endsWith('script') ? { sub } : {}) } : undefined
}

/** An absolute path for `p` as the shell would resolve it from `base`: "." and ".." folded, "~" left as it is. */
export function resolve(p: string, base: string): string {
  const out: string[] = []
  for (const part of (/^[/~]/.test(p) ? p : `${base}/${p}`).split('/')) part === '..' ? out.pop() : part && part !== '.' && out.push(part)
  return (p.startsWith('~') ? '' : '/') + out.join('/')
}

/** The paths of a verdict that are spelled out and fall under one of `dirs`, absolute: the ones worth a look on disk. */
export function local(v: ShellEdit, cwd: string, dirs: readonly string[]): string[] {
  const base = v.cd ? resolve(v.cd, cwd) : cwd
  return v.paths.filter(Boolean).map(p => resolve(p, base)).filter(p => dirs.some(d => p === d || p.startsWith(`${d}/`)))
}

/**
 * Whether the verdict stands for this session: a sure rewrite unless every file it names is outside the session's
 * directories, an unsure one (redirect, tee, a script writing a named file) only onto a file that exists under them,
 * so never one in a temp folder or anywhere else outside the project.
 */
export function flagged(v: ShellEdit, cwd: string, dirs: readonly string[], isFile: (abs: string) => boolean): boolean {
  const mine = local(v, cwd, dirs)
  return v.certain ? !v.paths.length || v.paths.includes('') || mine.length > 0 : mine.some(isFile)
}

/** The one line the model reads: which call to make instead, spelled out when the command was a plain substitution. */
export function advice(v: ShellEdit, tool: string, refused: boolean): string {
  const one = v.paths.length === 1 && v.paths[0] && !v.cd ? JSON.stringify(v.paths[0]) : '<file or directory>'
  const form = v.sub ? `{path: ${one}, edits: [{find: ${JSON.stringify(v.sub.find)}, replace: ${JSON.stringify(v.sub.replace)}}]}`
    : '{path: <file or directory>, edits: [{find, replace}]} for a substitution, else IDs from read'
  return `${refused ? 'Not run: edit' : 'Next time edit'} files with ${tool}, not ${v.by}: ${form}`
}
