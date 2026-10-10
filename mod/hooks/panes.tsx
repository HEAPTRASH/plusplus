import type { Color, Elements, RenderElement } from 'claude-code'
import type { PlusPlusRouter, PlusPlusSetup } from '../types'
import { type Glyphs, type Hint, type Kit, type Press, type Tone, choice, cut, figure, flow, glide, header, hints, keyed, mark, meter, money, num, pad, section, status, width, wrap } from './ui'

// The mod's three panes as drawings: each takes the surface's elements, what to show and what its keys do, and holds
// no state. The hooks that own the state (routing.tsx, specs.ts, register.tsx) call these and nothing else draws.

/** A surface's elements as a pane needs them: a phone draws no text field. */
export type Table = Kit & { Input?: Elements['terminal']['Input'] }

/**
 * The table a pane draws with on a surface. A phone's table still answers `Input` (with an element that draws nothing),
 * so the surface is what says there is no field.
 */
export const tableOf = (ui: Kit & { Input?: unknown }, surface: string): Table => (surface === 'mobile' ? { Box: ui.Box, Text: ui.Text, Button: ui.Button } : (ui as Table))

/** How many frames a bar takes to reach its value, and how many a changed value stays marked; a frame is `FRAME` ms. */
export const GROW = 6, HOT = 14, FRAME = 100

// ---- the model router ----

export type Seated = { key: string; label: string; n: number }
/**
 * Fan-out as the pane can know it: the /config rows about dynamic workflows as last read (a field is absent where
 * there is no such row), the session's effort as the main thread's last request showed it, the agents seated this
 * session with their split by model, and whether the main thread has run a workflow.
 */
export type Fanout = { on?: boolean; locked?: boolean; keyword?: boolean; size?: string; effort?: string; agents: number; fleet: readonly { model: string; n: number }[]; orchestrating: boolean }
export type RouterView = {
  g: Glyphs; w: number; frame: number
  /** The rows the pane has room for: short of them it draws without notes, gaps and rules, in that order. */
  bodyRows: number
  mode: 'on' | 'shadow' | 'off'; floor: 'haiku' | 'sonnet' | 'opus'; grader: 'haiku' | 'jev'
  /** The last four characters of the saved key, '' with none. */
  keyTail: string
  test: PlusPlusRouter['test']; said: string
  seats: Seated[]; tasks: number; spent: number; unrouted: number
  graded: { asked: number; input: number; output: number }; effortCosts: boolean
  orch: Fanout
  /** The figures as they stood before the last change, how far the bars have grown from them (0 to 1), and whether the change is still marked. */
  from: Record<string, number>; grown: number; hot: boolean
}
export type RouterActs = { pick: (key: string, value: string) => Press; test: Press; forget: Press; edit: Press; save: (value: string) => void; flows: Press; close: Press }

const MODES = { on: 'Each task goes to the cheapest model and effort trusted with it, never above your own.', shadow: 'Decides and reports what it would do; changes nothing.', off: 'Every request goes out as you set it.' }
const FLOORS = { haiku: 'Mechanical work may go to Haiku.', sonnet: 'Nothing goes below Sonnet.', opus: 'Nothing goes below Opus.' }
const GRADERS = {
  haiku: 'Tasks are graded by the session\'s own small model. Nothing leaves your provider.',
  jev: 'Tasks are graded by TypeSafe\'s Jev: each task\'s text is sent to api.typesafe.ai. Haiku grades when Jev does not answer.',
}

const CHOICES = { mode: ['on', 'shadow', 'off'], floor: ['haiku', 'sonnet', 'opus'], grader: ['haiku', 'jev'] } as const
const ROUTER_KEYS = [['t', 'test Jev'], ['k', 'type a key'], ['r', 'remove key']] as const
const FLOWS_KEY = ['w', 'switch on'] as const

/**
 * The orchestration section's parts: its row of chips (a setting with its dot, a plain value, or the button that
 * switches workflows on, offered only while they are off and nothing locks them), and its one line of guidance:
 * shown while workflows are off or no agent has been routed, '' once fan-out is under way.
 */
