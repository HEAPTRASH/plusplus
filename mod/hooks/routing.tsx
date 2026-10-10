import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { PlusPlusRouter as Pane } from '../types'
import { FRAME, GROW, HOT, routerPane, tableOf } from './panes'
import { type Class, type Effort, type Model, type Routed, type Usage, CLASSES, CRITERIA, EFFORTS, IDS, MODELS, QUESTION, RUBRIC, ask, bill, family, guess, harder, insists, label, likely, overrun, route, strained, verdict } from './router'
import { glyphs } from './ui'

export type RouterOptions = { router?: string; routerFloor?: string; routerLog?: string; routerGrader?: string; icons?: string }

/** A task's class and what decided it: the classifier, the wording, or a rule that keeps it on its thread's own seat. */
type Grade = { cls: Class; by: string }

/** One model loop the router seats: the main thread, or a subagent from its spawn on. */
type Thread = {
  /** The grade of the task it is on; resolves, never rejects. */
  grade: Promise<Grade>
  /** How the task opens, for the report. */
  task: string
  /** Edits that failed in a row. */
  strain: number
  /** It started agents this turn: an orchestrator, kept on its own seat. */
  spawned: boolean
  /** Its model was somebody's choice (the call's, the agent definition's, the engine's fallback): left alone. */
  pinModel: boolean
  /** Its effort was somebody's choice: left alone. */
  pinEffort: boolean
  /** What the engine itself would send for it, as its last request showed: the seat it never exceeds. */
  own?: { model: string; effort?: Effort }
  /** Whose effort it inherited, for a subagent: a different one of its own was chosen for it. */
  parent?: Thread
  /** The seat its task was given. */
  seat?: Routed
  /** The model it is on; none before its first request. */
  on?: Model
  /** The effort its last request went out with, and whether that was a change. */
  sent?: { effort?: Effort; moved: boolean }
}

const thread = (grade: Promise<Grade>, task: string, from?: Partial<Thread>): Thread =>
  ({ grade, task: task.replace(/\s+/g, ' ').slice(0, 80), strain: 0, spawned: false, pinModel: false, pinEffort: false, ...from })
const own = (by: string) => Promise.resolve<Grade>({ cls: 'hard', by })

// ponytail: module memory, so a reload forgets which model the conversation is on; it is then taken to be on its own
let mode: 'on' | 'shadow' | 'off' = 'on', grader: 'haiku' | 'jev' = 'haiku', floor: Model = 'haiku'
/** The key for Jev the person gave in the setup pane; without one, TYPESAFE_API_KEY from the environment is used. */
let jevKey = ''
/** A run that logs its routes is a measurement: the options alone decide it, and what the pane saved is left out. */
let fixed = false
const SETUP = 'router-setup'
/** What the pane draws from beside this module's figures, kept by the host: a reload loses none of it. */
const pane = atom({ plugin: 'plusplus', key: 'router' } as const, { frame: 0, at: -HOT, from: {}, test: { phase: 'idle' }, said: '' })
/** The pane's one timer, alive only while something on it moves; a test request in flight; the pane is open. */
let ticker: { cancel: () => void } | undefined, testing = false, watching = false
/**
 * The /config rows about dynamic workflows, as read for the pane that is open (a field is absent where there is no
 * such row), and the reading of them: one as the pane opens and one after a press, never one per frame. Module memory,
 * since a drawing may not write state: a reload reads them again.
 */
let flows: { on?: boolean; locked?: boolean; keyword?: boolean; size?: string } = {}, surveyed: Promise<void> | undefined
/** The effort the main thread's last request showed: the session's. */
let sessionEffort: string | undefined
/** The figures the bars last set out for: where the next change starts from. */
let seen: Record<string, number> = {}

