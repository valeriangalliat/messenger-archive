import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadComplete } from '../src/downloads.js'

function fixture(state = 'in_progress') {
  const event = () => {
    const listeners = new Set()
    return {
      listeners,
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      emit: (value) => {
        for (const fn of [...listeners]) fn(value)
      },
    }
  }
  const downloads = {
    onChanged: event(),
    onErased: event(),
    item: { id: 42, state, filename: '/Downloads/archive/file.bin' },
    calls: 0,
  }
  downloads.search = async () => {
    downloads.calls++
    return downloads.item ? [{ ...downloads.item }] : []
  }
  return downloads
}
const clean = (d) => {
  assert.equal(d.onChanged.listeners.size, 0)
  assert.equal(d.onErased.listeners.size, 0)
}
test('already-completed downloads finish without waiting for another event', async () => {
  const d = fixture('complete')
  assert.equal((await downloadComplete(d, 42)).filename, d.item.filename)
  assert.equal(d.calls, 1)
  clean(d)
})
test('completion events replace polling and unrelated downloads are ignored', async () => {
  const d = fixture(),
    result = downloadComplete(d, 42)
  await Promise.resolve()
  d.onChanged.emit({ id: 99, state: { current: 'complete' } })
  assert.equal(d.calls, 1)
  d.item.state = 'complete'
  d.onChanged.emit({ id: 42, state: { current: 'complete' } })
  assert.equal((await result).id, 42)
  assert.equal(d.calls, 2)
  clean(d)
})
test('completion racing the initial lookup cannot be lost', async () => {
  const d = fixture()
  let initial
  d.search = () =>
    ++d.calls === 1
      ? new Promise((resolve) => {
          initial = resolve
        })
      : Promise.resolve([{ ...d.item }])
  const result = downloadComplete(d, 42)
  d.item.state = 'complete'
  d.onChanged.emit({ id: 42, state: { current: 'complete' } })
  assert.equal((await result).state, 'complete')
  initial([{ ...d.item, state: 'in_progress' }])
  await Promise.resolve()
  clean(d)
})
test('interrupted, removed and missing downloads fail instead of appearing saved', async () => {
  const interrupted = fixture(),
    a = downloadComplete(interrupted, 42)
  interrupted.item.state = 'interrupted'
  interrupted.onChanged.emit({ id: 42, state: { current: 'interrupted' } })
  await assert.rejects(a, /interrupted/)
  clean(interrupted)
  const erased = fixture(),
    b = downloadComplete(erased, 42)
  erased.onErased.emit(42)
  await assert.rejects(b, /removed/)
  clean(erased)
  const missing = fixture()
  missing.item = null
  await assert.rejects(downloadComplete(missing, 42), /interrupted/)
  clean(missing)
})
test('lookup failures release both listeners', async () => {
  const d = fixture()
  d.search = async () => {
    throw Error('lookup failed')
  }
  await assert.rejects(downloadComplete(d, 42), /lookup failed/)
  clean(d)
})

test('a completed download known to be deleted cannot authorize local cleanup', async () => {
  const d = fixture('complete')
  d.item.exists = false
  await assert.rejects(downloadComplete(d, 42), /no longer exists/)
  clean(d)
})
