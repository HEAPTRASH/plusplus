import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { width } from './ui'

const DIALOG = {
  plugin: 'plusplus', component: 'Pane', requestId: 'codegraph-setup',
  props: { title: 'plusplus: code graph setup', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const SUM = 'd74d1bfb4060db63ec3c2b72c4e17f76c31978af3bad6ace4370d1501ac0662e', SIZE = 60 << 20
const BIN = '/home/u/.local/share/plusplus/codegraph/v1.6.2/bin/codegraph'

test('setup dialog asks before downloading and keeps the answer', async ($, on) => {
  const saved: Record<string, unknown> = {}
  // the engine beneath the plugin: a store that records what it keeps, and panes that close
  on('store.set', (_$, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('ui.close', () => ({ value: undefined }))
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    delete saved['codegraph.consent']
    const ui = await $.ui.mount({ ...DIALOG, surface, props: { ...DIALOG.props, bodyColumns: 60 } })
    expect(await ui.find({ type: 'Text', text: /CodeGraph v1\.6\.2/ })).toBeDefined()
    for (const t of await ui.findAll({ type: 'Text' })) if (t.props.wrap !== 'wrap') expect(width(t.text)).toBeLessThanOrEqual(60)
    // the three answers under their keys, the focus on the one that downloads
    expect((await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.hotkey, b.props.autoFocus])).toEqual([['yes', 'd', true], ['later', 'n', undefined], ['never', 'x', undefined]])
    await ui.press({ key: 'later' })
    expect(saved['codegraph.consent']).toBeUndefined() // "not now" stores nothing: asked again next session
    await ui.press({ key: 'never' })
    expect(saved['codegraph.consent']).toBe('no')
    await ui.unmount()
  }
})

/** The engine beneath an install: a machine where curl takes six seconds to bring the archive, whose sum is `sum`, and `head` ms to say its size. */
function machine(on: On, sum = SUM, head = 0) {
  const clock = mock.clock(on), w = { clock, toasts: [] as string[], closed: 0, opened: [] as unknown[], ran: [] as string[], sets: 0, has: false, started: -1 }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.store(on)
  mock.env(on, { HOME: '/home/u', LANG: 'en_US.UTF-8' })
  on('state.set', { plugin: 'plusplus', key: 'setup' }, (_$, e, next) => (w.sets++, next(e)))
  on('ui.toast', (_$, e) => (w.toasts.push(e.text), { value: undefined }) as never)
  on('ui.open', (_$, e) => (w.opened.push(e), { value: { isPlaced: true } }) as never)
  on('ui.close', () => (w.closed++, { value: undefined }))
  on('fs.exists', (_$, e) => ({ value: e.path === BIN && w.has }))
  // the archive on disk: ten megabytes a second since curl started
  on('fs.stat', () => w.started < 0 ? Promise.reject(new Error('ENOENT')) : ({ value: { kind: 'file' as const, size: Math.min(SIZE, Math.floor(((clock.now() - w.started) / 6000) * SIZE)), mtimeMs: 1, isLink: false } }) as never)
  on('process.run', async (_$, e) => {
    if (head && e.argv[1] === '-fsSLI') await clock.sleep(head)
    const a = e.argv
    w.ran.push(a.slice(0, 2).join(' '))
    if (a[0] === 'uname') return ok('Darwin arm64\n')
    if (a[0] === 'curl' && a[1] === '-fsSLI') return ok(`HTTP/2 302\r\ncontent-length: 0\r\n\r\nHTTP/2 200\r\nContent-Length: ${SIZE}\r\n`)
    if (a[0] === 'curl') return (w.started = clock.now()), await clock.sleep(6000), ok()
    if (a[0] === 'shasum') return await clock.sleep(400), ok(`${sum}  cg.tar.gz\n`)
    if (a[0] === 'tar') return await clock.sleep(400), ok()
    if (a[0] === 'mv') w.has = true
    return ok()
  })
  return w
}

test('the download is a bar that fills as the archive arrives, then the check and the unpacking, then a tick; the pane closes itself and no timer is left', async ($, on) => {
  const w = machine(on)
  const ui = await $.ui.mount({ ...DIALOG, surface: 'terminal' })
  const pressed = ui.press({ key: 'yes' })
  await w.clock.advance(0)
  // answered: opened again as a plain pane, which holds neither the toasts nor Escape
  expect(w.opened.at(-1)).toEqual({ id: 'codegraph-setup', title: 'plusplus: code graph setup', rows: 4 })
  const fill = async () => (await ui.find({ type: 'Text', text: /^[▏▎▍▌▋▊▉█]+$/ }))?.text.length ?? 0
  const seen: number[] = []
  for (let i = 0; i < 5; i++) {
    await w.clock.advance(1000)
    seen.push(await fill())
  }
  expect(seen).toEqual([...seen].sort((a, b) => a - b))
  expect(new Set(seen).size).toBe(5) // longer every second
  expect(await ui.find({ type: 'Text', text: '50.0 / 60.0 MB  83%' })).toBeDefined()
  expect((await ui.find({ key: 'hide' }))?.props.hotkey).toBe('h')
  await w.clock.advance(1200)
  expect(await ui.find({ type: 'Text', text: 'checking the SHA-256' })).toBeDefined()
  const a = (await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ }))?.text
  await w.clock.advance(200)
  expect((await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ }))?.text).not.toBe(a) // the spinner turns
  await w.clock.advance(200)
  expect(await ui.find({ type: 'Text', text: 'unpacking' })).toBeDefined()
  await w.clock.advance(400)
  await pressed
  expect(await ui.find({ type: 'Text', text: /^CodeGraph v1\.6\.2 installed in / })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '✓' }))?.props.color).toBe('success')
  expect(w.toasts).toEqual([]) // the pane said it all
  expect(w.closed).toBe(0)
  await w.clock.advance(3000)
  expect(w.closed).toBe(1)
  const rest = w.sets
  await w.clock.advance(10_000)
  expect(w.sets).toBe(rest)
  await ui.unmount()
})

