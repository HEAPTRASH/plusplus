import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { routerLayout } from './panes'
import { glyphs, tall, width } from './ui'

const run = async ($: Engine, args: string) => (await $.command.run({ command: 'router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)).text ?? ''

const PANE = {
  plugin: 'plusplus', component: 'Pane', requestId: 'router-setup',
  props: { title: 'plusplus: model router', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const

test('the router setup pane keeps each choice and the Jev key', async ($, on) => {
  const saved: Record<string, unknown> = {}
  on('store.set', (_$, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.get', (_$, e) => ({ value: saved[e.key] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'router.mode:shadow' })
    expect(saved['router.mode']).toBe('shadow')
    await ui.press({ key: 'router.floor:sonnet' })
    expect(saved['router.floor']).toBe('sonnet')
    await ui.press({ key: 'router.grader:jev' })
    expect(saved['router.grader']).toBe('jev')
    await ui.input({ key: 'jev-key', text: ' apikey_test_1234 ' })
    expect(saved['router.jevKey']).toBe('apikey_test_1234')
    expect(await ui.find({ type: 'Text', text: /ends 1234/ })).toBeDefined()
    await ui.press({ key: 'jev-forget' })
    expect(saved['router.jevKey']).toBe('')
    await ui.press({ key: 'router.mode:on' })
    await ui.unmount()
  }
})

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The engine beneath the router: a clock the test moves, a store, a small model that grades, turns that cost, and a Jev that answers late. */
function world(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on), w = { clock, status: [] as string[], jev: 'mechanical' as string | undefined, closed: [] as string[], sets: 0, opened: 0 }
  // every write of the pane's state is a redraw of it: a count that stands still is a pane at rest
  on('state.set', { plugin: 'plusplus', key: 'router' }, (_$, e, next) => (w.sets++, next(e)))
  mock.store(on)
  mock.env(on, env)
  on('ui.close', (_$, e) => (w.closed.push(e.id), { value: undefined }))
  on('ui.open', () => (w.opened++, { value: { isPlaced: true } }) as never)
  on('ui.status', (_$, e) => (e.text && w.status.push(e.text), { value: undefined }) as never)
  on('session.usage', () => ({ value: { context: { tokens: 0 } } }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'mechanical', usage: USAGE } }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  on('http.fetch', async () => {
    await clock.sleep(350)
    return { value: w.jev ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { grade: { probabilities: { [w.jev]: 0.9 } } }, usage: { input_tokens: 40, output_tokens: 2 } }) } : { status: 401, ok: false, headers: {}, text: '' } } as never
  })
  return w
}

/** One turn of the main thread on Opus: a prompt, its grading, one request. */
async function turn($: Engine, text: string, turnId: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) void _
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('the router pane at 60 columns: no line of it is wider than the pane, and every button has a hotkey', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 60 } })
    for (const t of await ui.findAll({ type: 'Text' })) if (t.props.wrap !== 'wrap') expect(width(t.text)).toBeLessThanOrEqual(60)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => b.props.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', 't', 'k', 'q'])
    expect(buttons.every(b => b.props.plain === true)).toBe(true)
    // the current choice is the one drawn with the filled dot, in bold
    expect((await ui.find({ key: 'router.mode:on' }))?.text).toBe('● on')
    expect((await ui.find({ key: 'router.mode:off' }))?.text).toBe('○ off')
    expect(await ui.find({ type: 'Text', text: 'Nothing seated yet this session.' })).toBeDefined()
    await ui.unmount()
  }
})

