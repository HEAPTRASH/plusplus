import type { Color, Elements, RenderElement, UiPressArgument } from 'claude-code'

// The mod's one look: what every pane, toast and status line draws with. Pure: the helpers take the surface's element
// table and plain values, never `$`. A pane is character cells, so an icon is a glyph and motion is a frame number the
// caller counts on a timer. Colours are the engine's theme keys, so they follow the person's theme.

/** The elements every surface draws: all the helpers here need. */
export type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>
export type Press = (e: UiPressArgument) => void

/** The props that are set: one left undefined is not handed to an element at all. */
const set = <T extends object>(props: T) => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as T

/** Every glyph the mod draws, each one cell wide in a terminal font (no emoji, nothing a font draws double). */
export type Glyphs = typeof UNICODE
export const UNICODE = {
  brand: '◆', ok: '✓', fail: '✗', warn: '!', on: '●', off: '○', half: '◐', sel: '❯', open: '▾', shut: '▸',
  up: '↑', down: '↓', to: '→', dot: '·', rule: '─', more: '…',
  spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  /** A bar's last cell by how full it is, then a full cell; and the cell of the track behind it. */
  blocks: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'], track: '░',
  area: '■', spec: '§', decision: '◇',
  accepted: '✓', proposed: '○', superseded: '⇢', dropped: '✗', stale: '!',
}
/** The same in ASCII, for a terminal whose locale is not UTF-8. */
export const ASCII: Glyphs = {
  brand: '*', ok: '+', fail: 'x', warn: '!', on: '*', off: 'o', half: '~', sel: '>', open: 'v', shut: '>',
  up: '^', down: 'v', to: '->', dot: '|', rule: '-', more: '..',
  spin: ['|', '/', '-', '\\'],
  blocks: ['#'], track: '.',
  area: 'A', spec: 'S', decision: 'D',
  accepted: '+', proposed: '?', superseded: '>', dropped: 'x', stale: '!',
}

/**
 * The glyph set for a surface: the `icons` setting when it names one, else ASCII only for a terminal whose locale is
 * set and is not UTF-8, or whose TERM is one that draws few glyphs. Another surface is a page: Unicode. `env` is the
 * values of LC_ALL, LC_CTYPE, LANG and TERM, in that order, which the caller reads (nothing here holds `$`).
 */
export function glyphs(setting: string | undefined, surface: string, env: readonly (string | undefined)[] = []): Glyphs {
  if (setting === 'ascii') return ASCII
  if (setting === 'unicode' || surface !== 'terminal') return UNICODE
  const [all, ctype, lang, term] = env, locale = all || ctype || lang || ''
  return (locale && !/utf-?8/i.test(locale)) || term === 'dumb' || term === 'linux' ? ASCII : UNICODE
}

const NARROW = /^[\x20-\x7e]*$/, ZERO = /\p{Mn}|‍|️/u
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud83c-\ud83e][\udc00-\udfff]/

/** Cells a text takes. ponytail: East Asian wide ranges and emoji count two, combining marks none; no full width table. */
export function width(s: string): number {
  if (NARROW.test(s)) return s.length
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : ZERO.test(ch) ? 0 : 1
  return n
}

/** The text in at most `max` cells, on one line: cut short it ends in `more`. */
export function cut(s: string, max: number, more = '…'): string {
  s = s.replace(/\s+/g, ' ')
  if (width(s) <= max) return s
  let out = '', n = width(more)
  if (n >= max) return more.slice(0, Math.max(max, 0))
  for (const ch of s) {
    const w = width(ch)
    if (n + w > max) break
    ;(out += ch), (n += w)
  }
  return out.trimEnd() + more
}

/** The text padded with spaces to `n` cells, on the right, or on the left with `start`. */
export const pad = (s: string, n: number, start = false) => (start ? ' '.repeat(Math.max(n - width(s), 0)) + s : s + ' '.repeat(Math.max(n - width(s), 0)))

/** The text as lines of at most `w` cells, broken at spaces, at most `max` of them: the last then ends in `more`. */
export function wrap(text: string, w: number, max: number, more = '…'): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    // ponytail: a word longer than a line (a path) is split by code units, wherever the line ends
    for (const word of para.split(/\s+/).filter(Boolean).flatMap(x => x.match(new RegExp(`.{1,${Math.max(w, 1)}}`, 'gu')) ?? [])) {
      if (line && width(line) + 1 + width(word) > w) out.push(line), (line = word)
      else line = line ? `${line} ${word}` : word
    }
    if (line) out.push(line)
  }
  return out.length > max ? [...out.slice(0, max - 1), cut(`${out[max - 1]} ${out[max]}`, w, more)] : out
}