function fanout(o: Fanout): { chips: ({ text: string; on?: boolean } | 'switch')[]; guide: string } {
  const start = o.keyword === false ? 'ask for a workflow (the ultracode keyword is off)' : 'put the word ultracode in a prompt, or ask for a workflow'
  return {
    chips: [
      ...(o.on === undefined ? [] : [{ text: `workflows ${o.on ? 'on' : o.locked ? 'off, locked' : 'off'}`, on: o.on }]),
      ...(o.on === false && !o.locked ? ['switch' as const] : []),
      ...(o.keyword === undefined ? [] : [{ text: `ultracode keyword ${o.keyword ? 'on' : 'off'}`, on: o.keyword }]),
      ...(o.size ? [{ text: `size ${o.size}` }] : []),
      ...(o.effort ? [{ text: `effort ${o.effort}` }] : []),
    ],
    guide: o.on === false ? (o.locked ? 'Routing saves most on fan-out work, and dynamic workflows are off here: a managed setting holds them.' : `Routing saves most on fan-out work. Switch dynamic workflows on, then ${start}.`)
      : o.agents || o.orchestrating ? '' : `Routing saves most on fan-out work: ${start}.`,
  }
}

/**
 * How the router pane fits the rows it has: whole when they are enough; else without the notes under the choices, then
 * without the blank rows, then without the guidance under orchestration, then with orchestration as one line, then
 * without the section rules, then without orchestration, and at last with only the busiest seats (`seats` of them).
 * ponytail: rows are counted as a terminal draws them, the key field as one row.
 */
export function routerLayout(v: Pick<RouterView, 'w' | 'bodyRows' | 'mode' | 'floor' | 'grader' | 'keyTail' | 'test' | 'said' | 'seats' | 'tasks' | 'effortCosts' | 'orch'>, field = true): { notes: boolean; gaps: boolean; guide: boolean; orch: 'full' | 'line' | 'none'; rules: boolean; seats: number } {
  const { w } = v, row = (all: readonly string[]) => flow([6, ...all.map(x => 5 + width(x))], 2, w), note = (text: string) => wrap(text, w - 8, 99).length
  const keys = ROUTER_KEYS.filter(([k]) => (k !== 'k' || field) && (k !== 'r' || v.keyTail !== '')).map(([k, label]) => keyed(label, k))
  const choices = row(CHOICES.mode) + row(CHOICES.floor) + row(CHOICES.grader), notes = note(MODES[v.mode]) + note(FLOORS[v.floor]) + note(GRADERS[v.grader])
  // the header, the choices, the key's line, its field and its keys, what the test and the pane last said, the figures, the grading line, close
  const base = 1 + choices + 2 + flow(keys, 3, w) + (v.test.phase === 'idle' ? 0 : 1) + (v.said ? 1 : 0) + (v.tasks ? 3 : 1) + 1 + (v.effortCosts ? 1 : 0) + 1
  const fan = fanout(v.orch), chips = flow(fan.chips.map(c => (c === 'switch' ? keyed(FLOWS_KEY[1], FLOWS_KEY[0]) : (c.on === undefined ? 0 : 2) + width(c.text))), 2, w)
  const fit: ReturnType<typeof routerLayout> = { notes: true, gaps: true, guide: fan.guide !== '', orch: 'full', rules: true, seats: v.tasks ? v.seats.length : 0 }
  // orchestration: its chips and the agents' line, or one line of both; its rule and the blank row above that; its guidance
  const orch = () => (fit.orch === 'full' ? chips + 1 : fit.orch === 'line' ? 1 : 0), own = () => (fit.orch === 'none' ? 0 : 1)
  const over = () => base + fit.seats + orch() + (fit.notes ? notes : 0) + (fit.gaps ? 4 + own() : 0) + (fit.guide ? wrap(fan.guide, w, 99).length : 0) + (fit.rules ? 3 + own() : 0) - v.bodyRows
  if (over() > 0) fit.notes = false
  if (over() > 0) fit.gaps = false
  if (over() > 0) fit.guide = false
  if (over() > 0) fit.orch = 'line'
  if (over() > 0) fit.rules = false
  if (over() > 0) fit.orch = 'none'
  // a seat left out makes room for itself and for the line that says how many were
  if (over() > 0) fit.seats = Math.max(fit.seats - over() - 1, 1)
  return fit
}