let locale: Promise<(string | undefined)[]> | undefined
/** The glyphs for a surface: the icons setting, else what the terminal's locale can draw. */
const icons = ($: EngineInterface, opts: RouterOptions, surface = 'terminal') =>
  (locale ??= Promise.all([$.env.get('LC_ALL'), $.env.get('LC_CTYPE'), $.env.get('LANG'), $.env.get('TERM')]).catch(() => [])).then(v => glyphs(opts.icons, surface, v))

let loaded: Promise<void> | undefined
/**
 * What the person chose in the setup pane, kept across sessions in the plugin's store, over the plugin's options.
 * ponytail: the store is a plain JSON file under the user's Claude Code folder, so the Jev key sits there unencrypted;
 * the environment variable is the route for a machine where that will not do.
 */
const ready = ($: EngineInterface) =>
  (loaded ??= (async () => {
    if (fixed) return
    const [m, f, g, k] = await Promise.all(['router.mode', 'router.floor', 'router.grader', 'router.jevKey'].map(key => $.store.get(key)))
    if (m === 'on' || m === 'shadow' || m === 'off') mode = m
    if (f === 'haiku' || f === 'sonnet' || f === 'opus') floor = f
    if (g === 'haiku' || g === 'jev') grader = g
    if (typeof k === 'string') jevKey = k
  })().catch(() => undefined))
let main = thread(own('nothing graded yet'), '')
const agents = new Map<string, Thread>()
/** Spawns whose agent has not been given its id yet: a first request can beat the spawn's own answer. */
const starting = new Set<Promise<unknown>>()
/** The main thread's agents still running: while any is out, it is an orchestrator. */
const out = new Set<string>()
/** The main thread has run a workflow: the session is orchestrating, and stays on the person's own seat. */
let orchestrating = false
/** Where a prompt comes from when it is a task in its own right: the person, an SDK host, a schedule. */
const TASKS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])
/** Such prompts, submitted and not yet started as a turn. */
const asked = new Set<string>()
/** The last such prompt and the answer the main thread gave last: what `/router redo` repeats, and what a bare "do it" is about. */
let last = '', answer = '', redo = false
const grades = new Map<string, Promise<Grade>>()
const routes: (Routed & { who: string; task: string; by: string })[] = []
/** List-price dollars of every seated thread's requests, and of the same tokens on the thread's own model. */
const ledger = { spent: 0, unrouted: 0 }
/** What grading has cost: the session's own ledger does not count a plugin's completions. */
const graded = { asked: 0, input: 0, output: 0 }
/** An effort change was seen to rewrite the cache here (an older model, another provider): effort is left alone from then on. */
let effortCosts = false, rewrites = 0
let ids: Promise<Record<Model, string>> | undefined
/** The id each family's requests name: the CLI's own alias overrides where set, else today's. */
const resolve = ($: EngineInterface) =>
  (ids ??= (async () => ({
    haiku: (await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')) || IDS.haiku,
    sonnet: (await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')) || IDS.sonnet,
    opus: (await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')) || IDS.opus,
    fable: IDS.fable,
  }))())

const answers = new Map<Model, Promise<boolean>>()
/** Whether a family's id is one the API knows, asked once a session with a one-token request: a stale id must never reach a turn. */
function usable($: EngineInterface, m: Model): Promise<boolean> {
  let known = answers.get(m)
  if (!known) {
    known = (async () => {
      const r = await $.model.complete({ model: (await resolve($))[m], prompt: 'ok', maxTokens: 1, timeoutMs: 10_000 })
      return r.isAnswered || r.reason === 'empty-reply' // any refusal or silence: not a model to send a turn to
    })().catch(() => false)
    answers.set(m, known)
  }
  return known
}

/**
 * The class of a task: the harder of two short completions on the small model, which disagree with themselves on
 * about one prompt in four; from the wording alone when neither answers.
 */
function grade($: EngineInterface, text: string, before = ''): Promise<Grade> {
  const prompt = ask(text, before)
  let g = grades.get(prompt)
  if (!g) {
    g = (async () => {
      // three seconds for Jev, then the small model: a grader that hangs must not hold a turn
      const scored = grader === 'jev' ? await Promise.race([jev($, prompt), $.clock.sleep(3000).then(() => undefined)]).catch(() => undefined) : undefined
      if (scored) return { cls: scored, by: 'jev' }
      const one = () => $.model.complete({ model: 'haiku', system: RUBRIC, prompt, maxTokens: 32, effort: 'low', timeoutMs: 5000 }).catch(() => undefined)
      const said: Class[] = []
      for (const r of await Promise.all([one(), one()])) {
        if (!r) continue
        graded.asked += 1, graded.input += r.usage.input_tokens, graded.output += r.usage.output_tokens
        const cls = r.isAnswered ? label(r.text) : undefined
        if (cls) said.push(cls)
      }
      return said.length ? { cls: said.reduce(harder), by: 'classifier' } : { cls: guess(text), by: 'wording' }
    })()
    grades.set(prompt, g)
    if (grades.size > 500) grades.delete(grades.keys().next().value!)
  }
  return g
}

/**
 * The class Jev gives a task: one request to TypeSafe's System One API, which answers with a probability per class.
 * Needs a key, from the setup pane or TYPESAFE_API_KEY in the environment; undefined (and the small model grades instead) without it or on any failure.
 */
async function jev($: EngineInterface, state: string): Promise<Class | undefined> {
  const key = jevKey || (await $.env.get('TYPESAFE_API_KEY'))
  if (!key) return undefined
  const r = await $.http.fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions: { grade: { type: 'choice', instructions: QUESTION, criteria: CRITERIA } } }),
  })
  if (!r.ok) return undefined
  const got = JSON.parse(r.text) as { answers?: { grade?: { probabilities?: Partial<Record<Class, number>> } }; usage?: { input_tokens?: number; output_tokens?: number } }
  graded.asked += 1, graded.input += got.usage?.input_tokens ?? 0, graded.output += got.usage?.output_tokens ?? 0
  return likely(got.answers?.grade?.probabilities ?? {})
}

