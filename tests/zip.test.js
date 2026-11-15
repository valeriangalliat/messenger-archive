import assert from 'node:assert/strict'
import test from 'node:test'
import { Zip } from '../src/zip.js'
import { readZip } from './zip-reader.js'

test('ZIP64 archive interoperates with an independent reader for UTF-8, streamed DEFLATE, empty and stored files', async () => {
  const zip = new Zip()
  const stream = new ReadableStream({
    start(out) {
      out.enqueue(new TextEncoder().encode('hello 👋\n'))
      out.close()
    },
  })
  await zip.add('threads/é/messages.ndjson', stream, true)
  await zip.add('media/file.bin', new Blob([new Uint8Array([0, 255, 7])]))
  await zip.add('empty', new Blob([]))
  const bytes = Buffer.from(await zip.finish().arrayBuffer())
  const files = await readZip(bytes)
  assert.equal(files['threads/é/messages.ndjson'].toString(), 'hello 👋\n')
  assert.deepEqual(files['media/file.bin'], Buffer.from([0, 255, 7]))
  assert.equal(files.empty.length, 0)
  const corrupt = Buffer.from(bytes)
  const offset = corrupt.indexOf(Buffer.from([0, 255, 7]))
  assert.ok(offset >= 0)
  corrupt[offset] ^= 1
  await assert.rejects(readZip(corrupt), /CRC mismatch/)
  assert.throws(() => zip.finish(), /already finished/)
  await assert.rejects(zip.add('later', new Blob([])), /already finished/)
})
test('ZIP rejects unsafe names, duplicates and cancellation', async () => {
  const zip = new Zip()
  for (const name of [
    '../escape',
    '/absolute',
    'a/../b',
    'a\\b',
    'a//b',
    'a\0b',
  ])
    await assert.rejects(zip.add(name, new Blob([])), /Invalid/)
  await zip.add('ok', new Blob([]))
  await assert.rejects(zip.add('ok', new Blob([])), /duplicate/)
  let paused = false
  const cancellable = new Zip(() => {
    if (paused) throw Error('paused')
  })
  paused = true
  await assert.rejects(cancellable.add('file', new Blob(['x'])), /paused/)
  assert.throws(() => cancellable.finish(), /paused/)
})
