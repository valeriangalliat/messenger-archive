import assert from 'node:assert/strict'
import test from 'node:test'
import 'fake-indexeddb/auto'
import '../src/core.js'
import { messageDigest, validateCheckpoint } from '../src/checkpoint.js'
import { openArchive } from '../src/db.js'
import { archiveZip } from '../src/export.js'
import { importCheckpoint } from '../src/import.js'
import { Zip } from '../src/zip.js'
import { readZip } from './zip-reader.js'

const thread = { jid: '123@msgr', id: '123', name: 'Chat', encrypted: true }
const record = (id, timestamp, extra = {}) => ({
  key: [thread.jid, id],
  jid: thread.jid,
  id,
  timestamp,
  text: id,
  raw: { id },
  error: null,
  ...extra,
})
async function create(t, account = crypto.randomUUID()) {
  const db = await openArchive(account)
  t.after(() => db.db.close())
  return { db, account }
}
async function page(db, records, next = null, attachments = []) {
  await db.commitPage(await db.get('threads', thread.jid), {
    records,
    next,
    attachments,
  })
}
async function asset(db, id = 'asset', bytes = [1, 2, 3]) {
  const job = {
    id,
    size: bytes.length,
    mime: 'image/png',
    sha256: Buffer.from(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ).toString('hex'),
    expectedHash: `source-${id}`,
    jid: thread.jid,
  }
  await db.beginMedia(job)
  await db.saveChunk(id, 0, new Uint8Array(bytes))
  await db.saveMedia({ ...job, status: 'saved' })
}
async function prepare(db, account) {
  let snapshot
  const blob = await archiveZip(db, account, undefined, undefined, (value) => {
    snapshot = value
  })
  const files = await readZip(Buffer.from(await blob.arrayBuffer()))
  return {
    blob,
    snapshot,
    files,
    checkpoint: JSON.parse(files['checkpoint.json']),
    manifest: JSON.parse(files['manifest.json']),
  }
}
async function baseline(db) {
  await db.discover([thread], { complete: true })
  await page(db, [record('old', 10), record('boundary', 100)])
  await asset(db)
}
const recordsIn = (files) =>
  Object.entries(files)
    .filter(([name]) => name.endsWith('/messages.ndjson'))
    .flatMap(([, bytes]) =>
      bytes.toString().split('\n').filter(Boolean).map(JSON.parse),
    )

