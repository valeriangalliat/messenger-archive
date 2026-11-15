import {
  attachmentSource,
  attachmentSources,
  sourceKey,
} from './attachments.js'

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
function mediaIssue(message) {
  // Older archives predate the structured flag. Recognize their media warnings too.
  if (
    !message.unresolvedMedia &&
    !/^(Media could not be resolved without opening it|Attachment metadata missing);/.test(
      message.error || '',
    )
  )
    return null
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
    const req = store.get(id)
    req.onsuccess = () => {
      const primary = req.result || copies[0]
      const sources = new Map(
        attachmentSources(primary).map((s) => [sourceKey(s), s]),
      )
      for (const copy of copies)
        sources.set(sourceKey(copy), attachmentSource(copy))
      sources.delete(sourceKey(primary))
      store.put({
        ...primary,
        sources: [...sources.values()],
        status: primary.status || 'pending',
        error: primary.error || null,
      })
    }
  }
}
export async function openArchive(account, progress = () => {}) {
  const req = indexedDB.open(`messenger-archive-${account}`, 2)
  req.onblocked = () =>
    progress('Close other Messenger Archive tabs to finish opening saved data.')
  req.onupgradeneeded = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' })
      db.createObjectStore('threads', { keyPath: 'jid' })
      db.createObjectStore('messages', { keyPath: 'key' })
      db.createObjectStore('media', { keyPath: 'id' }).createIndex(
        'status',
        'status',
      )
      db.createObjectStore('chunks', { keyPath: 'key' })
    }
    const issues = db.createObjectStore('mediaIssues', { keyPath: 'key' })
    let scanned = 0
    const scan = req.transaction.objectStore('messages').openCursor()
    scan.onsuccess = () => {
      const cursor = scan.result
      if (!cursor) return
      if (++scanned % 2000 === 0)
        progress(`Updating saved messages… ${scanned.toLocaleString()} checked`)
      const issue = mediaIssue(cursor.value)
      if (issue) issues.put(issue)
      cursor.continue()
    }
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
  async function discover(threads, state) {
    await write(['threads', 'meta'], (tx) => {
      const store = tx.objectStore('threads')
      for (const item of threads) {
        const req = store.get(item.jid)
        req.onsuccess = () => {
          const old = req.result
          store.put({
            ...old,
            ...item,
            name: item.name === item.id && old?.name ? old.name : item.name,
            encrypted: old?.encrypted || item.encrypted,
            status:
              old?.status === 'unencrypted' && item.encrypted
                ? 'pending'
                : old?.status || (item.encrypted ? 'pending' : 'unencrypted'),
            cursor: old?.cursor || [Date.now() + 60000, null],
          })
        }
      }
      if (state) tx.objectStore('meta').put({ ...state, key: 'inventory' })
    })
  }
  async function commitPage(thread, page) {
    await write(['messages', 'media', 'threads', 'mediaIssues'], (tx) => {
      let delta = 0
      const messages = tx.objectStore('messages')
      for (const message of new Map(
        page.records.map((m) => [JSON.stringify(m.key), m]),
      ).values()) {
        const req = messages.get(message.key)
        req.onsuccess = () => {
          delta += Number(!!message.error) - Number(!!req.result?.error)
          messages.put(message)
          updateMediaIssue(tx.objectStore('mediaIssues'), message)
        }
      }
      mergeAttachments(tx.objectStore('media'), page.attachments)
      const req = tx.objectStore('threads').get(thread.jid)
      req.onsuccess = () => {
        const current = req.result || thread
        tx.objectStore('threads').put({
          ...current,
          cursor: page.next || thread.cursor,
          status: page.next ? 'pending' : 'reached-start',
          error: null,
          oldest: Math.min(
            current.oldest ?? Infinity,
            ...page.records.map((m) => m.timestamp),
          ),
          decodeErrors: Math.max(0, (current.decodeErrors || 0) + delta),
          pages: (current.pages || 0) + 1,
          updated: Date.now(),
        })
      }
    })
  }
  async function repairPage(jid, page) {
    await write(['messages', 'media', 'threads', 'mediaIssues'], (tx) => {
      let delta = 0
      const messages = tx.objectStore('messages'),
        media = tx.objectStore('media')
      for (const record of page.records) {
        if (record.jid !== jid) throw Error('Repair conversation mismatch.')
        const req = messages.get(record.key)
        req.onsuccess = () => {
          if (!req.result) {
            tx.abort()
            return
          }
          delta += Number(!!record.error) - Number(!!req.result.error)
          messages.put(record)
          updateMediaIssue(tx.objectStore('mediaIssues'), record)
        }
      }
      mergeAttachments(media, page.attachments)
      const req = tx.objectStore('threads').get(jid)
      req.onsuccess = () => {
        if (!req.result) {
          tx.abort()
          return
        }
        tx.objectStore('threads').put({
          ...req.result,
          decodeErrors: Math.max(0, (req.result.decodeErrors || 0) + delta),
        })
      }
    })
  }
  async function beginMedia(job) {
    await write(['media', 'chunks'], (tx) => {
      tx.objectStore('chunks').delete(
        IDBKeyRange.bound([job.id, 0], [job.id, Number.MAX_SAFE_INTEGER]),
      )
      tx.objectStore('media').put({ ...job, status: 'pending', error: null })
    })
  }
  async function mediaBlob(job) {
    const chunks = await request(
      db
        .transaction('chunks')
        .objectStore('chunks')
        .getAll(
          IDBKeyRange.bound([job.id, 0], [job.id, Number.MAX_SAFE_INTEGER]),
        ),
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
  return {
    db,
    get,
    all,
    put,
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