/** The model and effort a request goes out with, or undefined to leave it as the engine has it. */
async function seat($: EngineInterface, opts: RouterOptions, e: { model: string; effort?: string | number; agentId?: string; index: number }) {
  const mine = family(e.model)
  if (!mine) return undefined
  const isMain = e.agentId === undefined
  let t = isMain ? main : agents.get(e.agentId!)
  if (!t && starting.size) {
    await Promise.allSettled([...starting])
    t = agents.get(e.agentId!)
  }
  if (!t) return undefined // a loop nobody announced (compaction, memory): the engine's own
  const effort = EFFORTS.find(x => x === e.effort)
  // the engine changed the model under a running turn: its fallback, which a rewrite would undo
  if (t.own && t.own.model !== e.model) t.pinModel = true
  // its own seat moved under it (a fallback, /model, /effort): the seat it held was cut to the old one
  if (t.own && (t.own.model !== e.model || t.own.effort !== effort)) t.seat = undefined
  // an effort other than the one its spawner runs at was chosen for it
  if (!t.own && t.parent?.own && t.parent.own.effort !== effort) t.pinEffort = true
  t.own = { model: e.model, effort }
  if (t.pinModel || t.pinEffort) return undefined // a thread someone chose a seat for is left whole
  const ceiling = { model: mine, effort }, g = await t.grade, cls = t.spawned ? 'hard' : g.cls
  if (t.seat?.cls !== cls) {
    // a conversation already under way, on a model this module did not put it on: it is on its own
    if (isMain && t.on === undefined && (await $.session.usage()).context.tokens) t.on = mine
    t.seat = route(cls, ceiling, floor, t.on)
    if (t.seat.model !== mine && !(await usable($, t.seat.model))) t.seat = { ...t.seat, model: mine }
    routes.push({ who: e.agentId ?? 'main', task: t.task, by: t.spawned ? 'it started agents' : g.by, ...t.seat })
    if (routes.length > 1000) routes.shift()
    if (isMain) {
      const { model, effort } = t.seat
      void icons($, opts).then(g => $.ui.status(`${g.brand} route ${g.to} ${model}${effort ? ` ${effort}` : ''} ${g.dot} ${cls}`)).catch(() => undefined)
    }
  }
  // a task still going long past its class's size was graded too low
  const now = overrun(cls, e.index) ? { ...ceiling, cls } : strained(t.seat, ceiling, t.strain)
  t.on = now.model
  const sends = effort && now.effort && !t.pinEffort && !effortCosts ? now.effort : effort
  t.sent = { effort: sends, moved: t.sent !== undefined && t.sent.effort !== sends }
  return { model: now.model === mine ? e.model : (await resolve($))[now.model], ...(sends ? { effort: sends } : {}) }
}