/** The router pane: its three choices, the Jev key with its test, this session's figures as bars, and where fan-out stands. */
export function routerPane(ui: Table, v: RouterView, act: RouterActs): RenderElement {
  const { Box, Text, Button, Input } = ui, { g, w } = v, fit = routerLayout(v, Boolean(Input)), o = v.orch, fan = fanout(o)
  const flip = <Button key="flows-on" plain hotkey={FLOWS_KEY[0]} onPress={act.flows}><Text bold color="suggestion">{FLOWS_KEY[1]}</Text></Button>
  const routed = `agents routed this session: ${o.agents}`, split = [...o.fleet.map(x => `${x.model} ${x.n}`), ...(o.orchestrating ? ['a workflow has run'] : [])].join(` ${g.dot} `)
  // one line of it, short enough at 40 columns to stand beside the button
  const canFlip = fan.chips.includes('switch'), brief = `${o.on === undefined ? '' : `${o.on ? g.on : g.off} workflows ${o.on ? 'on' : 'off'} ${g.dot} `}${o.agents} agent${o.agents === 1 ? '' : 's'}${canFlip ? '' : ' routed'}`
  const orch = fit.orch === 'full' ? (
    <Box flexDirection="column">
      {fan.chips.length ? (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {fan.chips.map(c => (c === 'switch' ? flip : c.on === undefined ? <Text dimColor>{cut(c.text, w, g.more)}</Text> : <Text color={c.on ? 'success' : 'warning'}>{`${c.on ? g.on : g.off} ${c.text}`}</Text>))}
        </Box>
      ) : null}
      <Box flexDirection="row" columnGap={1}>
        {figure(ui, routed, v.hot && (v.from.agents ?? 0) !== o.agents)}
        {split && w - width(routed) > 8 ? <Text dimColor>{cut(`${g.dot} ${split}`, w - width(routed) - 1, g.more)}</Text> : null}
      </Box>
    </Box>
  ) : fit.orch === 'line' ? (
    <Box flexDirection="row" columnGap={2}>
      <Text>{cut(brief, w - (canFlip ? keyed(FLOWS_KEY[1], FLOWS_KEY[0]) + 2 : 0), g.more)}</Text>
      {canFlip ? flip : null}
    </Box>
  ) : null
  const rule = (label: string) => (fit.rules ? section(ui, g, label, w, fit.gaps) : null), note = (text: string) => (fit.notes ? text : undefined)
  const seats = fit.seats < v.seats.length ? [...v.seats].sort((a, b) => b.n - a.n).slice(0, fit.seats) : v.seats, unseen = v.seats.length - seats.length
  const now = (k: string, to: number) => glide(v.from[k] ?? 0, to, v.grown), hot = (k: string, to: number) => v.hot && (v.from[k] ?? 0) !== to
  const chip = { on: `${g.on} on`, shadow: `${g.half} shadow`, off: `${g.off} off` }[v.mode], tone: Tone = v.mode === 'on' ? 'ok' : v.mode === 'shadow' ? 'warn' : 'off'
  const labels = Math.min(Math.max(...v.seats.map(s => width(s.label)), 8), Math.max(w - 20, 8)), cells = Math.min(Math.max(w - labels - 8, 6), 28)
  const most = Math.max(...v.seats.map(s => s.n), 1), dear = Math.max(v.unrouted, v.spent, 0.0001)
  const row = (label: string, frac: number, value: string, isHot: boolean, color?: Color) => (
    <Box flexDirection="row" columnGap={1}>
      <Text>{pad(cut(label, labels, g.more), labels)}</Text>
      {meter(ui, g, frac, cells, color)}
      {figure(ui, value, isHot)}
    </Box>
  )
  const saved = v.unrouted > 0 && v.spent < v.unrouted ? Math.round((1 - v.spent / v.unrouted) * 100) : 0, seated = `${v.tasks} task${v.tasks === 1 ? '' : 's'} seated`
  const tested = v.test.phase === 'running' ? status(ui, g, 'run', `testing${g.more}`, w, v.frame)
    : v.test.phase === 'ok' ? status(ui, g, 'ok', `Jev answered "${v.test.cls}" in ${v.test.ms} ms`, w)
    : v.test.phase === 'fail' ? status(ui, g, 'fail', 'Jev did not answer: check the key and the network', w) : null
  return (
    <Box flexDirection="column" width={w}>
      {header(ui, g, { title: 'Model router', sub: `floor ${v.floor}, graded by ${v.grader}`, chip, tone, w })}
      {rule('Settings')}
      {choice(ui, g, { label: 'Mode', id: 'router.mode', now: v.mode, all: CHOICES.mode, keys: '123', pick: x => act.pick('router.mode', x), note: note(MODES[v.mode]) })}
      {choice(ui, g, { label: 'Floor', id: 'router.floor', now: v.floor, all: CHOICES.floor, keys: '456', pick: x => act.pick('router.floor', x), note: note(FLOORS[v.floor]) })}
      {choice(ui, g, { label: 'Grader', id: 'router.grader', now: v.grader, all: CHOICES.grader, keys: '78', pick: x => act.pick('router.grader', x), note: note(GRADERS[v.grader]) })}
      {rule('Jev key')}
      {v.keyTail ? status(ui, g, 'ok', `saved, ends ${v.keyTail}`, w) : status(ui, g, 'off', 'none saved: TYPESAFE_API_KEY from the environment is used when set', w)}
      {Input ? <Input key="jev-key" placeholder="paste a TypeSafe API key and press enter" submitLabel="save" onSubmit={act.save} /> : <Text dimColor>Set the key from a terminal or the desktop app.</Text>}
      {hints(ui, [{ id: 'jev-test', hotkey: ROUTER_KEYS[0][0], label: ROUTER_KEYS[0][1], press: act.test, tone: 'main' }, Input && { id: 'jev-edit', hotkey: ROUTER_KEYS[1][0], label: ROUTER_KEYS[1][1], press: act.edit }, v.keyTail !== '' && { id: 'jev-forget', hotkey: ROUTER_KEYS[2][0], label: ROUTER_KEYS[2][1], press: act.forget, tone: 'danger' }])}
      {tested}
      {v.said ? <Text dimColor wrap="truncate-end">{cut(v.said, w, g.more)}</Text> : null}
      {rule('This session')}
      {v.tasks ? (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {figure(ui, seated, hot('tasks', v.tasks))}
            {saved ? <Text color="success">{cut(`${g.dot} ${saved}% under your own model at list price`, w - width(seated) - 1, g.more)}</Text> : null}
          </Box>
          {seats.map(s => row(s.label, now(s.key, s.n) / most, String(s.n), hot(s.key, s.n)))}
          {unseen ? <Text dimColor>{cut(`${g.more} ${unseen} more seat${unseen === 1 ? '' : 's'}: /router lists them all`, w, g.more)}</Text> : null}
          {row(v.mode === 'shadow' ? 'if routed' : 'routed', now('spent', v.spent) / dear, money(v.spent), hot('spent', v.spent), 'success')}
          {row('unrouted', now('unrouted', v.unrouted) / dear, money(v.unrouted), hot('unrouted', v.unrouted), 'inactive')}
        </Box>
      ) : <Text dimColor>{v.mode === 'off' ? 'The router is off: nothing is seated.' : 'Nothing seated yet this session.'}</Text>}
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>grading</Text>
        {figure(ui, `${v.graded.asked} call${v.graded.asked === 1 ? '' : 's'}`, hot('asked', v.graded.asked))}
        <Text dimColor>{cut(`to ${v.grader} ${g.dot} ${num(v.graded.input)} in ${g.dot} ${num(v.graded.output)} out`, w - 26, g.more)}</Text>
      </Box>
      {v.effortCosts ? status(ui, g, 'warn', 'effort is left alone: changing it rewrote the cache', w) : null}
      {orch ? rule('Orchestration') : null}
      {orch}
      {orch && fit.guide ? <Text dimColor wrap="wrap">{fan.guide}</Text> : null}
      <Box marginTop={fit.gaps ? 1 : 0}>{hints(ui, [{ id: 'close', hotkey: 'q', label: 'close', press: act.close }])}</Box>
    </Box>
  )
}