test('delta ZIPs use verified boundaries, consume equal timestamp groups, and reference earlier media across migration', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  assert.equal(first.checkpoint.threads[0].coveredThrough, 100)
  assert.equal(await db.get('meta', 'checkpoint'), undefined)
  await db.finalizeBackup(first.snapshot, {
    cleanup: true,
    retainMessages: false,
    filename: '/downloads/baseline.zip',
  })
  assert.equal(await db.count('chunks'), 0)
  assert.equal(await db.count('messages'), 0)
  assert.equal((await db.get('media', 'asset')).status, 'exported')
  await assert.rejects(
    db.mediaBlob(await db.get('media', 'asset')),
    /earlier backup/,
  )
  await db.beginUpdate([1000, null])
  await page(
    db,
    [record('new', 200), record('boundary', 100), record('equal-a', 100)],
    [101, null],
    [{ id: 'asset', jid: thread.jid, messageId: 'new' }],
  )
  assert.equal((await db.get('threads', thread.jid)).status, 'pending')
  assert.equal((await db.get('threads', thread.jid)).coveredThrough, 100)
  db.db.close()
  const reopened = await openArchive(account)
  t.after(() => reopened.db.close())
  assert.deepEqual((await reopened.get('threads', thread.jid)).cursor, [
    101,
    null,
  ])
  await page(
    reopened,
    [record('equal-a', 100), record('equal-b', 100), record('old', 10)],
    [11, null],
  )
  assert.equal((await reopened.get('threads', thread.jid)).coveredThrough, 200)
  assert.equal(
    (await reopened.get('threads', thread.jid)).status,
    'reached-start',
  )
  const second = await prepare(reopened, account)
  assert.deepEqual(
    recordsIn(second.files)
      .map((m) => m.id)
      .sort(),
    ['equal-a', 'equal-b', 'new'],
  )
  assert.equal(second.files['media/asset.png'], undefined)
  assert.equal(second.checkpoint.media[0].backupId, first.checkpoint.backupId)
  assert.equal(second.checkpoint.dependencies[0].filename, 'baseline.zip')
  assert.equal(
    JSON.parse(second.files['attachments.json'])[0].availability,
    'earlier-backup',
  )
  await reopened.finalizeBackup(second.snapshot, {
    cleanup: true,
    retainMessages: false,
  })

  // A new machine only imports the latest checkpoint, with no prior media or raw cache.
  const migrated = await create(t, account)
  await migrated.db.clearLocal()
  await migrated.db.importBackup(
    await importCheckpoint(new File([second.blob], 'delta.zip'), account),
  )
  assert.equal(await migrated.db.count('messages'), 0)
  assert.equal(await migrated.db.count('chunks'), 0)
  await migrated.db.beginUpdate([2000, null])
  await page(
    migrated.db,
    [record('next-year', 300), record('new', 200), record('equal-b', 100)],
    [101, null],
  )
  const third = await prepare(migrated.db, account)
  assert.deepEqual(
    recordsIn(third.files).map((m) => m.id),
    ['next-year'],
  )
  assert.equal(third.checkpoint.dependencies.length, 2)
  assert.equal(third.checkpoint.messages.length, 6)
})

test('ZIP import rejects backups without a portable checkpoint', async () => {
  const zip = new Zip()
  await zip.add(
    'manifest.json',
    new Blob([JSON.stringify({ format: 'messenger-archive/2' })]),
  )
  await assert.rejects(
    importCheckpoint(new File([zip.finish()], 'old.zip'), 'account'),
    /Unsupported backup ZIP/,
  )
})

test('current ZIP import reads only metadata and restores retryable failures and attachments', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const failed = record('failed', 80, {
    error: 'decode failed',
    unresolvedMedia: true,
  })
  await page(db, [failed])
  await asset(db, 'large', new Uint8Array(1000000))
  await db.saveMedia({
    id: 'pending',
    status: 'error',
    error: 'unavailable',
    mediaEntry: { preserved: true },
  })
  const first = await prepare(db, account)
  const slices = []
  const checkpoint = await importCheckpoint(
    {
      name: 'backup.zip',
      size: first.blob.size,
      slice(start, end) {
        slices.push([start, end ?? first.blob.size])
        return first.blob.slice(start, end)
      },
    },
    account,
  )
  assert.ok(slices.every(([start, end]) => end - start < 100000))
  await db.clearLocal()
  await db.importBackup(checkpoint)
  assert.equal(await db.count('chunks'), 0)
  assert.equal(await db.count('messages'), 1)
  assert.equal(await db.count('mediaIssues'), 1)
  assert.equal((await db.get('messages', failed.key)).raw.id, 'failed')
  assert.equal((await db.get('media', 'pending')).mediaEntry.preserved, true)
  await db.repairPage(thread.jid, {
    records: [{ ...failed, error: null, unresolvedMedia: false }],
    attachments: [],
  })
  const next = await prepare(db, account)
  assert.deepEqual(
    recordsIn(next.files).map((m) => m.id),
    ['failed'],
  )
  assert.equal(next.checkpoint.failures.length, 0)
  assert.equal(next.checkpoint.pendingMedia.length, 1)
})

