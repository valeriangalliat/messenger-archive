import assert from 'node:assert/strict'
import test from 'node:test'
import 'fake-indexeddb/auto'
import '../src/core.js'
import { openArchive } from '../src/db.js'
import { archiveZip } from '../src/export.js'
import { readZip } from './zip-reader.js'

test('sender names fall back to direct-chat titles without naming group members after their group', async (t) => {
  const db = await openArchive(crypto.randomUUID())
  t.after(() => db.db.close())
  const threads = [
    { jid: '123@msgr', id: '123', name: 'Known title' },
    { jid: '456@msgr', id: '456', name: 'Different title' },
    { jid: '789@g.us', id: '789', name: 'Group title' },
  ]
  await db.discover(threads)
  await db.put('meta', { key: 'names', value: { 456: 'Contact name' } })
  for (const thread of threads)
    await db.commitPage(await db.get('threads', thread.jid), {
      records: [
        { key: [thread.jid, 'message'], jid: thread.jid, senderId: thread.id },
      ],
      attachments: [],
      next: null,
    })
  const files = await readZip(
    Buffer.from(await (await archiveZip(db, db.account)).arrayBuffer()),
  )
  const index = JSON.parse(files['threads.json'])
  assert.deepEqual(JSON.parse(files['contacts.json']), {
    123: 'Known title',
    456: 'Contact name',
  })
  assert.deepEqual(
    index.map(
      (t) => JSON.parse(files[`${t.directory}/messages.ndjson`]).senderName,
    ),
    ['Known title', 'Contact name', '789'],
  )
})

test('ZIP separates conversations, preserves raw records and errors, and leaves stored data unchanged', async () => {
  const db = await openArchive(crypto.randomUUID()),
    C = globalThis.MessengerArchiveCore
  const threads = ['12@msgr', '123@msgr'].map((jid, i) => ({
    jid,
    id: String(i),
    name: i ? 'Bob' : '../Alice/👋',
    encrypted: true,
  }))
  await db.discover(threads, { complete: true })
  await db.put('meta', { key: 'names', value: { author: 'Sender' } })
  for (const thread of threads)
    await db.commitPage(await db.get('threads', thread.jid), {
      records: [
        {
          key: [thread.jid, 'a'],
          jid: thread.jid,
          senderId: 'author',
          text: thread.name,
          error: 'fixture decode issue',
          raw: C.pack({ bytes: new Uint8Array([0, 255]), n: 9n }),
        },
      ],
      attachments: [],
      next: null,
      decodeErrors: ['a'],
    })
  const job = { id: 'hash', jid: threads[0].jid, size: 3, mime: 'image/png' }
  await db.beginMedia(job)
  await db.saveChunk(job.id, 0, new Uint8Array([0, 255, 7]))
  await db.saveMedia({ ...job, status: 'saved' })
  await db.saveMedia({
    id: 'missing',
    status: 'error',
    error: 'direct-path-undefined',
  })
  const files = await readZip(
    Buffer.from(await (await archiveZip(db, db.account)).arrayBuffer()),
  )
  const manifest = JSON.parse(files['manifest.json']),
    index = JSON.parse(files['threads.json'])
  assert.equal(manifest.format, 'messenger-archive/3')
  assert.equal(manifest.messages, 2)
  assert.equal(manifest.exportComplete, true)
  assert.equal(manifest.attachmentsSaved, 1)
  assert.equal(manifest.decodeIssues.length, 2)
  assert.equal(manifest.attachmentFailures.length, 1)
  for (const thread of index) {
    const record = JSON.parse(
      files[`${thread.directory}/messages.ndjson`].toString().trim(),
    )
    assert.equal(record.jid, thread.jid)
    assert.equal(record.senderName, 'Sender')
    assert.deepEqual(C.unpack(record.raw), {
      bytes: new Uint8Array([0, 255]),
      n: 9n,
    })
    assert.equal(record.error, 'fixture decode issue')
    assert.ok(files[`${thread.directory}/thread.json`])
    assert.equal((await db.get('threads', thread.jid)).directory, undefined)
  }
  assert.deepEqual(files['media/hash.png'], Buffer.from([0, 255, 7]))
  assert.equal(
    Object.keys(files).filter((n) => n.startsWith('media/')).length,
    1,
  )
  assert.equal(await db.count('messages'), 2)
  assert.equal((await db.get('media', 'hash')).path, undefined)
  await assert.rejects(
    archiveZip(db, db.account, undefined, () => true),
    { name: 'AbortError' },
  )
  assert.equal(await db.count('messages'), 2)
  db.db.close()
})
test('ZIP distinguishes unresolved sticker messages from failed downloads and retains attempt diagnostics', async () => {
  const db = await openArchive(crypto.randomUUID()),
    thread = { jid: '123@msgr', id: '123', name: 'Fixture', encrypted: true }
  await db.discover([thread])
  const record = {
    key: [thread.jid, 'sticker'],
    jid: thread.jid,
    id: 'sticker',
    timestamp: 123,
    type: 'ReceiverFetch',
    unresolvedMedia: true,
    error:
      'Media could not be resolved without opening it; raw payload preserved.',
    decoded: { receiverFetchInfo: { receiverFetchId: '987', type: 'sticker' } },
    raw: { preserved: true },
  }
  await db.commitPage(await db.get('threads', thread.jid), {
    records: [record],
    attachments: [],
    next: null,
  })
  const attempts = [
    {
      operation: 'refreshMedia',
      at: 123,
      jid: thread.jid,
      messageId: 'video',
      error: 'message unavailable',
    },
  ]
  await db.saveMedia({
    id: 'missing',
    status: 'error',
    error: 'direct-path-undefined',
    downloadAttempts: attempts,
  })
  const files = await readZip(
    Buffer.from(await (await archiveZip(db, db.account)).arrayBuffer()),
  )
  const manifest = JSON.parse(files['manifest.json']),
    attachments = JSON.parse(files['attachments.json'])
  assert.equal(manifest.unresolvedMediaMessages, 1)
  assert.equal(manifest.unresolvedMedia[0].messageId, 'sticker')
  assert.equal(
    manifest.unresolvedMedia[0].receiverFetchInfo.receiverFetchId,
    '987',
  )
  assert.equal(manifest.attachmentFailures.length, 1)
  assert.equal(manifest.attachmentsSaved, 0)
  assert.deepEqual(attachments[0].downloadAttempts, attempts)
  const [{ directory }] = JSON.parse(files['threads.json'])
  assert.deepEqual(
    JSON.parse(files[`${directory}/messages.ndjson`]).raw,
    record.raw,
  )
  db.db.close()
})
