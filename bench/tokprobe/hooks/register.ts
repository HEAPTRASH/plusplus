// /tokprobe <model> <out.json> <sample N, 0 = all> [files...]: counts tokens with the real Claude tokenizer
// (input_tokens of a 1-token completion), since Claude's tokenizer is not public.
import type { EngineInterface, Register } from 'claude-code'
import { WORDS } from './words'

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

async function tok($: EngineInterface, model: string, prompt: string): Promise<number> {
  const r = await $.model.complete({ model, prompt, maxTokens: 1 })
  if (!r.usage) throw new Error(`no usage: ${JSON.stringify(r)}`)
  return r.usage.input_tokens
}

// extra tokens the words cost over single-token "A", split down until each word is known
async function extra($: EngineInterface, model: string, ws: string[], out: Record<string, number>): Promise<void> {
  const body = (f: (w: string) => string) => 'Ok\n' + ws.map(w => f(w) + '§x = 1').join('\n')
  const [t, ref] = await Promise.all([tok($, model, body(w => w)), tok($, model, body(() => 'A'))])
  const d = t - ref
  if (d === 0 || ws.length === 1) return void ws.forEach(w => (out[w] = ws.length === 1 ? d : 0))
  const half = ws.length >> 1
  await extra($, model, ws.slice(0, half), out)
  await extra($, model, ws.slice(half), out)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokprobe', description: 'Count Claude tokens of anchor words and read formats' })
    return next(e)
  })

  on('command.run', { command: 'tokprobe' }, async ($, e) => {
    const [model = 'claude-opus-5-5', outPath = 'tokprobe.json', sample = '0', ...files] = e.args.trim().split(/\s+/)
    // sample=N probes every (len/N)-th word only, for a quick estimate
    const pick = sample === 'fmt' ? [] : Number(sample) ? WORDS.filter((_, i) => i % Math.ceil(WORDS.length / Number(sample)) === 0) : WORDS
    const words: Record<string, number> = {}
    const batches = []
    for (let i = 0; i < pick.length; i += 16) batches.push(pick.slice(i, i + 16))
    for (let i = 0; i < batches.length; i += 8) // ponytail: 8 batches at a time, gentle on rate limits
      await Promise.all(batches.slice(i, i + 8).map(b => extra($, model, b, words)))

    if (sample.startsWith('items:')) { // per-item cost at line start, before the delimiter
      const items = sample.slice(6).split(',')
      const base = await tok($, model, 'Ok\n§x = 1\n§y = 2')
      const cost: Record<string, number> = {}
      for (let i = 0; i < items.length; i += 16)
        await Promise.all(items.slice(i, i + 16).map(async x => {
          cost[x] = ((await tok($, model, `Ok\n${x}§x = 1\n${x}§y = 2`)) - base) / 2
        }))
      await $.fs.write(outPath, JSON.stringify(cost, null, 1))
      return { text: JSON.stringify(cost) }
    }
    const formats: Record<string, Record<string, number>> = {}
    const W = (i: number) => WORDS[(i * 1013) % WORDS.length]!
    for (const f of files) {
      const lines = (await $.fs.read(f)).replace(/\n$/, '').split('\n')
      const pre = (p: (i: number) => string) => lines.map((l, i) => p(i) + l).join('\n')
      const L = lines.length, from = L + Math.max(L, 100) + 1 // same scheme as the mod's fresh()
      let st = Math.max(1, Math.floor(L * 0.618))
      while (gcd(st, L) !== 1) st++
      const fmt: Record<string, string> = {
        raw: lines.join('\n'),
        'Read (cat -n)': pre(i => `${String(i + 1).padStart(6)}\t`),
        'Word§ (v1-v3)': pre(i => `${W(i)}§`),
        'ID§ (v4)': pre(i => `${from + ((i * st) % L)}§`),
        'no indent': lines.map(l => l.trimStart()).join('\n'),
        'tabs': lines.map(l => l.replace(/^( {4})+/, m => '\t'.repeat(m.length / 4))).join('\n'),
      }
      const raw = await tok($, model, fmt.raw!)
      formats[f] = Object.fromEntries(await Promise.all(Object.entries(fmt).map(async ([k, s]) =>
        [k, k === 'raw' ? raw : +(((await tok($, model, s)) - raw) / lines.length).toFixed(2)])))
    }
    const single = Object.values(words).filter(x => x === 0).length
    await $.fs.write(outPath, JSON.stringify({ model, single, total: pick.length, words, formats }, null, 1))
    return { text: `${model}: ${single}/${pick.length} sampled anchor words are single tokens; extra tokens per line by format\n${JSON.stringify(formats, null, 1)}` }
  })
}
