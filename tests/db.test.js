import assert from 'node:assert/strict'
import test from 'node:test'
import 'fake-indexeddb/auto'
import { openArchive } from '../src/db.js'

const create = () => openArchive(crypto.randomUUID())
const thread = {
  jid: '123@msgr',
  id: '123',
  name: 'Alice',
  encrypted: true,
  source: 'server',
}
const page = {
  records: [
    {
      key: [thread.jid, 'a'],
      jid: thread.jid,
      id: 'a',
      timestamp: 20,
      text: 'hello',
    },
  ],
  attachments: [{ id: 'hash', jid: thread.jid, mediaEntry: 'metadata' }],
  next: [19, 'a'],
  decodeErrors: [],
}
test('messages, media jobs and cursor commit together; repeated records deduplicate', async () => {
  const db = await create()
  await db.discover([thread])
  let t = await db.get('threads', thread.jid)
  await db.commitPage(t, page)
  t = await db.get('threads', thread.jid)
  assert.deepEqual(t.cursor, [19, 'a'])
  assert.equal(await db.count('messages'), 1)
  await db.saveMedia({
    ...(await db.get('media', 'hash')),
    status: 'saved',
    size: 3,
  })
  await db.commitPage(t, { ...page, next: null })
  assert.equal(await db.count('messages'), 1)
  assert.equal((await db.get('media', 'hash')).status, 'saved')
  assert.equal((await db.get('threads', thread.jid)).status, 'reached-start')
})
test('failed transaction never advances a cursor or saves part of its page', async () => {
  const db = await create()
  await db.discover([thread])
  const t = await db.get('threads', thread.jid)
  await assert.rejects(
    db.commitPage(t, {
      ...page,
      records: [
        ...page.records,
        { key: [thread.jid, 'bad'], invalid: () => {} },
      ],
    }),
  )
  assert.deepEqual((await db.get('threads', thread.jid)).cursor, t.cursor)
  assert.equal(await db.count('messages'), 0)
  assert.equal(await db.count('media'), 0)
})
test('inventory cursor and discovered chats commit together and preserve history checkpoints', async () => {
  const db = await create()
  await db.discover([thread], { cursor: '50', complete: false })
  const t = await db.get('threads', thread.jid)
  await db.commitPage(t, page)
  await db.discover([{ ...thread, name: '123' }], {
    cursor: '20',
    complete: true,
  })
  const saved = await db.get('threads', thread.jid)
  assert.equal(saved.name, 'Alice')
  assert.deepEqual(saved.cursor, [19, 'a'])
  assert.equal((await db.get('meta', 'inventory')).complete, true)
})
test('chunked files reject incomplete data and restart without stale chunks', async () => {
  const db = await create(),
    job = { id: 'hash', status: 'pending' }
  await db.beginMedia(job)
  await db.saveChunk(job.id, 0, new Uint8Array([1, 2]))
  await assert.rejects(db.mediaBlob({ ...job, size: 3 }), /incomplete/)
  await db.beginMedia(job)
  await db.saveChunk(job.id, 0, new Uint8Array([3]))
  const blob = await db.mediaBlob({ ...job, size: 1 })
  assert.deepEqual(
    new Uint8Array(await blob.arrayBuffer()),
    new Uint8Array([3]),
  )
})
test('large histories stream in batches and account databases stay separate', async () => {
  const db = await create()
  for (let offset = 0; offset < 800; offset += 100) {
    const records = Array.from({ length: 100 }, (_, i) => ({
      key: [thread.jid, String(i + offset).padStart(4, '0')],
      jid: thread.jid,
      timestamp: i + offset,
    }))
    await db.commitPage(thread, {
      records,
      attachments: [],
      next: [1, 'a'],
      decodeErrors: [],
    })
  }
  const all = []
  for await (const m of db.rows('messages')) all.push(m)
  assert.equal(all.length, 800)
  assert.equal(new Set(all.map((m) => m.key[1])).size, 800)
  const other = await create()
  assert.equal(await other.count('messages'), 0)
})

test('conversation ranges stay separate across batched reads and reopening preserves data', async () => {
  const account = crypto.randomUUID(),
    db = await openArchive(account)
  for (const jid of ['12@msgr', '123@msgr']) {
    const records = Array.from({ length: 300 }, (_, i) => ({
      key: [jid, String(i).padStart(4, '0')],
      jid,
      timestamp: i,
    }))
    await db.commitPage(
      { ...thread, jid },
      { records, attachments: [], next: null, decodeErrors: [] },
    )
  }
  db.db.close()
  const reopened = await openArchive(account)
  for (const jid of ['12@msgr', '123@msgr']) {
    const rows = []
    for await (const row of reopened.rows('messages', jid)) rows.push(row)
    assert.equal(rows.length, 300)
    assert.ok(rows.every((row) => row.jid === jid))
  }
  assert.equal(reopened.db.version, 2)
  reopened.db.close()
})