// ---- the spec browser ----

export type SpecRow = { id: string; short: string; depth: number; kind: 'area' | 'spec' | 'decision'; status: 'proposed' | 'accepted' | 'superseded' | 'dropped' | 'stale'; title: string; kids: number; open: boolean }
export type SpecDetail = Omit<SpecRow, 'depth' | 'kids' | 'open'> & { why: string; refs: string[]; by: string; via: string; day: string; under: string; history: string[] }
export type SpecsView = {
  g: Glyphs; w: number; bodyRows: number; frame: number
  /** The store is still being read; or why it could not be. */
  loading: boolean
  failed?: string
  counts: { live: number; proposed: number; stale: number }
  /** The rows in the window, the index of the first among all `total`, and the record selected. */
  lines: SpecRow[]; top: number; total: number; sel: string
  filter: string; typed: boolean
  detail?: SpecDetail
  /** The record just accepted or dropped, while it is still marked. */
  flash: string
  busy: string; said: string
}
export type SpecsActs = { select: (id: string) => Press; move: (by: number) => Press; fold: (open: boolean) => Press; filter: (text: string) => void; edit: Press; clear: Press; decide: (status: 'accepted' | 'dropped') => Press; close: Press }

const STANDING: Record<SpecRow['status'], Color> = { accepted: 'success', proposed: 'suggestion', stale: 'warning', superseded: 'inactive', dropped: 'error' }