/** Books what a request cost, and reads from it whether the effort change before it rewrote the cache. */
function settle(e: { model: string; agentId?: string }, usage: (Usage & { model: string }) | null) {
  const t = e.agentId === undefined ? main : agents.get(e.agentId), mine = family(e.model), used = usage && family(usage.model)
  if (!t?.seat || !usage || !mine || !used) return
  // a subagent's cache entries live five minutes, the main thread's an hour: 1.25 and 2 times the input price
  const write = e.agentId === undefined ? 2 : 1.25
  // in shadow nothing was moved: price the seat it would have had
  ledger.spent += bill(usage, mode === 'shadow' ? t.seat.model : used, write)
  ledger.unrouted += bill(usage, mine, write)
  const prompt = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  if (t.sent?.moved && used === mine && prompt > 20_000 && (usage.cache_read_input_tokens ?? 0) < prompt / 2) effortCosts = ++rewrites >= 2 // once may be an entry that lapsed
}

/** This session's routing in figures: the tasks seated per class and seat, list-price dollars with and without routing, and what grading cost. */
export function figures() {
  const by = new Map<string, { key: string; cls: Class; seat: string; n: number }>()
  for (const r of routes) {
    const seat = `${r.model}${r.effort ? ` ${r.effort}` : ''}`, key = `${r.cls}>${seat}`
    by.set(key, { key, cls: r.cls, seat, n: (by.get(key)?.n ?? 0) + 1 })
  }
  const seats = [...by.values()].sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls) || (a.seat < b.seat ? -1 : 1))
  // fan-out: the agents seated (every route that is not the main thread's), by the model each was put on
  const sent = routes.filter(r => r.who !== 'main'), fleet = MODELS.map(model => ({ model, n: sent.filter(r => r.model === model).length })).filter(x => x.n)
  return { mode, floor, grader, keyTail: jevKey.slice(-4), tasks: routes.length, seats, spent: ledger.spent, unrouted: ledger.unrouted, graded: { ...graded }, effortCosts, orch: { effort: sessionEffort, agents: sent.length, fleet, orchestrating } }
}

/** The figures a bar or a count is drawn from, by name. */
function flat(): Record<string, number> {
  const f = figures()
  return { tasks: f.tasks, spent: f.spent, unrouted: f.unrouted, asked: f.graded.asked, agents: f.orch.agents, ...Object.fromEntries(f.seats.map(s => [s.key, s.n])) }
}

const still = () => (ticker?.cancel(), (ticker = undefined))
/** The pane is closing: its timer ends, the session's figures are no longer followed, and the next one reads the settings again. */
const rest = () => (still(), (watching = false), (surveyed = undefined))
/** Reads the /config rows about dynamic workflows. A hook cannot read whether Ultracode is standing on for the session; these rows say whether it can be. */
const survey = ($: EngineInterface) =>
  (surveyed = (async () => {
    const rows = await $.config.list(), row = (key: string) => rows.find(r => r.key === key)
    const on = row('workflows'), keyword = row('workflowKeywordTriggerEnabled')?.value, size = row('workflowSizeGuideline')?.value
    flows = { ...(typeof on?.value === 'boolean' ? { on: on.value, locked: on.isLocked } : {}), ...(typeof keyword === 'boolean' ? { keyword } : {}), ...(typeof size === 'string' ? { size } : {}) }
  })().catch(() => undefined))
