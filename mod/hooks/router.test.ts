import { expect, test } from 'claude-code/testing'
import { ask, bill, likely, family, guess, harder, insists, label, overrun, route, strained, verdict } from './router'

const opus = { model: 'opus', effort: 'xhigh' } as const

test('a thread starts on the cheapest model trusted with its task, within its ceiling and the floor', async () => {
  expect(family('claude-opus-5-5[1m]')).toBe('opus')
  expect(family('claude-haiku-5-5')).toBe('haiku')
  expect(family('gpt-5')).toBeUndefined()
  expect(route('mechanical', opus, 'haiku')).toEqual({ model: 'haiku', effort: 'medium', cls: 'mechanical' })
  expect(route('routine', opus, 'haiku')).toEqual({ model: 'sonnet', effort: 'medium', cls: 'routine' })
  expect(route('involved', opus, 'haiku')).toEqual({ model: 'opus', effort: 'high', cls: 'involved' })
  expect(route('hard', opus, 'haiku')).toEqual({ model: 'opus', effort: 'xhigh', cls: 'hard' })
  expect(route('involved', { model: 'sonnet', effort: 'low' }, 'haiku')).toMatchObject({ model: 'sonnet', effort: 'low' })
  expect(route('mechanical', opus, 'sonnet')).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(route('routine', { model: 'fable', effort: 'high' }, 'haiku')).toMatchObject({ model: 'sonnet', effort: 'medium' })
  // a thread whose requests carry no effort is sent none
  expect(route('mechanical', { model: 'sonnet' }, 'haiku').effort).toBeUndefined()
})

test('once on a model a thread only moves up; effort follows each task', async () => {
  expect(route('mechanical', opus, 'haiku', 'opus')).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(route('mechanical', opus, 'haiku', 'sonnet')).toMatchObject({ model: 'sonnet' })
  expect(route('routine', opus, 'haiku', 'haiku')).toMatchObject({ model: 'sonnet' })
  expect(route('involved', opus, 'haiku', 'haiku')).toMatchObject({ model: 'opus', effort: 'high' })
  expect(route('hard', opus, 'haiku', 'haiku')).toMatchObject({ model: 'opus', effort: 'xhigh' })
  // the person lowered the session's model under it: never above the ceiling
  expect(route('routine', { model: 'haiku', effort: 'medium' }, 'haiku', 'opus')).toMatchObject({ model: 'haiku' })
})

test('failed edits in a row raise the effort, then send the thread to its ceiling', async () => {
  const seat = route('mechanical', opus, 'haiku')
  expect(strained(seat, opus, 1)).toEqual(seat)
  expect(strained(seat, opus, 2)).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(strained(seat, opus, 4)).toMatchObject({ model: 'opus', effort: 'xhigh', cls: 'mechanical' })
  const capped = { model: 'sonnet', effort: 'medium' } as const
  expect(strained(route('routine', capped, 'haiku'), capped, 3)).toMatchObject(capped)
})

test('the report prices real usage at list price', async () => {
  const u = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  expect(near(bill(u, 'opus'), 0.124)).toBe(true) // 1k in at 4, 10k written at 8, 100k read at 0.2, 1k out at 20
  expect(near(bill(u, 'opus', 1.25), 0.094)).toBe(true)
  expect(near(bill(u, 'haiku'), 0.018)).toBe(true) // a 111k prompt: five times haiku's base rates
  expect(near(bill({ input_tokens: 10, output_tokens: 5 }, 'sonnet'), 0.00007)).toBe(true)
})

test('wording: only an outright ask and a verdict stage skip the classifier, and never downwards', async () => {
  expect(insists('ultrathink about the cache layer')).toBe(true)
  expect(insists('Think hard before you answer')).toBe(true)
  expect(insists('Fan out over packages/* with subagents and list unused exports')).toBe(true)
  expect(insists('Rename getUser to fetchUser in src/api.ts')).toBe(false)
  expect(verdict('Adversarially verify: "the cache can serve stale reads after a failed write".')).toBe(true)
  expect(verdict('You are the judge. Score each finding 1-5.')).toBe(true)
  expect(verdict('Decide whether finding 7 is real.')).toBe(true)
  expect(verdict('Find every caller of parseConfig under src/ and list file:line.')).toBe(false)
  // further in, the same words are boilerplate about checking one's own work
  expect(verdict('Find every caller of parseConfig under src/.' + ' Context.'.repeat(40) + ' Verify your answer before finishing.')).toBe(false)
  // with nobody to ask, nothing is ever taken for mechanical
  expect(guess('Rename getUser to fetchUser in src/api.ts')).toBe('routine')
  expect(guess('Replace the in-memory session store with Redis and redesign the callers')).toBe('involved')
  expect(guess('x'.repeat(700))).toBe('involved')
  expect(harder('routine', 'mechanical')).toBe('routine')
  expect(likely({ mechanical: 0.7, routine: 0.25, involved: 0.05 })).toBe('routine') // in two minds: the harder
  expect(likely({ mechanical: 1 })).toBe('mechanical')
  expect(likely({})).toBeUndefined()
  expect(overrun('mechanical', 11)).toBe(false)
  expect(overrun('mechanical', 12)).toBe(true)
  expect(overrun('involved', 30)).toBe(false)
  expect(label('routine')).toBe('routine')
  expect(label('Involved.')).toBe('involved')
  expect(label('Not mechanical: this is hard.')).toBe('hard') // a reply that explains itself concludes at the end
  expect(label('unsure')).toBeUndefined()
  expect(ask('x'.repeat(10_000)).length < 6000).toBe(true)
  expect(ask('do it', 'Plan: split the orders table. Want me to go ahead?')).toMatch(/^<before>\n.*go ahead\?\n<\/before>\n\n<task>\ndo it\n<\/task>/s)
  expect(ask('do it')).not.toMatch(/before/)
})