const LEGEND = { kinds: ['area', 'spec', 'decision'], states: ['accepted', 'proposed', 'stale', 'superseded'] } as const
/** Every key the browser can show at once, for the rows they take: the filter's "clear" stands in for fold and unfold, and is shorter. */
const SPEC_KEYS = { down: 'j', up: 'k', 'next page': 'n', previous: 'p', unfold: 'l', fold: 'h', filter: 'f', accept: 'a', drop: 'd', close: 'q' }

/**
 * How the browser divides its pane: the detail beside the list from 100 columns, beneath it under that, and as many
 * list rows as the pane's height leaves (to 40) once every other row is counted: the header, the filter, the legend
 * and the keys as they wrap at this width, the line beneath them, and under 100 columns the record (`detail` rows of
 * it). A pane short of rows gives up the legend, then the record's why, refs and history, before the list goes under
 * five rows. The hook windows the store by it and the drawing lays out by it.
 * ponytail: rows are counted as a terminal draws them, the filter field as one row; under 13 rows something is cut.
 */
export function specsLayout(w: number, bodyRows: number): { wide: boolean; rows: number; listW: number; detailW: number; detail: number; legend: boolean } {
  const wide = w >= 100, listW = wide ? Math.floor(w * 0.52) : w
  const keys = flow(Object.entries(SPEC_KEYS).map(([label, key]) => keyed(label, key)), 3, w), marks = 1 + flow([...LEGEND.kinds, ...LEGEND.states].map(x => 2 + width(x)), 2, w)
  let legend = true, detail = 10
  const left = () => bodyRows - 3 - keys - (legend ? marks : 0) - (wide ? 0 : 2 + detail)
  if (left() < 5) legend = false
  if (!wide && left() < 5) detail = Math.max(detail - (5 - left()), 3)
  const rows = Math.min(Math.max(left(), wide ? 5 : 3), 40)
  return { wide, rows, listW, detailW: wide ? w - listW - 3 : w, detail: wide ? rows : detail, legend }
}