test('history and repair merge all same-hash sources in a batch and preserve saved bytes', async () => {
  const db = await create()
  await db.discover([thread])
  const copy = (name) => ({
    id: 'hash',
    expectedHash: 'hash',
    jid: `${name}@msgr`,
    messageId: name,
    timestamp: name.length,
    mediaEntry: name,
    protocolMsgId: { chat: name, author: name },
  })
  await db.commitPage(await db.get('threads', thread.jid), {
    records: [],
    attachments: [copy('original'), copy('a')],
    next: null,
  })
  const saved = {
    ...(await db.get('media', 'hash')),
    status: 'saved',
    mime: 'image/png',
    size: 3,
    sha256: 'verified',
    downloadAttempts: [{ operation: 'media' }],
  }
  await db.beginMedia(saved)
  await db.saveChunk('hash', 0, new Uint8Array([7, 8, 9]))
  await db.saveMedia(saved)
  await db.repairPage(thread.jid, {
    records: [],
    attachments: [copy('b'), copy('c'), copy('b')],
  })
  await db.commitPage(await db.get('threads', thread.jid), {
    records: [],
    attachments: [copy('d'), copy('e')],
    next: null,
  })
  const job = await db.get('media', 'hash')
  assert.equal(job.mediaEntry, 'original')
  assert.equal(job.status, 'saved')
  assert.deepEqual(
    job.sources.map((s) => s.mediaEntry),
    ['a', 'b', 'c', 'd', 'e'],
  )
  for (const s of job.sources) {
    assert.equal(s.messageId, s.protocolMsgId.author)
    assert.equal(s.jid, `${s.protocolMsgId.chat}@msgr`)
  }
  assert.deepEqual(job.downloadAttempts, saved.downloadAttempts)
  assert.equal(job.sha256, 'verified')
  assert.deepEqual(
    new Uint8Array(await (await db.mediaBlob(job)).arrayBuffer()),
    new Uint8Array([7, 8, 9]),
  )
  db.db.close()
})
test('unresolved media updates atomically, deduplicates and clears after repair', async () => {
  const db = await create()
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
    decoded: { receiverFetchInfo: { type: 'sticker', receiverFetchId: '987' } },
    raw: { preserved: true },
  }
  const p = { records: [record], attachments: [], next: null }
  await db.commitPage(await db.get('threads', thread.jid), p)
  await db.commitPage(await db.get('threads', thread.jid), p)
  assert.equal(await db.count('mediaIssues'), 1)
  assert.equal(await db.count('media'), 0)
  assert.equal(
    (await db.all('mediaIssues'))[0].receiverFetchInfo.receiverFetchId,
    '987',
  )
  const fixed = {
    ...record,
    unresolvedMedia: false,
    error: null,
    attachments: ['hash'],
  }
  await assert.rejects(
    db.commitPage(await db.get('threads', thread.jid), {
      ...p,
      records: [fixed, { key: [thread.jid, 'bad'], invalid: () => {} }],
    }),
  )
  assert.equal(await db.count('mediaIssues'), 1)
  await db.repairPage(thread.jid, {
    records: [fixed],
    attachments: [{ id: 'hash' }],
  })
  assert.equal(await db.count('mediaIssues'), 0)
  assert.deepEqual((await db.get('messages', record.key)).raw, record.raw)
  db.db.close()
})
test('overlapping pages deduplicate message IDs and decoding counts without redownloading saved media', async () => {
  const db = await create()
  await db.discover([thread])
  const record = {
    key: [thread.jid, 'a'],
    jid: thread.jid,
    id: 'a',
    timestamp: 900,
    error: 'unsupported',
  }
  const p = {
    records: [record, record],
    attachments: [{ id: 'hash' }],
    next: [901, null],
    decodeErrors: ['a'],
  }
  await db.commitPage(await db.get('threads', thread.jid), p)
  await db.saveMedia({ id: 'hash', status: 'saved', size: 3 })
  await db.commitPage(await db.get('threads', thread.jid), p)
  assert.equal(await db.count('messages'), 1)
  assert.equal((await db.get('threads', thread.jid)).decodeErrors, 1)
  assert.equal((await db.get('media', 'hash')).status, 'saved')
  await db.commitPage(await db.get('threads', thread.jid), {
    ...p,
    records: [{ ...record, error: null }],
    next: null,
    decodeErrors: [],
  })
  assert.equal((await db.get('threads', thread.jid)).decodeErrors, 0)
  db.db.close()
})

test('rediscovery upgrades an unencrypted chat to pending without losing its checkpoint', async () => {
  const db = await create()
  await db.discover([{ ...thread, encrypted: false }])
  const before = await db.get('threads', thread.jid)
  assert.equal(before.status, 'unencrypted')
  await db.discover([thread])
  const after = await db.get('threads', thread.jid)
  assert.equal(after.encrypted, true)
  assert.equal(after.status, 'pending')
  assert.deepEqual(after.cursor, before.cursor)
  db.db.close()
})

test('repair deduplicates repeated records before updating issue counts', async () => {
  const db = await create()
  try {
    await db.discover([thread])
    const records = ['a', 'b'].map((id) => ({
      key: [thread.jid, id],
      jid: thread.jid,
      id,
      timestamp: 100,
      error: 'decode failed',
      unresolvedMedia: true,
    }))
    await db.commitPage(await db.get('threads', thread.jid), {
      records,
      attachments: [],
      next: null,
    })
    const fixed = { ...records[0], error: null, unresolvedMedia: false }
    await db.repairPage(thread.jid, {
      records: [fixed, fixed],
      attachments: [],
    })
    assert.equal((await db.get('threads', thread.jid)).decodeErrors, 1)
    assert.equal(await db.count('mediaIssues'), 1)
    assert.equal((await db.get('messages', records[0].key)).error, null)
  } finally {
    db.db.close()
  }
})
