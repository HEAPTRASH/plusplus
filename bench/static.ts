// Replays real commits through both tool formats and counts tokens (o200k_base as a proxy tokenizer).
// usage: bun static.ts <git repo> [commits=300]
import { getEncoding } from 'js-tiktoken'
import { changed, match, render, split, sync } from '../mod/hooks/core.ts'

const enc = getEncoding('o200k_base')
const tok = (s: string) => enc.encode(s).length
const [repo = '', n = '300'] = process.argv.slice(2)
const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, ...a]).stdout.toString()

// the one span that differs between two lines, grown to word edges so find reads naturally
function inline(o: string, n: string): [string, string] | undefined {
  if (o === n) return undefined
  let p = 0, q = 0
  while (p < o.length && p < n.length && o[p] === n[p]) p++
  while (q < o.length - p && q < n.length - p && o[o.length - 1 - q] === n[n.length - 1 - q]) q++
  while (p > 0 && /\w/.test(o[p - 1]!)) p--
  while (q > 0 && /\w/.test(o[o.length - q]!)) q--
  const find = o.slice(p, o.length - q)
  if (!find.trim() || o.indexOf(find) !== o.lastIndexOf(find)) return undefined
  return [find, n.slice(p, n.length - q)]
}
const catN = (lines: string[]) => lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
const t = { readStd: 0, readAnc: 0, editStd: 0, editAnc: 0, editV2: 0, resStd: 0, resAnc: 0, hunks: 0, files: 0, ancWins: 0 }

for (const c of git('log', '--no-merges', '--format=%h', `-${n}`).trim().split('\n')) {
  for (const f of git('diff', '--name-only', '--diff-filter=M', `${c}^`, c).trim().split('\n')) {
    if (!/\.(py|md|rst|toml|cfg|txt)$/.test(f)) continue
    const oldText = git('show', `${c}^:${f}`), a = split(oldText).lines, b = split(git('show', `${c}:${f}`)).lines
    if (!a.length || a.length > 3000) continue
    const st = sync(undefined, a), m = match(a, b)

    // hunks: old range [oa, ob) became new range [na, nb)
    const hunks: [number, number, number, number][] = []
    let i = 0, j = 0
    while (j <= b.length) {
      if (j < b.length && m[j] === i) { i++, j++; continue }
      const na = j
      while (j < b.length && m[j]! < 0) j++
      const ob = j < b.length ? m[j]! : a.length
      if (i !== ob || na !== j) hunks.push([i, ob, na, j])
      if (j === b.length) break
      i = ob
    }
    if (!hunks.length) continue

    // standard Edit: one call per hunk, old_string grown by context until unique (Edit's own rule); best case for Edit
    let fileStd = 0
    for (const [oa, ob, na, nb] of hunks) {
      let lo = oa, hi = ob
      if (lo === hi) lo > 0 ? lo-- : hi++
      const s = () => a.slice(lo, hi).join('\n')
      while (oldText.split(s()).length !== 2 && (lo > 0 || hi < a.length)) lo > 0 && lo--, hi < a.length && hi++
      const newStr = [...a.slice(lo, oa), ...b.slice(na, nb), ...a.slice(ob, hi)].join('\n')
      fileStd += tok(JSON.stringify({ file_path: `/repo/${f}`, old_string: s(), new_string: newStr }))
      t.resStd += tok(`The file /repo/${f} has been updated successfully.`)
    }

    // anchored: one call per file, every hunk in it
    const edits = hunks.map(([oa, ob, na, nb]) => {
      const text = b.slice(na, nb).join('\n')
      return oa < ob ? (ob - oa === 1 ? { from: st.anchors[oa], text } : { from: st.anchors[oa], to: st.anchors[ob - 1], text })
        : oa > 0 ? { after: st.anchors[oa - 1], text } : { before: st.anchors[0], text }
    })
    const fileAnc = tok(JSON.stringify({ path: `/repo/${f}`, edits }))
    // v2: a hunk that changes one span inside each of its lines becomes {from, to?, find, replace}
    const v2 = hunks.map(([oa, ob, na, nb], k) => {
      if (ob - oa !== nb - na || oa === ob) return edits[k]
      const spans = a.slice(oa, ob).map((o, x) => inline(o, b[na + x]!))
      const s0 = spans.find(sp => sp)
      if (!s0 || spans.some(sp => sp && (sp[0] !== s0[0] || sp[1] !== s0[1]))) return edits[k]
      // every changed line swaps the same span, and no other line in range holds it
      if (a.slice(oa, ob).some((o, x) => !spans[x] && o.includes(s0[0]))) return edits[k]
      const fr = ob - oa === 1 ? { from: st.anchors[oa] } : { from: st.anchors[oa], to: st.anchors[ob - 1] }
      const alt = { ...fr, find: s0[0], replace: s0[1] }
      return tok(JSON.stringify(alt)) < tok(JSON.stringify(edits[k])) ? alt : edits[k]
    })
    t.editV2 += tok(JSON.stringify({ path: `/repo/${f}`, edits: v2 }))
    t.resAnc += tok(changed(st, sync(st, b)) || 'ok')

    t.readStd += tok(catN(a)); t.readAnc += tok(render(st))
    t.editStd += fileStd; t.editAnc += fileAnc
    t.hunks += hunks.length; t.files++; t.ancWins += +(fileAnc < fileStd)
  }
}

const pct = (x: number, y: number) => `${(((y - x) / x) * 100).toFixed(1)}%`
console.log(`${repo}: ${t.files} file edits, ${t.hunks} hunks (anchored cheaper on ${t.ancWins}/${t.files} file edits)\n`)
console.log('                       standard   anchored   change')
for (const [k, s, x] of [['read (input)', t.readStd, t.readAnc], ['edit call (output)', t.editStd, t.editAnc], ['edit call v2 (output)', t.editStd, t.editV2], ['edit result (input)', t.resStd, t.resAnc]] as const)
  console.log(`${k.padEnd(22)} ${String(s).padStart(9)} ${String(x).padStart(10)}   ${pct(s, x)}`)
// output tokens cost 5x input on current Claude pricing
const cost = (r: number, e: number, s: number) => r + s + 5 * e
console.log(`${'cost-weighted total'.padEnd(22)} ${String(cost(t.readStd, t.editStd, t.resStd)).padStart(9)} ${String(cost(t.readAnc, t.editAnc, t.resAnc)).padStart(10)}   ${pct(cost(t.readStd, t.editStd, t.resStd), cost(t.readAnc, t.editAnc, t.resAnc))}`)