test('checkpoint hashes deduplicate retained content and cleanup preserves changed and unfinished work', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.finalizeBackup(first.snapshot)
  const unchanged = await prepare(db, account)
  assert.deepEqual(recordsIn(unchanged.files), [])
  assert.equal(unchanged.manifest.attachmentsSaved, 0)
  assert.equal((await db.storageUsage()).reclaimableBytes, 3)
  await page(db, [
    record('old', 10, { text: 'edited' }),
    record('failed', 50, { error: 'decode failed' }),
  ])
  await asset(db, 'asset', [4, 5, 6])
  await db.saveMedia({ id: 'pending', status: 'pending' })
  await db.saveChunk('pending', 0, new Uint8Array([7]))
  await db.cleanupExported({ messages: true })
  assert.equal(await db.get('messages', record('boundary', 100).key), undefined)
  assert.equal((await db.get('messages', record('old', 10).key)).text, 'edited')
  assert.equal(
    (await db.get('messages', record('failed', 50).key)).error,
    'decode failed',
  )
  assert.equal((await db.storageUsage()).attachmentBytes, 4)
  assert.equal((await db.storageUsage()).reclaimableBytes, 0)
  const next = await prepare(db, account)
  assert.deepEqual(
    recordsIn(next.files).map((m) => m.id),
    ['failed', 'old'],
  )
  assert.equal(next.manifest.attachmentsSaved, 1)
  await db.finalizeBackup(next.snapshot, {
    cleanup: true,
    retainMessages: false,
  })
  assert.equal(await db.count('messages'), 1)
  assert.equal((await db.storageUsage()).attachmentBytes, 1)
})

test('baseline reconciliation preserves changed and unexported work; cross-account and malformed imports make no changes', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await page(db, [
    record('old', 10, { text: 'locally repaired' }),
    record('unexported', 250),
  ])
  const fresh = await create(t)
  await assert.rejects(
    fresh.db.importBackup(first.checkpoint),
    /different Messenger account/,
  )
  assert.equal(await fresh.db.count('threads'), 0)
  await db.importBackup(first.checkpoint)
  const delta = await prepare(db, account)
  assert.deepEqual(
    recordsIn(delta.files)
      .map((m) => m.id)
      .sort(),
    ['old', 'unexported'],
  )
  assert.equal(delta.manifest.attachmentsSaved, 0)
  const invalid = structuredClone(delta.checkpoint)
  invalid.media[0].path = '../outside'
  assert.throws(
    () => validateCheckpoint(invalid, account),
    /attachment backup reference/,
  )
  invalid.media[0].path = 'media/..'
  assert.throws(
    () => validateCheckpoint(invalid, account),
    /attachment backup reference/,
  )
  invalid.media[0].path = 'media/asset.png'
  invalid.messages[0].backupId = 'missing-dependency'
  assert.throws(
    () => validateCheckpoint(invalid, account),
    /message backup reference/,
  )
  await assert.rejects(
    importCheckpoint(new File([first.blob], 'backup.zip'), fresh.account),
    /different Messenger account/,
  )
  const extracted = await importCheckpoint(
    new File([JSON.stringify(first.checkpoint)], 'checkpoint.json'),
    account,
  )
  assert.equal(extracted.backupId, first.checkpoint.backupId)
})

test('failed/cancelled exports and downloads retain data; finalization cleans only actual unchanged snapshots and rejects stale parents', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.put('meta', { key: 'pendingExport', snapshot: first.snapshot })
  await assert.rejects(
    archiveZip(db, account, undefined, () => true),
    { name: 'AbortError' },
  )
  assert.equal(await db.get('meta', 'checkpoint'), undefined)
  assert.equal((await db.storageUsage()).attachmentBytes, 3)
  // A replacement with identical size must not be removed by an older snapshot.
  await asset(db, 'asset', [4, 5, 6])
  await asset(db, 'unfinished', [7, 8])
  await db.saveMessage(record('old', 10, { text: 'changed after snapshot' }))
  await db.finalizeBackup(first.snapshot, {
    cleanup: true,
    retainMessages: false,
  })
  assert.equal((await db.get('media', 'asset')).status, 'saved')
  assert.equal((await db.get('media', 'unfinished')).status, 'saved')
  assert.equal(
    (await db.get('messages', record('old', 10).key)).text,
    'changed after snapshot',
  )
  assert.equal(await db.get('messages', record('boundary', 100).key), undefined)
  await assert.rejects(db.finalizeBackup(first.snapshot, { cleanup: true }))
  await db.cleanupExported({ messages: true })
  assert.equal((await db.storageUsage()).attachmentBytes, 5)
  const second = await prepare(db, account)
  assert.deepEqual(
    recordsIn(second.files).map((m) => m.id),
    ['old'],
  )
  await db.finalizeBackup(second.snapshot, {
    cleanup: true,
    retainMessages: false,
  })
  assert.equal((await db.storageUsage()).attachmentBytes, 0)
  assert.equal(await db.count('messages'), 0)
  assert.equal((await db.get('media', 'asset')).status, 'exported')
})

