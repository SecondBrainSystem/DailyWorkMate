import test from 'node:test'
import assert from 'node:assert/strict'
import { clampRatio, neighborPane, normalizeTabs, paneGeometry, panesOf, removePane, setRatio, siblingPane, splitPane, validateLayout, MAX_RATIO, MIN_RATIO, type PaneLayout } from '../../src/shared/terminalTabs.ts'

const id = (n: number) => String(n).repeat(8) + '-1111-1111-1111-111111111111'
const [a, b, c, d] = [1, 2, 3, 4].map(id)

test('splitting nests both directions in one tab without mutating the previous layout', () => {
  const single: PaneLayout = { pane: a }
  const right = splitPane(single, a, b, 'row')
  const down = splitPane(right, b, c, 'column')
  assert.deepEqual(single, { pane: a })
  assert.deepEqual(down, { split: 'row', ratio: 0.5, first: { pane: a }, second: { split: 'column', ratio: 0.5, first: { pane: b }, second: { pane: c } } })
  assert.deepEqual(panesOf(down), [a, b, c])
  const { panes, dividers } = paneGeometry(down)
  assert.deepEqual(panes.find(pane => pane.id === c)?.rect, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  assert.deepEqual(dividers.map(divider => [divider.path, divider.split]), [['', 'row'], ['1', 'column']])
  // Narrow windows stack side-by-side panes without changing the saved tree.
  assert.deepEqual(paneGeometry(down, true).panes.find(pane => pane.id === b)?.rect, { x: 0, y: 0.5, w: 1, h: 0.25 })
})

test('closing a pane hands its area to the sibling; closing the last one empties the tab', () => {
  const layout = splitPane(splitPane({ pane: a }, a, b, 'row'), b, c, 'column')
  assert.deepEqual(removePane(layout, b), { split: 'row', ratio: 0.5, first: { pane: a }, second: { pane: c } })
  assert.deepEqual(removePane(removePane(layout, a)!, c), { pane: b })
  assert.equal(removePane({ pane: a }, a), undefined)
  assert.equal(removePane(layout, d), layout, 'an unknown pane leaves the same object')
  assert.equal(siblingPane(layout, b), c, 'focus goes to the pane that takes over the area')
  assert.equal(siblingPane(layout, a), b)
  assert.equal(siblingPane(layout, c), b)
})

test('divider ratios are clamped and addressed by path', () => {
  assert.equal(clampRatio(0.01), MIN_RATIO); assert.equal(clampRatio(2), MAX_RATIO); assert.equal(clampRatio(Number.NaN), 0.5); assert.equal(clampRatio('0.7'), 0.5)
  const layout = splitPane(splitPane({ pane: a }, a, b, 'row'), b, c, 'column')
  const moved = setRatio(setRatio(layout, '', 0.99), '1', 0.3)
  assert.equal((moved as { ratio: number }).ratio, MAX_RATIO)
  assert.equal(((moved as { second: { ratio: number } }).second).ratio, 0.3)
  assert.equal((layout as { ratio: number }).ratio, 0.5)
})

test('Alt+Arrow focus moves to the pane that shares the longest edge', () => {
  const layout = splitPane(splitPane({ pane: a }, a, b, 'row'), b, c, 'column')
  assert.equal(neighborPane(layout, a, 'right'), b)
  assert.equal(neighborPane(layout, c, 'left'), a)
  assert.equal(neighborPane(layout, b, 'down'), c)
  assert.equal(neighborPane(layout, a, 'left'), undefined, 'no pane there: the key stays with the shell')
  assert.equal(neighborPane(layout, a, 'down', true), b, 'stacked narrow layout')
})

test('untrusted layouts are validated: structure, IDs, pane count and duplicates', () => {
  for (const bad of [null, { pane: '../x' }, { split: 'diagonal', ratio: 0.5, first: { pane: a }, second: { pane: b } }, { split: 'row', first: { pane: a }, second: { pane: a } },
    { split: 'row', first: { pane: a }, second: { split: 'row', first: { pane: b }, second: { split: 'row', first: { pane: c }, second: { split: 'row', first: { pane: d }, second: { pane: id(5) } } } } }]) {
    assert.throws(() => validateLayout(bad))
  }
  assert.deepEqual(validateLayout({ split: 'column', ratio: 5, first: { pane: a, extra: 1 }, second: { pane: b } }), { split: 'column', ratio: MAX_RATIO, first: { pane: a }, second: { pane: b } })
})

test('restoring: old files get one pane per tab, damaged tabs are skipped individually, closed sessions are pruned', () => {
  assert.deepEqual(normalizeTabs([a, b], undefined).tabs, [{ id: a, layout: { pane: a }, focused: a }, { id: b, layout: { pane: b }, focused: b }])
  const saved = [
    { id: a, layout: { split: 'row', ratio: 0.3, first: { pane: a }, second: { split: 'column', ratio: 0.6, first: { pane: b }, second: { pane: id(9) } } }, focused: id(9) },
    { id: c, layout: { split: 'nonsense' }, focused: c },
    'garbage',
    { id: d, layout: { pane: b }, focused: b },
  ]
  const { tabs, problems } = normalizeTabs([a, b, c, d], saved)
  assert.deepEqual(tabs, [
    { id: a, layout: { split: 'row', ratio: 0.3, first: { pane: a }, second: { pane: b } }, focused: a },
    { id: c, layout: { pane: c }, focused: c },
    { id: d, layout: { pane: d }, focused: d },
  ])
  assert.equal(problems.length, 3, 'invalid split, garbage entry and a pane already used elsewhere')
})