/** The rows a row of items takes when it wraps: each item's cells, `gap` cells between two on a row, `w` cells across. */
export function flow(items: readonly number[], gap: number, w: number): number {
  let rows = 0, used = -1
  for (const n of items) {
    if (used >= 0 && used + gap + n <= w) used += gap + n
    else rows++, (used = n)
  }
  return rows
}

/** The cells a plain Button takes in a terminal: "k: label", or the label alone without a hotkey. */
export const keyed = (label: string, hotkey?: string) => (hotkey ? width(hotkey) + 2 : 0) + width(label)

type Drawn = { type?: string; props?: Record<string, unknown>; children?: readonly unknown[] } | string | null | undefined | false

/**
 * The rows a drawn tree takes in a terminal `w` cells wide, counted as the panes' layouts count them: what the tests
 * hold each pane's row budget to. ponytail: a Button and a field are one row, and text wraps only where it says so.
 */
export function tall(el: unknown, w: number): number {
  const d = el as Drawn
  if (!d) return 0
  if (typeof d === 'string') return d ? 1 : 0
  const p = d.props ?? {}, kids = d.children ?? [], text = (x: Drawn): string => (typeof x === 'string' ? x : x ? (x.children ?? []).map(k => text(k as Drawn)).join('') : '')
  if (d.type === 'Text') return !text(d) ? 0 : p.wrap === 'wrap' ? wrap(text(d), w, 999).length : 1
  if (d.type !== 'Box') return 1
  const room = (typeof p.width === 'number' ? Math.min(p.width, w) : w) - Number(p.paddingLeft ?? 0), top = Number(p.marginTop ?? 0)
  const cells = (x: Drawn): number => (!x || typeof x === 'string' ? width(x || '') : x.type === 'Button' ? keyed(String(x.props?.label ?? ''), x.props?.plain ? (x.props.hotkey as string | undefined) : undefined)
    : x.type === 'Box' ? (x.children ?? []).reduce<number>((n, k, i) => n + cells(k as Drawn) + (i ? Number(x.props?.columnGap ?? 0) : 0), 0) : width(text(x)))
  if (p.flexDirection === 'column') return top + kids.reduce<number>((n, k) => n + tall(k, room), 0)
  const shown = kids.filter(k => tall(k, room) > 0)
  return top + (p.flexWrap === 'wrap' ? flow(shown.map(k => cells(k as Drawn)), Number(p.columnGap ?? 0), room) : Math.max(0, ...shown.map(k => tall(k, room))))
}

