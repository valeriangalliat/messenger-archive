import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentProgress } from '../src/attachment-progress.js'

test('attachment timer shows waits without overwriting pause or completion', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  let status,
    paused = false,
    writes = 0
  const job = {
    id: 'complete-attachment-id',
    jid: '123@msgr',
    mediaKind: 'photo',
  }
  const progress = attachmentProgress(
    { position: 2, queued: 10, saved: 5, total: 15, failed: 1 },
    job,
    new Map([[job.jid, 'Damien']]),
    (text) => {
      status = text
      writes++
    },
    () => paused,
  )
  t.after(progress.stop)
  assert.match(status, /Attachment 2 of 10 this run.*5\/15 saved/)
  assert.match(status, /Damien · Photo · Downloading/)
  assert.ok(status.includes(job.id))
  t.mock.timers.tick(2000)
  assert.match(status, /2s on this attachment/)

  progress.update({
    operation: 'waiting',
    attempt: 2,
    delay: 3000,
    error: 'media-not-found',
  })
  assert.match(status, /Retry in 3s.*attempt 2\/3/)
  t.mock.timers.tick(1000)
  assert.match(status, /Retry in 2s/)
  assert.match(status, /Last error: media-not-found/)

  progress.update({
    operation: 'media',
    attempt: 1,
  })
  assert.match(status, /Photo · Downloading · attempt 1\/3/)

  paused = true
  status = 'Pausing after the current request…'
  const before = writes
  t.mock.timers.tick(3000)
  progress.update({ operation: 'media' })
  assert.equal(writes, before)
  assert.equal(status, 'Pausing after the current request…')

  progress.stop()
  paused = false
  status = 'Archive finished.'
  t.mock.timers.tick(10000)
  assert.equal(writes, before)
  assert.equal(status, 'Archive finished.')
})
