import {
  attachmentSource,
  attachmentSources,
  sourceKey,
} from './attachments.js'
import { backupState } from './backup-state.js'
import { messageKey } from './checkpoint.js'
import { mediaRange, removeMediaBytes, updateRecord } from './storage.js'

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
function mediaIssue(message) {
  if (!message.unresolvedMedia) return null
  return {
    key: message.key,
    jid: message.jid,
    messageId: message.id ?? message.key[1],
    timestamp: message.timestamp,
    type: message.type,
    error: message.error,
    receiverFetchInfo: message.decoded?.receiverFetchInfo,
  }
}
function updateMediaIssue(store, message) {
  const issue = mediaIssue(message)
  if (issue) store.put(issue)
  else store.delete(message.key)
}
function mergeAttachments(store, jobs) {
  const groups = new Map()
  for (const job of jobs) {
    if (!groups.has(job.id)) groups.set(job.id, [])
    groups.get(job.id).push(job)
  }
  for (const [id, copies] of groups) {
    updateRecord(store, id, (old) => {
      const primary = old || copies[0]
      const sources = new Map(
        attachmentSources(primary).map((s) => [sourceKey(s), s]),
      )
      for (const copy of copies)
        sources.set(sourceKey(copy), attachmentSource(copy))
      sources.delete(sourceKey(primary))
      return {
        ...primary,
        localRevision: crypto.randomUUID(),
        sources: [...sources.values()],
        status: primary.status || 'pending',
        error: primary.error || null,
      }
    })
  }
}
function historyProgress(thread, page) {
  const timestamps = page.records
    .map((m) => m.timestamp)
    .filter(Number.isSafeInteger)
  const newest = timestamps.length
    ? Math.max(thread.scanNewest ?? 0, ...timestamps)
    : thread.scanNewest
  // Consume every message at the boundary millisecond before joining coverage.
  const stopAt = thread.coveredThrough
  const complete =
    !page.next || (stopAt != null && timestamps.some((t) => t < stopAt))
  return {
    cursor: page.next || thread.cursor,
    status: complete ? 'reached-start' : 'pending',
    scanNewest: newest,
    coveredThrough: complete
      ? Math.max(thread.coveredThrough ?? 0, newest ?? 0) || null
      : (thread.coveredThrough ?? null),
    error: null,
    oldest: Math.min(thread.oldest ?? Infinity, ...timestamps),
    pages: (thread.pages || 0) + 1,
    updated: Date.now(),
  }
}
export async function openArchive(account, progress = () => {}) {
  const req = indexedDB.open(`messenger-archive-${account}`, 2)
  req.onblocked = () =>
    progress('Close other Messenger Archive tabs to finish opening saved data.')
  req.onupgradeneeded = ({ oldVersion }) => {
    if (oldVersion !== 0) {
      req.transaction.abort()
      return
    }
    const db = req.result
    db.createObjectStore('meta', { keyPath: 'key' })
    db.createObjectStore('threads', { keyPath: 'jid' })
    db.createObjectStore('messages', { keyPath: 'key' })
    db.createObjectStore('media', { keyPath: 'id' }).createIndex(
      'status',
      'status',
    )
    db.createObjectStore('chunks', { keyPath: 'key' })
    db.createObjectStore('mediaIssues', { keyPath: 'key' })
  }
  const db = await request(req)
  db.onversionchange = () => db.close()
  const write = (stores, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      tx.oncomplete = resolve
      tx.onabort = tx.onerror = () =>
        reject(tx.error || Error('Archive transaction aborted.'))
      try {
        fn(tx)
      } catch (e) {
        tx.abort()
        reject(e)
      }
    })
  const get = (store, key) =>
    request(db.transaction(store).objectStore(store).get(key))
  const all = (store) =>
    request(db.transaction(store).objectStore(store).getAll())
  const put = (store, value) =>
    write([store], (tx) => tx.objectStore(store).put(value))
  const saveMessage = (message) =>
    put('messages', { ...message, localRevision: crypto.randomUUID() })
  const saveMedia = (job) =>
    put('media', { ...job, localRevision: crypto.randomUUID() })
  async function discover(threads, state) {
    await write(['threads', 'meta'], (tx) => {
      const store = tx.objectStore('threads')
      for (const item of threads) {
        updateRecord(store, item.jid, (old) => ({
          ...old,
          ...item,
          name: item.name === item.id && old?.name ? old.name : item.name,
          encrypted: old?.encrypted || item.encrypted,
          status:
            old?.status === 'unencrypted' && item.encrypted
              ? 'pending'
              : old?.status || (item.encrypted ? 'pending' : 'unencrypted'),
          cursor: old?.cursor || [Date.now() + 60000, null],
        }))
      }
      if (state) tx.objectStore('meta').put({ ...state, key: 'inventory' })
    })
  }
  function savePage(thread, page, repair = false) {
    return write(['messages', 'media', 'threads', 'mediaIssues'], (tx) => {
      let delta = 0
      const messages = tx.objectStore('messages')
      for (const record of new Map(
        page.records.map((m) => [messageKey(m), m]),
      ).values()) {
        if (repair && record.jid !== thread.jid)
          throw Error('Repair conversation mismatch.')
        updateRecord(messages, record.key, (old) => {
          if (repair && !old) {
            tx.abort()
            return
          }
          delta += Number(!!record.error) - Number(!!old?.error)
          updateMediaIssue(tx.objectStore('mediaIssues'), record)
          return {
            ...record,
            localRevision: crypto.randomUUID(),
          }
        })
      }
      mergeAttachments(tx.objectStore('media'), page.attachments)
      updateRecord(tx.objectStore('threads'), thread.jid, (old) => {
        if (repair && !old) {
          tx.abort()
          return
        }
        const current = old || thread
        return {
          ...current,
          ...(repair ? {} : historyProgress(current, page)),
          decodeErrors: Math.max(0, (current.decodeErrors || 0) + delta),
        }
      })
    })
  }
  const commitPage = (thread, page) => savePage(thread, page)
  const repairPage = (jid, page) => savePage({ jid }, page, true)
  async function beginMedia(job) {
    await write(['media', 'chunks'], (tx) => {
      removeMediaBytes(tx, job.id)
      tx.objectStore('media').put({
        ...job,
        localRevision: crypto.randomUUID(),
        status: 'pending',
        backupId: undefined,
        path: undefined,
        error: null,
      })
    })
  }
  async function mediaBlob(job) {
    if (job.status === 'exported')
      throw Error(
        'Attachment bytes are in an earlier backup, not in browser storage.',
      )
    const chunks = await request(
      db.transaction('chunks').objectStore('chunks').getAll(mediaRange(job.id)),
    )
    const blob = new Blob(
      chunks.map((c) => c.blob),
      { type: job.mime },
    )
    if (blob.size !== job.size)
      throw Error(
        'Saved attachment chunks are incomplete. Retry this attachment.',
      )
    return blob
  }
  // Read at most 250 records at a time; large histories do not need getAll().
  async function* rows(storeName, jid) {
    let after
    for (;;) {
      const batch = await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName),
          store = tx.objectStore(storeName)
        const range =
          jid == null
            ? after === undefined
              ? undefined
              : IDBKeyRange.lowerBound(after, true)
            : IDBKeyRange.bound(
                after ?? [jid],
                [jid, []],
                after !== undefined,
                true,
              )
        const req = store.openCursor(range)
        const result = []
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return resolve(result)
          result.push({ value: cursor.value, key: cursor.primaryKey })
          if (result.length === 250) resolve(result)
          else cursor.continue()
        }
      })
      if (!batch.length) return
      for (const item of batch) yield item.value
      after = batch.at(-1).key
      if (batch.length < 250) return
    }
  }
  async function beginUpdate(cursor) {
    await write(['threads', 'meta'], (tx) => {
      const meta = tx.objectStore('meta')
      meta.put({ key: 'run', complete: false })
      meta.put({
        key: 'inventory',
        cursor: '9223372036854775807',
        complete: false,
        pages: 0,
      })
      const req = tx.objectStore('threads').openCursor()
      req.onsuccess = () => {
        const c = req.result
        if (!c) return
        const t = c.value
        // Finish an interrupted scan before starting a new one for this chat.
        if (t.encrypted && t.status === 'reached-start') {
          c.update({
            ...t,
            status: 'pending',
            cursor,
            scanNewest: null,
            pages: 0,
            error: null,
          })
        }
        c.continue()
      }
    })
  }
  return {
    db,
    account: String(account),
    ...backupState({
      account,
      db,
      get,
      write,
      rows,
      updateMediaIssue,
    }),
    beginUpdate,
    get,
    all,
    put,
    saveMessage,
    saveMedia,
    discover,
    commitPage,
    repairPage,
    beginMedia,
    mediaBlob,
    rows,
    count: (store, index, key) =>
      request(
        index
          ? db
              .transaction(store)
              .objectStore(store)
              .index(index)
              .count(IDBKeyRange.only(key))
          : db.transaction(store).objectStore(store).count(),
      ),
    saveChunk: (id, offset, bytes) =>
      put('chunks', { key: [id, offset], blob: new Blob([bytes]) }),
  }
}
