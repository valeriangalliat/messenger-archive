import assert from 'node:assert/strict'
import test from 'node:test'
import 'fake-indexeddb/auto'
import { openArchive } from '../src/db.js'
import { repairArchive, retryAttachment } from '../src/repair.js'

const retry = async (fn) => {
  let last
  for (let n = 0; n < 3; n++)
    try {
      return await fn(n)
    } catch (e) {
      if (['ACCOUNT_CHANGED', 'DISCONNECTED'].includes(e.code)) throw e
      last = e
    }
  throw last
}
test('failed point refresh does not prevent a verified download using saved metadata', async () => {
  const calls = [],
    job = {
      id: 'hash',
      expectedHash: 'hash',
      status: 'error',
      mediaEntry: 'stored',
    }
  const result = await retryAttachment(
    job,
    async (action, value) => {
      calls.push(action)
      if (action === 'refreshMedia') throw Error('point read failed')
      if (calls.length === 1) throw Error('temporary download failure')
      assert.equal(value.expectedHash, 'hash')
      return { token: 'verified' }
    },
    retry,
  )
  assert.equal(result.result.token, 'verified')
  assert.deepEqual(calls, ['media', 'refreshMedia', 'media'])
  assert.equal(
    result.job.downloadAttempts.find((a) => a.operation === 'refreshMedia')
      .error,
    'point read failed',
  )
  assert.equal(job.mediaEntry, 'stored')
})