test('the router pane fits the rows it has: whole when they are enough, else without notes, then gaps, then orchestration\'s guidance, then rules, and every key stays', async ($, on) => {
  const w = world(on)
  await turn($, 'Rename getUser to fetchUser in src/api.ts', 't1')
  const NOTE = /^Each task goes to the cheapest model/, RULE = /^─+$/
  for (const [columns, bodyRows, notes, rules] of [[60, 40, true, true], [60, 32, true, true], [60, 28, false, true], [60, 22, false, true], [60, 18, false, false], [60, 15, false, false], [40, 28, false, true], [40, 17, false, false], [100, 18, false, false], [120, 26, false, true], [120, 30, true, true]] as const) {
    // from the second pane on, the line the last one said is still there: one row more
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows } } })
    const fits = async (what: string) => expect(`${columns}x${bodyRows} ${what}: ${Math.min(tall(await ui.drawn(), columns), bodyRows + 1)} rows`).not.toBe(`${columns}x${bodyRows} ${what}: ${bodyRows + 1} rows`)
    await fits('at rest')
    expect(`${columns}x${bodyRows} notes ${Boolean(await ui.find({ type: 'Text', text: NOTE }))}`).toBe(`${columns}x${bodyRows} notes ${notes}`)
    expect(`${columns}x${bodyRows} rules ${Boolean(await ui.find({ type: 'Text', text: RULE }))}`).toBe(`${columns}x${bodyRows} rules ${rules}`)
    // with a key saved (one more button), a test answered and a line said: the most the pane draws
    await ui.input({ key: 'jev-key', text: 'apikey_test_1234' })
    const pressed = ui.press({ key: 'jev-test' })
    await w.clock.advance(100)
    await fits('testing')
    await w.clock.advance(400)
    await pressed
    await ui.input({ key: 'jev-key', text: 'apikey_test_5678' })
    await fits('tested and said')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey).join('')).toBe('12345678tkrq')
    expect(await ui.find({ type: 'Text', text: '1 task seated' })).toBeDefined()
    await ui.press({ key: 'jev-forget' })
    await w.clock.advance(3000)
    await ui.unmount()
  }
  // more seats than rows: the busiest stay, with a line for the rest
  const seats = Array.from({ length: 9 }, (_x, i) => ({ key: `k${i}`, label: `class ${i}`, n: i + 1 }))
  const view = { w: 60, mode: 'on', floor: 'haiku', grader: 'haiku', keyTail: '', test: { phase: 'idle' }, said: '', seats, tasks: 45, effortCosts: false, orch: { agents: 0, fleet: [], orchestrating: false } } as const
  expect(routerLayout({ ...view, bodyRows: 40 })).toEqual({ notes: true, gaps: true, guide: true, orch: 'full', rules: true, seats: 9 })
  expect(routerLayout({ ...view, bodyRows: 28 })).toEqual({ notes: false, gaps: false, guide: true, orch: 'full', rules: true, seats: 9 })
  expect(routerLayout({ ...view, bodyRows: 24 })).toEqual({ notes: false, gaps: false, guide: false, orch: 'line', rules: false, seats: 9 })
  expect(routerLayout({ ...view, bodyRows: 16 })).toEqual({ notes: false, gaps: false, guide: false, orch: 'none', rules: false, seats: 3 })
})

test('where nothing draws a pane (a -p run), /router setup answers with the figures instead of "opened"', async ($, on) => {
  const w = world(on)
  on('session.surfaces', () => ({ value: [] }))
  await turn($, 'Rename getUser to fetchUser in src/api.ts', 't1')
  const text = await run($, 'setup')
  expect(text).toMatch(/^Nothing draws a pane in this run\. router on: 1 tasks seated\./)
  expect(text).toContain('mechanical -> haiku medium')
  expect(w.opened).toBe(0)
})

test('the router pane on a phone has no key field and still switches the router', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-edit' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Set the key from a terminal or the desktop app.' })).toBeDefined()
  await ui.press({ key: 'router.mode:shadow' })
  expect((await ui.find({ key: 'router.mode:shadow' }))?.text).toBe('● shadow')
  expect((await ui.find({ type: 'Text', text: '◐ shadow' }))?.props.color).toBe('warning')
  await ui.press({ key: 'router.mode:on' })
  await ui.unmount()
})

test('testing Jev spins while the request is out, then shows a tick with the time or a cross, and the timer stops', async ($, on) => {
  const w = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // with no key there is nothing to send: the pane says so and no timer starts
    await ui.press({ key: 'jev-forget' }).catch(() => undefined)
    await ui.press({ key: 'jev-test' })
    expect(await ui.find({ type: 'Text', text: /No key to test/ })).toBeDefined()
    await ui.input({ key: 'jev-key', text: 'apikey_test_1234' })
    const before = w.sets
    const pressed = ui.press({ key: 'jev-test' })
    await w.clock.advance(100)
    expect(await ui.find({ type: 'Text', text: /testing/ })).toBeDefined()
    const frames = new Set<string>()
    for (let i = 0; i < 3; i++) {
      frames.add((await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ }))?.text ?? '')
      await w.clock.advance(100)
    }
    expect(frames.size).toBe(3) // the spinner turned
    await w.clock.advance(100)
    await pressed
    expect(await ui.find({ type: 'Text', text: /Jev answered "mechanical" in \d+ ms/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '✓' }))?.props.color).toBe('success')
    // nothing moves any more: the timer has stopped, and no frame is counted however long the pane stays open
    await w.clock.advance(200)
    const idle = w.sets
    expect(idle).toBeGreaterThan(before)
    await w.clock.advance(5000)
    expect(w.sets).toBe(idle)
    w.jev = undefined
    const again = ui.press({ key: 'jev-test' })
    await w.clock.advance(400)
    await again
    expect(await ui.find({ type: 'Text', text: /Jev did not answer/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '✗' }))?.props.color).toBe('error')
    w.jev = 'mechanical'
    await w.clock.advance(2000)
    await ui.press({ key: 'jev-forget' })
    await ui.unmount()
  }
})