/** The spec browser: the window of the tree, the filter, the selected record in full, and the keys. */
export function specsPane(ui: Table, v: SpecsView, act: SpecsActs): RenderElement {
  const { Box, Text, Button, Input } = ui, { g, w } = v, at = specsLayout(w, v.bodyRows), flat = v.filter !== ''
  const line = (r: SpecRow) => {
    const isSel = r.id === v.sel, dent = flat ? '' : '  '.repeat(Math.min(r.depth, 6)), twist = flat ? '' : `${r.kids ? (r.open ? g.open : g.shut) : ' '} `
    const tail = `${r.kids && !r.open ? ` +${r.kids}` : ''} ${r.short}`
    const room = Math.max(at.listW - 2 - width(dent) - width(twist) - 4 - width(tail), 8)
    return (
      <Button key={`row:${r.id}`} plain onPress={act.select(r.id)}>
        {isSel ? <Text color="claude" bold>{`${g.sel} `}</Text> : '  '}
        {dent + twist}
        <Text bold={r.kind === 'area'} color={r.kind === 'area' ? 'text' : 'subtle'}>{`${g[r.kind]} `}</Text>
        <Text color={STANDING[r.status]} bold inverse={r.id === v.flash}>{g[r.status]}</Text>
        {isSel ? <Text bold color="suggestion">{` ${cut(r.title || '(no title)', room, g.more)}`}</Text> : ` ${cut(r.title || '(no title)', room, g.more)}`}
        <Text dimColor>{tail}</Text>
      </Button>
    )
  }
  // the record in the rows it has: its title, standing and author always; then its history, its refs, and the why in what is left
  const d = v.detail, dw = at.detailW, title = d ? wrap(d.title || '(no title)', dw, at.wide ? 3 : 1, g.more) : [], room = Math.max(at.detail - title.length - 2, 0)
  const past = d ? d.history.slice(0, Math.min(at.wide ? 5 : 3, Math.max(room - 2, 0))) : []
  const refs = d?.refs.length ? wrap(`refs ${d.refs.join('  ')}`, dw, at.wide ? 3 : 1, g.more).slice(0, Math.max(room - past.length - 1, 0)) : []
  const deep = Math.min(room - past.length - refs.length, at.wide ? 40 : 3)
  const detail = d ? (
    <Box flexDirection="column" width={dw}>
      {title.map(l => <Text bold>{l}</Text>)}
      <Box flexDirection="row" columnGap={1}>
        <Text color={STANDING[d.status]} bold inverse={d.id === v.flash}>{`${g[d.status]} ${d.status}`}</Text>
        <Text dimColor>{cut(`${g[d.kind]} ${d.kind} ${g.dot} ${d.short}${d.under ? ` ${g.dot} under ${d.under}` : ''}`, dw - width(d.status) - 3, g.more)}</Text>
      </Box>
      <Text dimColor>{cut(`${d.day} ${g.dot} ${d.by} via ${d.via}`, dw, g.more)}</Text>
      {deep < 1 ? null : d.why ? wrap(d.why, dw, deep, g.more).map(l => <Text>{l}</Text>) : <Text dimColor>no why recorded</Text>}
      {refs.map(l => <Text color="subtle">{l}</Text>)}
      {past.map((l, i) => <Text dimColor>{cut(`${i ? ' ' : g.up} ${l}`, dw, g.more)}</Text>)}
    </Box>
  ) : <Text dimColor>{v.total ? 'No record selected.' : ''}</Text>
  const pick = d && !v.busy, key = (id: string, label: keyof typeof SPEC_KEYS, press: Press): Hint => ({ id, hotkey: SPEC_KEYS[label], label, press })
  const keys: (Hint | undefined | false)[] = [
    key('down', 'down', act.move(1)), key('up', 'up', act.move(-1)), key('page-down', 'next page', act.move(at.rows)), key('page-up', 'previous', act.move(-at.rows)),
    !flat && key('unfold', 'unfold', act.fold(true)), !flat && key('fold', 'fold', act.fold(false)),
    Input && key('filter-edit', 'filter', act.edit), flat && { id: 'filter-clear', hotkey: 'c', label: 'clear filter', press: act.clear },
    pick && d.status !== 'accepted' && d.status !== 'superseded' && { ...key('accept', 'accept', act.decide('accepted')), tone: 'main' },
    pick && { ...key('drop', 'drop', act.decide('dropped')), tone: 'danger' },
    key('close', 'close', act.close),
  ]
  const c = v.counts, last = Math.min(v.top + v.lines.length, v.total)
  return (
    <Box flexDirection="column" width={w}>
      {header(ui, g, { title: 'Specs', sub: `${num(c.live)} record${c.live === 1 ? '' : 's'}, ${num(c.proposed)} proposed, ${num(c.stale)} stale`, chip: v.total ? `${v.top + 1}${g.rule}${last} of ${v.total}` : '', w })}
      <Box flexDirection="row" columnGap={2}>
        {Input ? <Input key="filter" placeholder="filter: words of a title, an id, a ref, a status" submitLabel="filter" {...(v.typed ? {} : { value: v.filter })} onInput={act.filter} onSubmit={act.filter} /> : <Text dimColor>Filter from a terminal or the desktop app.</Text>}
        {flat ? <Text color="suggestion">{cut(`"${v.filter}" ${g.dot} ${v.total} match${v.total === 1 ? '' : 'es'}`, 30, g.more)}</Text> : null}
      </Box>
      {v.failed ? status(ui, g, 'fail', v.failed, w) : v.loading ? status(ui, g, 'run', `reading the store${g.more}`, w, v.frame) : (
        <Box flexDirection={at.wide ? 'row' : 'column'} columnGap={3}>
          <Box flexDirection="column" width={at.listW}>
            {v.lines.length ? v.lines.map(line) : <Text dimColor>{flat ? 'No record matches.' : 'No records yet: agents add them with the spec tool.'}</Text>}
          </Box>
          {at.wide ? detail : <Box flexDirection="column">{section(ui, g, 'Record', w)}{detail}</Box>}
        </Box>
      )}
      {at.legend ? (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
          {LEGEND.kinds.map(k => <Text dimColor>{`${g[k]} ${k}`}</Text>)}
          {LEGEND.states.map(s => <Text color={STANDING[s]}>{`${g[s]} ${s}`}</Text>)}
        </Box>
      ) : null}
      {hints(ui, keys)}
      {v.busy ? status(ui, g, 'run', `${v.busy}${g.more}`, w, v.frame) : v.said ? <Text dimColor>{cut(v.said, w, g.more)}</Text> : null}
    </Box>
  )
}