/** Counts the pane's frames while something moves (a test in flight, bars growing, a changed value still marked), and stops by itself. */
function animate($: EngineInterface) {
  ticker ??= $.clock.every(FRAME, () => void update($, pane, s => ({ ...s, frame: s.frame + 1 })).then(s => void (!testing && s.frame - s.at >= HOT && still()), still))
}
/** Sets the bars off from where they stood (from nothing, as the pane opens) toward the figures as they are now. */
async function moved($: EngineInterface, from = seen) {
  seen = flat()
  await update($, pane, s => ({ ...s, from, at: s.frame }))
  animate($)
}

function summary(): string {
  if (!routes.length) return `router ${mode}: nothing seated yet this session`
  const by = new Map<string, number>(), line = (r: (typeof routes)[number]) => `${r.cls} -> ${r.model}${r.effort ? ` ${r.effort}` : ''}`
  for (const r of routes) by.set(line(r), (by.get(line(r)) ?? 0) + 1)
  const { agents, fleet } = figures().orch
  return [
    `router ${mode}: ${routes.length} tasks seated. Their requests cost $${ledger.spent.toFixed(2)} at list price; the same tokens on each thread's own model, $${ledger.unrouted.toFixed(2)}.`,
    `agents routed this session: ${agents}${agents ? ` (${fleet.map(x => `${x.model} ${x.n}`).join(', ')})` : ''}`,
    ...[...by].map(([key, n]) => `${String(n).padStart(4)}  ${key}`),
    'latest:',
    ...routes.slice(-5).map(r => `  ${r.who === 'main' ? 'main ' : 'agent'}  ${line(r)}  (${r.by})  ${r.task}`),
    `grading: ${graded.asked} requests to ${grader}, ${graded.input} tokens in and ${graded.output} out, outside the session's cost`,
    ...(effortCosts ? ['effort is left alone: changing it was seen to rewrite the cache on this model'] : []),
    '/router setup opens the settings; /router on | shadow | off switches it; /router redo asks the last prompt again on your own model and effort',
  ].join('\n')
}

/**
 * Routes every model request by the complexity of the task it belongs to: the main thread's turns, and each subagent
 * and workflow agent by its own task.
 */
