import assert from 'node:assert/strict'
import test from 'node:test'
import '../src/core.js'

const C = globalThis.MessengerArchiveCore
test('raw payloads and attachment metadata survive JSON serialization', () => {
  const original = {
    bytes: new Uint8Array([0, 255, 7]),
    map: new Map([['reaction', new Uint8Array([4])]]),
    set: new Set(['x']),
    big: 9223372036854775807n,
    missing: undefined,
  }
  assert.deepEqual(
    C.unpack(JSON.parse(JSON.stringify(C.pack(original)))),
    original,
  )
})
test('missing and stuck cursors never look complete', () => {
  assert.throws(() => C.nextCursor([100, null], null, true))
  assert.throws(() => C.nextCursor([100, 'a'], [100, 'b'], true))
  assert.throws(() => C.nextCursor([100, null], [20, 'x'], undefined))
  assert.deepEqual(C.nextCursor([100, null], [50, 'x'], true), [51, 'x'])
  assert.equal(C.nextCursor([100, null], null, false), null)
  assert.throws(() =>
    C.inventoryCursor('9223372036854775807', '9223372036854775807', true),
  )
  assert.equal(
    C.inventoryCursor('9223372036854775807', '1740000000000', true),
    '1740000000000',
  )
})
test('response decoder collects procedures as data and follows only the selected branch', () => {
  const result = C.readSteps([
    1,
    [3, 2, [19, '9223372036854775807']],
    [23, false, [5, 'deleteThread', [19, '1']], [5, 'ftsRow', [2, 2], [9]]],
  ])
  assert.deepEqual(result, [
    { name: 'ftsRow', args: [9223372036854775807n, undefined] },
  ])
  assert.throws(
    () => C.readSteps([7, 'executeSomething']),
    /nothing was executed/,
  )
  assert.throws(
    () => C.readSteps([23, [5, 'getSomething'], [5, 'row']]),
    /procedure-dependent/,
  )
})
test('field layouts must be unambiguous', () => {
  const source =
    'function f(){var e=arguments;return t.db.table(331).put({threadId:e[0],threadType:e[2]})}'
  assert.deepEqual(C.fieldIndexes(source, ['threadId', 'threadType']), {
    threadId: 0,
    threadType: 2,
  })
  assert.throws(() => C.fieldIndexes(source, ['nextPageCursor']))
  assert.throws(() =>
    C.fieldIndexes(`${source};x={threadId:e[3]}`, ['threadId']),
  )
})
test('attachment paths cannot escape the archive directory', () => {
  assert.equal(C.filename('../../bad/name', 'text/html'), '______bad_name.bin')
})

test('task guards apply only to the submitted task and tuple results populate references', () => {
  const response = (task) => [
    1,
    [4, 0, 1, [5, 'taskExists', [19, String(task)]]],
    [
      23,
      [2, 0],
      [
        1,
        [5, 'ftsRow', [19, '123']],
        [5, 'removeTask', [19, String(task)], [9]],
      ],
      [7, 'unhandledNativeOperation'],
    ],
  ]
  const calls = C.readSteps(response(42), 42)
  assert.deepEqual(
    calls.map((c) => c.name),
    ['taskExists', 'ftsRow', 'removeTask'],
  )
  assert.throws(() => C.readSteps(response(43), 42), /task guard did not match/)
  assert.throws(() => C.readSteps(response(42)), /procedure-dependent/)
  assert.throws(
    () => C.readSteps([1, [5, 'taskExists', [19, '42']], [7, 'unknown']], 42),
    /nothing was executed/,
  )
  assert.throws(
    () => C.readSteps([4, 0, 2, [5, 'taskExists', [19, '42']]], 42),
    /response tuple/,
  )
})

test('FTS processing callback is omitted, but its result cannot affect extracted data', () => {
  const callback = [7, 'processFetchedFtsThreads', true]
  const program = [1, [4, 1, 1, callback], [5, 'row', [19, '123']]]
  assert.deepEqual(C.readSteps(program, 42), [{ name: 'row', args: [123n] }])
  assert.throws(
    () => C.readSteps([1, program, [23, [2, 1], [5, 'row']]], 42),
    /procedure-dependent/,
  )
  assert.throws(
    () => C.readSteps([7, 'processFetchedFtsThreads', 'unexpected'], 42),
    /nothing was executed/,
  )
  assert.throws(
    () => C.readSteps([7, 'processFetchedFtsThreads', true, false], 42),
    /nothing was executed/,
  )
  assert.throws(() => C.readSteps(callback), /nothing was executed/)
})

test('history overlaps the last millisecond instead of excluding its sibling messages', () => {
  assert.deepEqual(C.nextCursor([1000, null], [900, 'photo-a'], true), [
    901,
    'photo-a',
  ])
  assert.throws(() => C.nextCursor([901, 'photo-a'], [900, 'photo-b'], true), {
    code: 'HISTORY_CURSOR_STUCK',
  })
})