// ---- the code graph's setup ----

export type SetupView = { g: Glyphs; w: number; about: { version: string; size: string; dir: string; source: string }; state: PlusPlusSetup }
export type SetupActs = { yes: Press; later: Press; never: Press; hide: Press }

const mb = (n: number) => (n / (1 << 20)).toFixed(1)

/** The code-graph dialog: the question before anything is downloaded, then the download as a bar, then how it ended. */
export function setupPane(ui: Table, v: SetupView, act: SetupActs): RenderElement {
  const { Box, Text } = ui, { g, w, about: a, state: s } = v, cells = Math.min(Math.max(w - 34, 8), 40)
  const head = header(ui, g, { title: 'Code graph setup', chip: `CodeGraph ${a.version}`, w })
  if (s.phase === 'ask')
    return (
      <Box flexDirection="column" width={w}>
        {head}
        <Text wrap="wrap">The code graph needs CodeGraph {a.version}, from {a.source}.</Text>
        <Text dimColor>{cut(`${g.down} ${a.size} into ${a.dir}`, w, g.more)}</Text>
        {status(ui, g, 'ok', 'checked against a pinned SHA-256', w)}
        {status(ui, g, 'ok', 'telemetry off for the calls this mod makes', w)}
        {status(ui, g, 'off', 'no project is indexed unless you run codegraph init there', w)}
        <Box marginTop={1}>
          {hints(ui, [{ id: 'yes', hotkey: 'd', label: 'Download', press: act.yes, tone: 'main', focus: true }, { id: 'later', hotkey: 'n', label: 'Not now', press: act.later }, { id: 'never', hotkey: 'x', label: 'Never', press: act.never }])}
        </Box>
      </Box>
    )
  const frac = s.phase === 'download' ? (s.of ? s.got / s.of : 0) : 1
  const what = s.phase === 'download' ? (s.of ? `${mb(s.got)} / ${mb(s.of)} MB  ${Math.round(frac * 100)}%` : `${mb(s.got)} MB`) : s.phase === 'verify' ? 'checking the SHA-256' : 'unpacking'
  return (
    <Box flexDirection="column" width={w}>
      {head}
      {s.phase === 'done' ? status(ui, g, 'ok', `CodeGraph ${a.version} installed in ${a.dir}`, w)
        : s.phase === 'failed' ? status(ui, g, 'fail', s.error || 'the install failed', w)
        : (
          <Box flexDirection="row" columnGap={1}>
            {s.phase === 'download' && s.of ? <Text color="suggestion" bold>{g.down}</Text> : mark(ui, g, 'run', s.frame)}
            {meter(ui, g, frac, cells, s.phase === 'download' ? 'suggestion' : 'success')}
            <Text>{what}</Text>
          </Box>
        )}
      {hints(ui, s.phase === 'failed' ? [{ id: 'yes', hotkey: 'r', label: 'try again', press: act.yes, tone: 'main' }, { id: 'hide', hotkey: 'c', label: 'close', press: act.hide }]
        : s.phase === 'done' ? [{ id: 'hide', hotkey: 'c', label: 'close', press: act.hide }]
        : [{ id: 'hide', hotkey: 'h', label: 'hide (the download goes on)', press: act.hide }])}
    </Box>
  )
}