const source = (name, chat = name) => ({
  id: 'hash',
  expectedHash: 'hash',
  jid: `${chat}@msgr`,
  messageId: name,
  timestamp: name.length,
  mediaEntry: name,
  protocolMsgId: { author: name, chat, externalId: name },
})
test('every alternate and the original are reachable with their own source metadata', async () => {
  const original = source('working'),
    job = {
      ...original,
      status: 'error',
      sources: ['a', 'b', 'c', 'd'].map((n) => source(n)),
    }
  const attempted = []
  const result = await retryAttachment(
    job,
    async (action, value) => {
      assert.equal(value.jid, `${value.protocolMsgId.chat}@msgr`)
      assert.equal(value.messageId, value.protocolMsgId.externalId)
      if (action === 'refreshMedia') throw Error('refresh unavailable')
      attempted.push(value.mediaEntry)
      if (value.mediaEntry !== 'working') throw Error('copy unavailable')
      return { token: 'verified' }
    },
    retry,
  )
  assert.deepEqual([...new Set(attempted)], ['a', 'b', 'c', 'd', 'working'])
  assert.equal(result.result.token, 'verified')
  assert.equal(result.job.jid, original.jid)
})
test('metadata refresh is attempted even when several alternatives exist', async () => {
  const job = {
      ...source('original'),
      sources: ['a', 'b', 'c'].map((n) => source(n)),
    },
    calls = []
  const result = await retryAttachment(
    job,
    async (action, value) => {
      calls.push([action, value.mediaEntry])
      if (action === 'refreshMedia')
        return { ...source('a'), mediaEntry: 'fresh' }
      if (value.mediaEntry === 'fresh') return { token: 'verified' }
      throw Error('expired')
    },
    retry,
  )
  assert.deepEqual(calls, [
    ['media', 'a'],
    ['refreshMedia', 'a'],
    ['media', 'fresh'],
  ])
  assert.equal(result.job.mediaEntry, 'fresh')
  assert.ok(result.job.sources.some((s) => s.mediaEntry === 'a'))
})
test('exhausted downloads persist fresh metadata and bounded attempt diagnostics', async () => {
  const db = await openArchive(crypto.randomUUID()),
    job = {
      ...source('original'),
      status: 'error',
      downloadAttempts: Array.from({ length: 50 }, () => ({
        operation: 'previous',
      })),
    }
  await db.put('media', job)
  let failure
  try {
    await retryAttachment(
      job,
      async (action, value) => {
        if (action === 'refreshMedia')
          return { ...source('original'), mediaEntry: 'fresh' }
        assert.equal(value.expectedHash, 'hash')
        throw Error('Attachment download failed: direct-path-undefined')
      },
      retry,
      (updated) => db.put('media', updated),
    )
  } catch (error) {
    failure = error
  }
  assert.match(failure.message, /direct-path-undefined/)
  assert.equal(failure.job.mediaEntry, 'fresh')
  assert.equal(failure.job.downloadAttempts.length, 50)
  assert.deepEqual(
    failure.job.downloadAttempts.slice(-4).map((a) => [a.operation, !!a.error]),
    [
      ['media', true],
      ['refreshMedia', false],
      ['media', true],
      ['media', true],
    ],
  )
  assert.ok(failure.job.downloadAttempts.at(-1).at > 0)
  assert.equal(failure.job.downloadAttempts.at(-1).messageId, job.messageId)
  assert.deepEqual(await db.get('media', 'hash'), failure.job)
  assert.ok(failure.job.sources.some((s) => s.mediaEntry === 'original'))
  db.db.close()
})
test('refresh failures survive total failure and changed hashes never reach the downloader', async () => {
  const job = source('original')
  await assert.rejects(
    retryAttachment(
      job,
      async (action) => {
        if (action === 'refreshMedia')
          throw Error('message no longer accessible')
        throw Error('media unavailable')
      },
      retry,
    ),
    (error) => {
      assert.equal(
        error.job.downloadAttempts.find((a) => a.operation === 'refreshMedia')
          .error,
        'message no longer accessible',
      )
      return true
    },
  )
  await assert.rejects(
    retryAttachment(
      job,
      async (action, value) => {
        if (action === 'refreshMedia')
          return { ...job, expectedHash: 'different' }
        assert.equal(value.expectedHash, 'hash')
        throw Error('SHA-256 mismatch')
      },
      retry,
    ),
    (error) => {
      assert.equal(error.job.expectedHash, 'hash')
      assert.match(
        error.job.downloadAttempts.find((a) => a.operation === 'refreshMedia')
          .error,
        /different identifier or expected hash/,
      )
      return true
    },
  )
})
test('pause returns the latest checkpoint and account changes stop trying other sources', async () => {
  const job = { ...source('original'), sources: [source('a'), source('b')] },
    calls = []
  const paused = await retryAttachment(
    job,
    () => assert.fail('Paused retry must not call Messenger'),
    async () => null,
  )
  assert.equal(paused.result, null)
  await assert.rejects(
    retryAttachment(
      job,
      async (action) => {
        calls.push(action)
        throw Object.assign(Error('account changed'), {
          code: 'ACCOUNT_CHANGED',
        })
      },
      retry,
    ),
    (error) =>
      error.code === 'ACCOUNT_CHANGED' &&
      error.job.downloadAttempts.at(-1).code === 'ACCOUNT_CHANGED',
  )
  assert.deepEqual(calls, ['media'])
})
test('alternate sources are tried first and hash failures remain failures', async () => {
  const job = {
    id: 'hash',
    expectedHash: 'hash',
    status: 'error',
    mediaEntry: 'forwarded',
    protocolMsgId: { chat: 'b' },
    sources: [
      {
        id: 'hash',
        expectedHash: 'hash',
        mediaEntry: 'original',
        protocolMsgId: { chat: 'a' },
      },
    ],
  }
  const calls = []
  const result = await retryAttachment(
    job,
    async (action, value) => {
      calls.push(action)
      assert.equal(value.mediaEntry, 'original')
      return { token: 'verified' }
    },
    retry,
  )
  assert.equal(result.job.protocolMsgId.chat, 'a')
  assert.deepEqual(calls, ['media'])
  await assert.rejects(
    retryAttachment(
      job,
      async (action, value) => {
        assert.equal(value.expectedHash, 'hash')
        if (action === 'refreshMedia') throw Error('unavailable')
        throw Error('hash-mismatch')
      },
      retry,
    ),
    /hash-mismatch/,
  )
})
test('local repair selects only errors and failed attachment sources, keeping pagination and saved bytes', async () => {
  const db = await openArchive(crypto.randomUUID())
  const thread = { jid: '123@msgr', name: 'Fixture', encrypted: true }
  await db.discover([thread])
  const records = [
    {
      key: [thread.jid, 'a'],
      jid: thread.jid,
      id: 'a',
      timestamp: 10,
      error: 'unsupported',
      raw: { id: 'a' },
      attachments: [],
    },
    {
      key: [thread.jid, 'b'],
      jid: thread.jid,
      id: 'b',
      timestamp: 20,
      error: null,
      raw: { id: 'b' },
      attachments: ['missing'],
    },
    {
      key: [thread.jid, 'c'],
      jid: thread.jid,
      id: 'c',
      timestamp: 30,
      error: null,
      raw: { id: 'c' },
      attachments: ['saved'],
    },
  ]
  await db.commitPage(await db.get('threads', thread.jid), {
    records,
    attachments: [],
    next: null,
    decodeErrors: ['a'],
  })
  await db.put('media', {
    id: 'missing',
    expectedHash: 'missing',
    status: 'error',
    mediaEntry: 'forwarded',
  })
  const saved = { id: 'saved', status: 'saved', size: 3 }
  await db.beginMedia(saved)
  await db.saveChunk(saved.id, 0, new Uint8Array([1, 2, 3]))
  await db.put('media', saved)
  const before = await db.get('threads', thread.jid),
    calls = []
  const rpc = async (action, { jid, raw }) => {
    calls.push(action)
    assert.equal(jid, thread.jid)
    assert.deepEqual(
      raw.map((r) => r.id),
      ['a', 'b'],
    )
    return {
      records: records
        .slice(0, 2)
        .map((r) => ({ ...r, error: null, type: 'AdminEvent' })),
      attachments: [
        {
          id: 'missing',
          expectedHash: 'missing',
          jid,
          mediaEntry: 'original',
          protocolMsgId: { chat: jid },
        },
      ],
      decodeErrors: [],
    }
  }
  const ids = await repairArchive(
    db,
    rpc,
    () => {},
    () => false,
  )
  assert.deepEqual(calls, ['redecode'])
  assert.deepEqual([...ids], ['missing'])
  const after = await db.get('threads', thread.jid)
  assert.equal(after.decodeErrors, 0)
  for (const field of ['cursor', 'status', 'pages', 'oldest'])
    assert.deepEqual(after[field], before[field])
  assert.equal(await db.count('messages'), 3)
  assert.deepEqual(
    new Uint8Array(await (await db.mediaBlob(saved)).arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  )
  const missing = await db.get('media', 'missing')
  assert.equal(missing.status, 'error')
  assert.equal(missing.sources.length, 1)
  const page = await rpc('redecode', {
    jid: thread.jid,
    raw: [{ id: 'a' }, { id: 'b' }],
  })
  await db.repairPage(thread.jid, page)
  assert.equal((await db.get('threads', thread.jid)).decodeErrors, 0)
  assert.equal((await db.get('media', 'missing')).sources.length, 1)
  db.db.close()
})