/** A plugin that closes a pane by its id, as the person's close mark does: `/shut <id>`. */
const CLOSER = {
  name: 'closer',
  register(on: On) {
    on('command.run', { command: 'shut' }, async ($, e) => {
      await $.ui.close({ id: e.args })
      return { text: 'closed' }
    })
  },
}

test('the dashboard follows the session: bars grow to their value, a changed figure is marked for a moment, and closing the pane ends its timer', { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on)
  await turn($, 'Rename getUser to fetchUser in src/api.ts', 't1')
  expect(w.status.at(-1)).toBe('◆ route → haiku medium · mechanical')
  expect(await run($, 'setup')).toBe('Router setup opened.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 80 } })
  const bar = async () => (await ui.findAll({ type: 'Text', text: /^[▏▎▍▌▋▊▉█]+$/ })).map(t => t.text.length)
  expect(await ui.find({ type: 'Text', text: 'mechanical → haiku medium' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 task seated' })).toBeDefined()
  const start = await bar()
  await w.clock.advance(300)
  const mid = await bar()
  await w.clock.advance(400)
  const full = await bar()
  expect(mid[0]!).toBeGreaterThan(start[0] ?? 0)
  expect(full[0]!).toBeGreaterThan(mid[0]!)
  expect(await texts(ui)).toContain('$0.01')
  // at rest: no timer, no redraw
  await w.clock.advance(2000)
  const rest = w.sets
  await w.clock.advance(5000)
  expect(w.sets).toBe(rest)
  // a second task while the pane is open: the count changes and is marked, then the mark goes
  await turn($, 'Rename fetchUser to loadUser in src/api.ts', 't2')
  await w.clock.advance(100)
  expect((await ui.find({ type: 'Text', text: '2 tasks seated' }))?.props.inverse).toBe(true)
  await w.clock.advance(2000)
  expect((await ui.find({ type: 'Text', text: '2 tasks seated' }))?.props.inverse).toBe(false)
  // closed mid-motion: the person's close cancels the timer
  await turn($, 'Rename loadUser to getUser in src/api.ts', 't3')
  await w.clock.advance(100)
  const moving = w.sets
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['router-setup'])
  await w.clock.advance(3000)
  expect(w.sets).toBe(moving)
  // and so does a close the mod did not make. The kit's `$` cannot raise the person's own (the engine's mark, Esc), so
  // another plugin's stands in for it: it reaches the same hook, with another origin
  expect(await run($, 'setup')).toBe('Router setup opened.')
  await w.clock.advance(100)
  expect(w.sets).toBeGreaterThan(moving)
  const open = w.sets
  await $.command.run({ command: 'shut', args: 'router-setup', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(w.closed).toEqual(['router-setup', 'router-setup'])
  await w.clock.advance(3000)
  expect(w.sets).toBe(open)
  await ui.unmount()
})

/** The /config rows about workflows as the engine lists them, and a set that changes one as the person's own change would: `rows` is what the menu holds. */
function settings(on: On, rows: { key: string; kind: string; value: unknown; isLocked?: boolean }[]) {
  const c = { rows, lists: 0, sets: [] as string[] }
  on('config.list', () => (c.lists++, { value: c.rows.map(r => ({ label: r.key, provider: { plugin: 'engine', tier: 'core' }, isLocked: false, ...r })) }) as never)
  on('config.set', (_$, e) => {
    const row = c.rows.find(r => r.key === e.key)
    c.sets.push(`${e.key}=${e.value}`)
    if (!row || row.isLocked) return { deny: 'a managed setting holds it' }
    row.value = e.value
    return { value: e.value }
  })
  return c
}
const FLOWS = (on: boolean, isLocked = false) => [{ key: 'theme', kind: 'choice', value: 'dark' }, { key: 'workflows', kind: 'boolean', value: on, isLocked }, { key: 'workflowKeywordTriggerEnabled', kind: 'boolean', value: true }, { key: 'workflowSizeGuideline', kind: 'choice', value: 'medium' }]

test('orchestration: the workflow settings are read as the pane opens, a press switches workflows on, and the agents seated are counted by model', async ($, on) => {
  const w = world(on), c = settings(on, [])
  on('agent.spawn', (_$, e) => ({ model: e.parentModel, agentId: `a${e.prompt.length}` }) as never)
  await turn($, 'Rename getUser to fetchUser in src/api.ts', 't1')
  for (const surface of ['terminal', 'desktop'] as const) {
    c.rows = FLOWS(false)
    const lists = c.lists
    expect(await run($, 'setup')).toBe('Router setup opened.')
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 32 } } })
    expect((await ui.find({ type: 'Text', text: '○ workflows off' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: '● ultracode keyword on' }))?.props.color).toBe('success')
    expect(await texts(ui)).toEqual(expect.arrayContaining(['size medium', 'effort high']))
    expect((await ui.find({ key: 'flows-on' }))?.props.hotkey).toBe('w')
    expect(await ui.find({ type: 'Text', text: /^Routing saves most on fan-out work\. Switch dynamic workflows on, then put the word ultracode in a prompt/ })).toBeDefined()
    // the rows were read once, for the opening: the frames the growing bars draw read nothing
    await w.clock.advance(3000)
    expect(c.lists).toBe(lists + 1)
    await ui.press({ key: 'flows-on' })
    expect(c.sets.at(-1)).toBe('workflows=true')
    expect(c.lists).toBe(lists + 2)
    expect((await ui.find({ type: 'Text', text: '● workflows on' }))?.props.color).toBe('success')
    expect(await ui.find({ key: 'flows-on' })).toBeUndefined()
    if (surface === 'terminal') {
      // on, and no agent routed yet: how to start fan-out
      expect(await ui.find({ type: 'Text', text: 'Routing saves most on fan-out work: put the word ultracode in a prompt, or ask for a workflow.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'agents routed this session: 0' })).toBeDefined()
      // two agents of the main thread, each seated by its own task
      for (const prompt of ['Rename a to b in src/x.ts', 'Rename a to b in src/yy.ts']) {
        const { agentId } = await $.agent.spawn({ prompt, description: 'rename', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
        for await (const _ of $.turn.step({ turnId: 't1', agentId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) void _
      }
      await w.clock.advance(100)
    }
    expect((await ui.find({ type: 'Text', text: 'agents routed this session: 2' }))?.props.inverse).toBe(surface === 'terminal')
    expect(await ui.find({ type: 'Text', text: '· haiku 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Routing saves most/ })).toBeUndefined()
    await w.clock.advance(3000)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(await run($, '')).toContain('agents routed this session: 2 (haiku 2)')
  // a managed setting holds workflows off: no button, and the guidance says why
  c.rows = FLOWS(false, true)
  await run($, 'setup')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 32 } } })
  expect(await ui.find({ type: 'Text', text: '○ workflows off, locked' })).toBeDefined()
  expect(await ui.find({ key: 'flows-on' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /a managed setting holds them/ })).toBeDefined()
  await ui.press({ key: 'close' })
  await ui.unmount()
})

test('orchestration fits the rows it has: whole, then without its guidance, then as one line that keeps the button, then gone', async ($, on) => {
  world(on)
  const c = settings(on, FLOWS(false))
  for (const [columns, bodyRows, chips, guide, line, button] of [[80, 32, true, true, false, true], [60, 19, true, false, false, true], [40, 17, false, false, true, true], [60, 10, false, false, false, false]] as const) {
    c.rows = FLOWS(false)
    await run($, 'setup')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows } } })
    const at = `${columns}x${bodyRows}`
    expect(`${at}: ${Math.min(tall(await ui.drawn(), columns), bodyRows + 1)} rows`).not.toBe(`${at}: ${bodyRows + 1} rows`)
    expect(`${at} chips ${Boolean(await ui.find({ type: 'Text', text: '● ultracode keyword on' }))}`).toBe(`${at} chips ${chips}`)
    expect(`${at} guide ${Boolean(await ui.find({ type: 'Text', text: /^Routing saves most/ }))}`).toBe(`${at} guide ${guide}`)
    expect(`${at} line ${Boolean(await ui.find({ type: 'Text', text: '○ workflows off · 0 agents' }))}`).toBe(`${at} line ${line}`)
    expect(`${at} button ${Boolean(await ui.find({ key: 'flows-on' }))}`).toBe(`${at} button ${button}`)
    for (const t of await ui.findAll({ type: 'Text' })) if (t.props.wrap !== 'wrap') expect(width(t.text)).toBeLessThanOrEqual(columns)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
})

test('ASCII icons where the setting or the locale asks for them', { options: { icons: 'ascii' } }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'router.mode:on' }))?.text).toBe('* on')
  for (const t of await ui.findAll({ type: 'Text' })) expect(t.text).toMatch(/^[\x20-\x7e]*$/)
  await ui.unmount()
  expect(glyphs('auto', 'terminal', [undefined, undefined, 'C', 'xterm']).ok).toBe('+')
  expect(glyphs('auto', 'terminal', [undefined, undefined, 'en_US.UTF-8', 'xterm-256color']).ok).toBe('✓')
  expect(glyphs('auto', 'desktop', [undefined, undefined, 'C', 'dumb']).ok).toBe('✓')
})