test('paused and failed scans retain their cursor across updates and checkpoint migration', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.finalizeBackup(first.snapshot)
  await db.beginUpdate([1000, null])
  await page(db, [record('new', 300)], [250, null])
  const partial = await db.get('threads', thread.jid)
  await db.put('threads', {
    ...partial,
    status: 'error',
    error: 'network failure',
  })
  await db.beginUpdate([2000, null])
  assert.deepEqual((await db.get('threads', thread.jid)).cursor, [250, null])
  assert.equal((await db.get('threads', thread.jid)).scanNewest, 300)
  assert.equal((await db.get('threads', thread.jid)).coveredThrough, 100)
  const delta = await prepare(db, account)
  assert.equal(delta.checkpoint.threads[0].coveredThrough, 100)
  assert.equal(delta.checkpoint.gaps.length, 1)
  await db.finalizeBackup(delta.snapshot)
  await db.clearLocal()
  await db.importBackup(delta.checkpoint)
  await db.beginUpdate([3000, null])
  assert.deepEqual((await db.get('threads', thread.jid)).cursor, [250, null])
  await page(
    db,
    [record('between', 200), record('boundary', 100), record('old', 10)],
    [11, null],
  )
  assert.equal((await db.get('threads', thread.jid)).coveredThrough, 300)
  const finished = await prepare(db, account)
  assert.equal(finished.checkpoint.gaps.length, 0)
  assert.deepEqual(
    recordsIn(finished.files).map((m) => m.id),
    ['between'],
  )
  await db.finalizeBackup(finished.snapshot)
  await db.beginUpdate([4000, null])
  assert.deepEqual((await db.get('threads', thread.jid)).cursor, [4000, null])
  await page(
    db,
    [record('newest', 600), record('new', 300), record('between', 200)],
    [201, null],
  )
  const next = await prepare(db, account)
  assert.deepEqual(
    recordsIn(next.files).map((m) => m.id),
    ['newest'],
  )
  assert.equal(next.checkpoint.threads[0].coveredThrough, 600)
})

test('new conversations collect their own full history, including messages older than the baseline', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.finalizeBackup(first.snapshot)
  await db.beginUpdate([1000, null])
  const discovered = { ...thread, jid: '456@msgr', id: '456' }
  await db.discover([thread, discovered], { complete: true })
  const oldMessage = {
    ...record('newly-found', 50),
    key: [discovered.jid, 'newly-found'],
    jid: discovered.jid,
  }
  await db.commitPage(await db.get('threads', discovered.jid), {
    records: [oldMessage],
    attachments: [],
    next: [49, null],
  })
  assert.equal((await db.get('threads', discovered.jid)).status, 'pending')
  assert.equal((await db.get('threads', discovered.jid)).coveredThrough, null)
  await db.commitPage(await db.get('threads', discovered.jid), {
    records: [],
    attachments: [],
    next: null,
  })
  assert.equal((await db.get('threads', discovered.jid)).coveredThrough, 50)
  const delta = await prepare(db, account)
  assert.deepEqual(
    recordsIn(delta.files).map((m) => m.id),
    ['newly-found'],
  )
  assert.equal(delta.checkpoint.threads.length, 2)
  await assert.rejects(
    archiveZip(db, 'another-account'),
    /different Messenger account/,
  )
})