export function routing(on: On, opts: RouterOptions) {
  mode = opts.router === 'off' || opts.router === 'shadow' ? opts.router : 'on'
  grader = opts.routerGrader === 'jev' ? 'jev' : 'haiku'
  floor = MODELS.find(m => m === opts.routerFloor) ?? 'haiku'
  fixed = Boolean(opts.routerLog)

  // /router is registered at the session's start, in register.tsx: `$` is not followed across an import
  on('command.run', { command: 'router' }, async ($, e) => {
    await ready($)
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'shadow' || arg === 'off') {
      await $.store.set('router.mode', (mode = arg))
      return { text: `router ${mode}` }
    }
    if (arg === 'setup') {
      surveyed = undefined // the pane opens: its first drawing reads the settings
      // a -p run draws nowhere, yet says every pane is placed: there the figures are the answer
      if (!(await $.session.surfaces().catch(() => ['terminal'])).length) return { text: `Nothing draws a pane in this run. ${summary()}` }
      const opened = await $.ui.open({ id: SETUP, title: 'plusplus: model router', focus: true, closeOnEscape: true, rows: 32 })
      if (opened.isPlaced) await moved($, {}).catch(() => undefined)
      return { text: opened.isPlaced ? 'Router setup opened.' : `No room to draw the setup here. ${summary()}` }
    }
    if (arg !== 'redo') return { text: summary() }
    if (!last) return { text: 'no prompt to ask again yet' }
    redo = true
    void $.prompt.submit({ text: last })
    return { text: 'asked again, on your own model and effort' }
  })

  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    await ready($)
    watching = true
    await (surveyed ?? survey($))
    const ui = $.ui.resolve(e), s = await read($, pane), g = await icons($, opts, e.surface), f = figures()
    const say = (said: string, phase: 'idle' | 'fail' = 'idle') => update($, pane, v => ({ ...v, said, test: { phase } }))
    return routerPane(tableOf(ui, e.surface), {
      // the floor is one of the three a person can choose: the options offer no other
      ...f, g, w: Math.max(e.props.bodyColumns, 40), bodyRows: e.props.scroll.bodyRows, frame: s.frame, floor: f.floor === 'fable' ? 'opus' : f.floor, said: s.said,
      seats: f.seats.map(x => ({ key: x.key, label: `${x.cls} ${g.to} ${x.seat}`, n: x.n })), orch: { ...f.orch, ...flows },
      // a test this module is not running was cut off by a reload: it is not shown as running for ever
      test: s.test.phase === 'running' && !testing ? { phase: 'idle' } : s.test,
      from: s.from, grown: ticker ? (s.frame - s.at) / GROW : 1, hot: ticker !== undefined && s.frame - s.at < HOT,
    }, {
      // a choice is kept for later sessions as it is made, and the pane drawn again to show it
      pick: (key, value) => async () => {
        if (key === 'router.mode' && (value === 'on' || value === 'shadow' || value === 'off')) mode = value
        else if (key === 'router.floor') floor = MODELS.find(m => m === value) ?? floor
        else if (key === 'router.grader' && (value === 'haiku' || value === 'jev')) grader = value
        await $.store.set(key, value)
        $.ui.invalidate('ui.render')
      },
      save: async value => {
        jevKey = value.trim()
        await $.store.set('router.jevKey', jevKey)
        await say(jevKey ? 'Key saved in the plugin\'s store on this machine.' : 'Key removed.')
      },
      forget: async () => {
        jevKey = ''
        await $.store.set('router.jevKey', '')
        await say('Key removed.')
      },
      edit: () => void $.ui.focus({ requestId: SETUP, key: 'jev-key' }).catch(() => undefined),
      // the person's press switches dynamic workflows on, as their own change in /config would; the rows are read again
      flows: async () => {
        const r = await $.config.set({ key: 'workflows', value: true }).catch(() => ({ deny: 'the setting could not be changed' }))
        await survey($)
        if (r.deny !== undefined) await update($, pane, v => ({ ...v, said: `Dynamic workflows stay off: ${r.deny}` }))
        $.ui.invalidate('ui.render')
      },
      close: () => (rest(), $.ui.close({ id: SETUP })),
      test: async () => {
        if (testing) return
        if (!jevKey && !(await $.env.get('TYPESAFE_API_KEY'))) return void (await say('No key to test: save one here, or set TYPESAFE_API_KEY.', 'fail'))
        testing = true
        try {
          await update($, pane, (v): Pane => ({ ...v, said: '', test: { phase: 'running' } }))
          animate($)
          // fifteen seconds: a request that hangs must not leave the spinner turning
          const t0 = performance.now(), cls = await Promise.race([jev($, ask('Rename getUser to fetchUser in src/api.ts')), $.clock.sleep(15_000).then(() => undefined)]).catch(() => undefined)
          testing = false
          await update($, pane, (v): Pane => ({ ...v, test: cls ? { phase: 'ok', cls, ms: Math.round(performance.now() - t0) } : { phase: 'fail' } }))
        } finally {
          testing = false
        }
      },
    })
  })

  // the pane's timer ends with the pane when the person closes it; the mod's own close (above) is not raised to its own hooks
  on('ui.close', { id: SETUP }, (_$, e, next) => {
    rest()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ready($)
    if (!TASKS.has(e.origin.kind)) return next(e)
    asked.add(e.text)
    if (mode === 'off' || insists(e.text)) return next(e)
    // typed into a running turn: that turn takes the harder of its own class and this prompt's
    if (e.turnId !== undefined) {
      const was = main.grade, now = grade($, e.text, answer)
      main.grade = Promise.all([was, now]).then(([a, b]) => (harder(a.cls, b.cls) === a.cls ? a : b))
      return next(e)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await ready($)
    // only a prompt that is a task of its own is graded. Any other turn (a background agent's notification, a peer's
    // message, a continuation) carries on the work before it: at its class, or as an orchestrator's if agents are out
    const task = asked.delete(e.text) && e.text.trim() !== ''
    asked.clear()
    if (task) last = e.text
    if (task && /\bultracode\b/i.test(e.text)) orchestrating = true
    const g = mode === 'off' ? own('router off')
      : redo ? own('asked again')
      : orchestrating || out.size || (!task && main.spawned) ? own('orchestrating')
      : !task ? main.grade.then(g => ({ cls: harder(g.cls, 'involved'), by: g.by })) // not a prompt this module saw: never a cheap seat
      : insists(e.text) ? own('asked for')
      : grade($, e.text, answer)
    redo = false
    main = thread(g, e.text || main.task, { on: main.on, sent: main.sent })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await ready($)
    if (e.agentId === undefined && typeof e.effort === 'string') sessionEffort = e.effort
    if (mode === 'off') return yield* next(e)
    const to = await seat($, opts, e).catch(() => undefined)
    const r = yield* next(to && mode === 'on' ? { ...e, ...to } : e)
    try {
      settle(e, r.usage)
      // an open pane follows the figures: its bars set off from where they stood
      if (watching && Object.entries(flat()).some(([k, n]) => seen[k] !== n)) void moved($).catch(() => undefined)
      if (opts.routerLog) void $.fs.write(opts.routerLog, JSON.stringify({ routes, graded, ledger })).catch(() => undefined)
    } catch {
      // the books are not worth a turn
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    // whoever starts agents is orchestrating: it keeps its own seat for the rest of its turn
    const parent = e.parentAgentId === undefined ? main : agents.get(e.parentAgentId)
    if (parent) parent.spawned = true
    if (e.parentAgentId === undefined && e.workflow) orchestrating = true
    await ready($)
    if (e.fork || e.isTeammate || mode === 'off') return next(e)
    // a run that keeps its script to itself gives every agent the same placeholder for a task
    const task = e.workflow && e.prompt.length < 40 ? own('its task is not shown')
      : verdict(e.prompt) ? own('it gives a verdict')
      : /plan|review/i.test(e.subagentType) ? own('its agent type')
      : grade($, e.prompt)
    const started = next(e)
    starting.add(started)
    try {
      const r = await started
      // only a built-in agent on an inherited model is routed: a model the call named, or an agent somebody defined, stands.
      // Nothing may wait between the spawn's answer and this: the agent's first request is already on its way
      if (r.agentId) agents.set(r.agentId, thread(task, e.prompt, { parent, pinModel: e.model !== undefined || e.provider.plugin !== 'engine' || r.model !== e.parentModel }))
      if (r.agentId && e.parentAgentId === undefined) out.add(r.agentId)
      if (agents.size > 2000) agents.delete(agents.keys().next().value!)
      return r
    } finally {
      starting.delete(started)
    }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const t = e.agentId === undefined ? main : agents.get(e.agentId)
    if (t && /^(Edit|Write|NotebookEdit|StructuredOutput|mcp__plusplus__edit)$/.test(String(e.tool))) {
      // an edit or a structured answer refused, failed, or left with a syntax error; one that lands clears the count
      const said = typeof r.result === 'string' ? r.result : (r.text ?? '')
      t.strain = r.deny !== undefined || r.isError === true || /^syntax error:/m.test(said) ? t.strain + 1 : 0
    }
    return r
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) answer = e.answer
    else out.delete(e.agentId)
    return next(e)
  })
}
