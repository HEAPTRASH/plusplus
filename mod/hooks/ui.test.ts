import { expect, test } from 'claude-code/testing'
import { ASCII, UNICODE, bar, cut, flow, glide, keyed, money, num, pad, say, spin, tall, width, wrap } from './ui'

test('text is measured and cut in cells, not characters', () => {
  expect(width('abc')).toBe(3)
  expect(width('日本語')).toBe(6)
  expect(width('é')).toBe(1)
  expect(cut('a long title that will not fit', 12)).toBe('a long titl…')
  expect(cut('日本語のタイトル', 7)).toBe('日本語…')
  expect(cut('two\nlines', 20)).toBe('two lines')
  expect(cut('abcdef', 4, '..')).toBe('ab..')
  expect(pad('ab', 5) + '|').toBe('ab   |')
  expect(pad('ab', 5, true)).toBe('   ab')
  expect(wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three fo…'])
  expect(wrap('src/a/very/long/path.ts', 8, 5).every(l => width(l) <= 8)).toBe(true)
})

test('a wrapping row is counted in rows, and a drawn tree by the rows a terminal gives it', () => {
  expect(flow([], 2, 10)).toBe(0)
  expect(flow([4, 4], 2, 10)).toBe(1)
  expect(flow([4, 4, 1], 2, 10)).toBe(2)
  expect(flow([30], 2, 10)).toBe(1) // one too wide for the row still takes one
  // the spec browser's legend: one row from 73 columns, two under
  const legend = ['area', 'spec', 'decision', 'accepted', 'proposed', 'stale', 'superseded'].map(x => 2 + x.length)
  expect([flow(legend, 2, 73), flow(legend, 2, 72), flow(legend, 2, 60)]).toEqual([1, 2, 2])
  expect([keyed('down', 'j'), keyed('close')]).toEqual([7, 5])
  const text = (t: string, props = {}) => ({ type: 'Text', props, children: [t] }), button = (label: string, hotkey: string) => ({ type: 'Button', props: { label, hotkey, plain: true }, children: [label] })
  const tree = { type: 'Box', props: { flexDirection: 'column', width: 20 }, children: [
    text('a title'), null, text(''),
    { type: 'Box', props: { flexDirection: 'row', marginTop: 1 }, children: [text('label '), text('-----')] },
    { type: 'Box', props: { paddingLeft: 8 }, children: [text('one two three four five six', { wrap: 'wrap' })] },
    { type: 'Box', props: { flexDirection: 'row', columnGap: 3, flexWrap: 'wrap' }, children: [button('down', 'j'), button('up', 'k'), button('close', 'q')] },
  ] }
  expect(tall(tree, 60)).toBe(1 + 2 + 3 + 2)
})

test('a bar fills in eighths of a cell, whole cells in ASCII, and never leaves its width', () => {
  expect(bar(UNICODE, 0.5, 4)).toEqual(['██', '░░'])
  expect(bar(UNICODE, 0.3, 10)).toEqual(['███', '░░░░░░░'])
  expect(bar(UNICODE, 0.33, 10)).toEqual(['███▎', '░░░░░░'])
  expect(bar(ASCII, 0.33, 10)).toEqual(['###', '.......'])
  for (const f of [-1, 0, 0.01, 0.999, 1, 7, NaN]) expect(width(bar(UNICODE, f, 12).join(''))).toBe(12)
  expect(glide(0, 10, 0)).toBe(0)
  expect(glide(0, 10, 1)).toBe(10)
  expect(glide(0, 10, 0.5)).toBeGreaterThan(5) // fast first, then settling
  expect(spin(UNICODE, 11)).toBe(UNICODE.spin[1]!)
  expect(Object.values(ASCII).flat().every(x => /^[\x20-\x7e]+$/.test(x))).toBe(true)
  expect(Object.values(UNICODE).flat().every(x => width(x) === 1)).toBe(true)
  expect([num(950), num(3100), num(12_345), num(1_250_000), money(0.416)]).toEqual(['950', '3.1k', '12k', '1.3M', '$0.42'])
  expect(say(UNICODE, 'ok', 'installed')).toBe('✓ installed')
  expect(say(ASCII, 'fail', 'no')).toBe('x no')
})