/** A count in three figures: 950, 3.1k, 12k, 1.2M. */
export const num = (n: number) => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`)
export const money = (n: number) => `$${n.toFixed(2)}`

/** Where a value on its way from `a` to `b` stands at progress `p` (0 to 1): fast first, then settling. */
export const glide = (a: number, b: number, p: number) => a + (b - a) * (1 - (1 - Math.min(Math.max(p, 0), 1)) ** 3)

/** The spinner's glyph at a frame. */
export const spin = (g: Glyphs, frame: number) => g.spin[Math.abs(frame) % g.spin.length]!

/** A bar of `cells` cells filled to `frac` (0 to 1): the filled part, in eighths of a cell where the glyphs allow, and the track left. */
export function bar(g: Glyphs, frac: number, cells: number): [fill: string, rest: string] {
  const steps = g.blocks.length, n = Math.round(Math.min(Math.max(frac || 0, 0), 1) * cells * steps)
  const full = Math.floor(n / steps), part = n % steps
  return [g.blocks.at(-1)!.repeat(full) + (part ? g.blocks[part - 1] : ''), g.track.repeat(cells - full - (part ? 1 : 0))]
}

/** A bar drawn: the filled part in `color`, the track dim. */
export function meter(ui: Kit, g: Glyphs, frac: number, cells: number, color: Color = 'suggestion'): RenderElement {
  const { Box, Text } = ui, [fill, rest] = bar(g, frac, Math.max(cells, 1))
  return (
    <Box flexDirection="row">
      {fill ? <Text color={color}>{fill}</Text> : null}
      {rest ? <Text dimColor>{rest}</Text> : null}
    </Box>
  )
}

/** How a thing stands, for `mark`: done well, failed, wants attention, running, or nothing to say. */
export type Tone = 'ok' | 'fail' | 'warn' | 'run' | 'off'
const TONES: Record<Tone, Color | undefined> = { ok: 'success', fail: 'error', warn: 'warning', run: 'suggestion', off: undefined }

/** A status glyph in its colour: a tick, a cross, a bang, the spinner at `frame`, or a hollow dot. */
export function mark(ui: Kit, g: Glyphs, tone: Tone, frame = 0): RenderElement {
  const glyph = { ok: g.ok, fail: g.fail, warn: g.warn, run: spin(g, frame), off: g.off }[tone]
  return <ui.Text {...set({ color: TONES[tone] })} dimColor={tone === 'off'} bold={tone !== 'off'}>{glyph}</ui.Text>
}

/** A status glyph and its line, the line cut to `w` cells. */
export function status(ui: Kit, g: Glyphs, tone: Tone, text: string, w: number, frame = 0): RenderElement {
  return (
    <ui.Box flexDirection="row" columnGap={1}>
      {mark(ui, g, tone, frame)}
      <ui.Text dimColor={tone === 'off'} wrap="truncate-end">{cut(text, w - 2, g.more)}</ui.Text>
    </ui.Box>
  )
}

/** A value that is drawn inverted for a moment after it changed. */
export const figure = (ui: Kit, text: string, hot: boolean, color?: Color): RenderElement => <ui.Text inverse={hot} bold={hot} {...set({ color })}>{text}</ui.Text>

/** A pane's first line: the mod's mark, the pane's name, what it is about (dim, cut to fit), and a chip at the right edge. */
export function header(ui: Kit, g: Glyphs, o: { title: string; sub?: string; chip?: string; tone?: Tone; w: number }): RenderElement {
  const { Box, Text } = ui, chip = o.chip ?? '', room = o.w - width(g.brand) - 1 - width(o.title) - (chip ? width(chip) + 2 : 0) - 3
  return (
    <Box flexDirection="row" justifyContent="space-between" width={o.w}>
      <Box flexDirection="row">
        <Text color="claude" bold>{g.brand} </Text>
        <Text bold>{o.title}</Text>
        {o.sub && room > 4 ? <Text dimColor>{` ${g.dot} ${cut(o.sub, room, g.more)}`}</Text> : null}
      </Box>
      {chip ? <Text {...set({ color: TONES[o.tone ?? 'off'] })} dimColor={!o.tone || o.tone === 'off'}>{chip}</Text> : null}
    </Box>
  )
}

/** A section's label on a rule that runs to the pane's edge, a blank row above it unless the pane is short of rows. */
export function section(ui: Kit, g: Glyphs, label: string, w: number, gap = true): RenderElement {
  return (
    <ui.Box flexDirection="row" marginTop={gap ? 1 : 0}>
      <ui.Text bold color="subtle">{label} </ui.Text>
      <ui.Text dimColor>{g.rule.repeat(Math.max(w - width(label) - 2, 0))}</ui.Text>
    </ui.Box>
  )
}

/**
 * One choice of several on a row: each option a Button under its own hotkey, the current one a filled dot in bold
 * colour and the rest hollow, with a dim note under the row for what the current one means.
 */
export function choice<T extends string>(ui: Kit, g: Glyphs, o: { label: string; id: string; now: T; all: readonly T[]; keys?: string; pick: (v: T) => Press; note?: string }): RenderElement {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text>{pad(o.label, 6)}</Text>
        {o.all.map((v, i) => (
          <Button key={`${o.id}:${v}`} plain {...set({ hotkey: o.keys?.[i] })} onPress={o.pick(v)}>
            {v === o.now ? [<Text bold color="success">{`${g.on} ${v}`}</Text>] : [<Text dimColor>{`${g.off} `}</Text>, v]}
          </Button>
        ))}
      </Box>
      {o.note ? <Box paddingLeft={8}><Text dimColor wrap="wrap">{o.note}</Text></Box> : null}
    </Box>
  )
}

/** One key the pane answers to: its Button's address, the key, what it does, whether it is the main or a destructive one, and whether the focus starts on it. */
export type Hint = { id: string; hotkey?: string; label: string; press: Press; tone?: 'main' | 'danger'; focus?: true }

/** The keys a pane answers to, as a row of Buttons that wraps: "j: down", the key in the accent colour. */
export function hints(ui: Kit, items: readonly (Hint | undefined | false)[]): RenderElement {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="row" columnGap={3} flexWrap="wrap">
      {items.filter((x): x is Hint => Boolean(x)).map(x => (
        <Button key={x.id} plain {...set({ hotkey: x.hotkey, autoFocus: x.focus })} onPress={x.press}>
          {x.tone ? <Text bold color={x.tone === 'main' ? 'suggestion' : 'error'}>{x.label}</Text> : x.label}
        </Button>
      ))}
    </Box>
  )
}

/** A toast's or the status line's text: a glyph for how it went, then the words. The engine heads a toast with the mod's name. */
export const say = (g: Glyphs, tone: Tone | 'down' | 'to', text: string) => `${{ ok: g.ok, fail: g.fail, warn: g.warn, run: g.dot, off: g.off, down: g.down, to: g.to }[tone]} ${text}`