test('ZIP import rejects missing current assets or messages, mismatched manifests, and damaged metadata', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  async function changedZip(omit, manifestOverride) {
    const zip = new Zip()
    for (const [path, bytes] of Object.entries(first.files)) {
      if (omit(path)) continue
      await zip.add(
        path,
        new Blob([
          path === 'manifest.json' && manifestOverride
            ? JSON.stringify(manifestOverride)
            : bytes,
        ]),
      )
    }
    return new File([zip.finish()], 'changed.zip')
  }
  await assert.rejects(
    importCheckpoint(await changedZip((p) => p.startsWith('media/')), account),
    /attachment entry missing/,
  )
  await assert.rejects(
    importCheckpoint(
      await changedZip((p) => p.endsWith('messages.ndjson')),
      account,
    ),
    /message entry missing/,
  )
  await assert.rejects(
    importCheckpoint(
      await changedZip(() => false, { ...first.manifest, backupId: 'wrong' }),
      account,
    ),
    /do not match/,
  )
  const corrupt = await changedZip(() => false)
  const bytes = new Uint8Array(await corrupt.arrayBuffer())
  // Damage checkpoint.json instead so importer must consume the affected entry.
  const { zipEntries } = await import('../src/import.js')
  const { entries } = await zipEntries(corrupt)
  const at = entries.get('checkpoint.json').local
  const header = new DataView(bytes.buffer, at)
  bytes[at + 30 + header.getUint16(26, true) + header.getUint16(28, true)] ^= 1
  await assert.rejects(
    importCheckpoint(new File([bytes], 'corrupt.zip'), account),
    /Corrupt ZIP metadata/,
  )
  await assert.rejects(
    importCheckpoint(
      new File(
        [JSON.stringify({ ...first.checkpoint, format: 'future/99' })],
        'checkpoint.json',
      ),
      account,
    ),
    /Unsupported/,
  )
})

test('an earlier exported representation and an unresolved replacement both survive checkpoint migration', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.finalizeBackup(first.snapshot, { cleanup: true })
  await db.saveMedia({
    id: 'asset',
    status: 'error',
    error: 'replacement failed',
    mediaEntry: { preserved: true },
  })
  const delta = await prepare(db, account)
  validateCheckpoint(delta.checkpoint, account)
  assert.equal(delta.checkpoint.media[0].backupId, first.checkpoint.backupId)
  assert.equal(delta.checkpoint.pendingMedia[0].error, 'replacement failed')
  await db.clearLocal()
  await db.importBackup(delta.checkpoint)
  assert.equal((await db.get('media', 'asset')).status, 'error')
  assert.equal((await db.get('media', 'asset')).mediaEntry.preserved, true)
  assert.equal(
    (await db.get('meta', 'checkpoint')).value.media[0].backupId,
    first.checkpoint.backupId,
  )
})

test('changed retained messages are included in the next delta by content hash', async (t) => {
  const { db, account } = await create(t)
  await baseline(db)
  const first = await prepare(db, account)
  await db.finalizeBackup(first.snapshot)
  const cached = await db.get('messages', record('old', 10).key)
  await db.repairPage(thread.jid, {
    records: [{ ...cached, text: 'repaired content' }],
    attachments: [],
  })
  const repaired = await db.get('messages', cached.key)
  assert.notEqual(
    await messageDigest(repaired),
    first.checkpoint.messages.find((m) => m.key[1] === 'old').hash,
  )
  const delta = await prepare(db, account)
  assert.deepEqual(
    recordsIn(delta.files).map((m) => m.text),
    ['repaired content'],
  )
  assert.equal(
    delta.checkpoint.messages.find((m) => m.key[1] === 'old').backupId,
    delta.checkpoint.backupId,
  )
})