test('while the server is still being asked the archive\'s size, the spinner already turns', async ($, on) => {
  const w = machine(on, SUM, 3000)
  const ui = await $.ui.mount({ ...DIALOG, surface: 'terminal' })
  const pressed = ui.press({ key: 'yes' })
  const spinner = async () => (await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ }))?.text
  await w.clock.advance(200)
  const a = await spinner()
  expect(a).toBeDefined()
  await w.clock.advance(200)
  expect(await spinner()).not.toBe(a)
  expect(w.started).toBe(-1) // no byte of the archive yet
  await w.clock.advance(3000 + 6000 + 1000)
  await pressed
  expect(await ui.find({ type: 'Text', text: /^CodeGraph v1\.6\.2 installed in / })).toBeDefined()
  await w.clock.advance(3000)
  const rest = w.sets
  await w.clock.advance(5000)
  expect(w.sets).toBe(rest)
  await ui.unmount()
})

test('hidden, the download goes on and a toast says how it ended; a bad checksum is a cross with a way to try again', async ($, on) => {
  const w = machine(on, 'f'.repeat(64))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...DIALOG, surface })
    const pressed = ui.press({ key: 'yes' })
    await w.clock.advance(2000)
    await pressed
    if (surface === 'terminal') {
      await w.clock.advance(5000)
      expect(await ui.find({ type: 'Text', text: /^CodeGraph was not installed: checksum mismatch for https:\/\/github\.com/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: '✗' }))?.props.color).toBe('error')
      expect((await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.hotkey, b.text])).toEqual([['yes', 'r', 'try again'], ['hide', 'c', 'close']])
      expect(w.toasts).toEqual([])
      expect(w.ran.at(-1)).toBe('rm -rf') // the half-made folder is gone
    } else {
      // hidden mid-download: the timer stops, the install runs to its end, and the toast carries the result
      await ui.press({ key: 'hide' })
      await ui.unmount() // a closed pane is not drawn again; the kit would go on drawing a mounted one
      const rest = w.sets
      await w.clock.advance(3000)
      expect(w.sets).toBe(rest)
      await w.clock.advance(3000)
      expect(w.toasts).toEqual([expect.stringMatching(/^✗ CodeGraph install failed: checksum mismatch/)])
      continue
    }
    await ui.unmount()
  }
})
