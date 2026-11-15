import {
  mediaMatches,
  messageDigest,
  messageKey,
  validateCheckpoint,
} from './checkpoint.js'
import {
  exportedMedia,
  removeMediaBytes,
  sameRevision,
  saveCheckpoint,
  updateRecord,
} from './storage.js'

// Backup receipts and cleanup share transactions; callers hold the account Web Lock.
export function backupState({
  account,
  db,
  get,
  write,
  rows,
  updateMediaIssue,
}) {
  async function importBackup(checkpoint) {
    validateCheckpoint(checkpoint, account)
    const previous = await get('meta', 'checkpoint')
    if (previous?.value.backupId === checkpoint.backupId) return
    if (previous)
      throw Error(
        'Local data already uses another checkpoint. Export unfinished work before deleting local data to import another backup chain.',
      )
    await write(
      ['meta', 'threads', 'messages', 'media', 'mediaIssues'],
      (tx) => {
        const parent = tx.objectStore('meta').get('checkpoint')
        parent.onsuccess = () => {
          if (parent.result) tx.abort()
        }
        saveCheckpoint(tx.objectStore('meta'), checkpoint)
        tx.objectStore('meta').put({
          key: 'inventory',
          ...checkpoint.inventory,
        })
        tx.objectStore('meta').put({ key: 'run', complete: true })
        for (const thread of checkpoint.threads)
          updateRecord(tx.objectStore('threads'), thread.jid, (old) => ({
            ...thread,
            ...old,
          }))
        for (const m of checkpoint.failures)
          updateRecord(tx.objectStore('messages'), m.key, (old) => {
            if (old) return
            updateMediaIssue(tx.objectStore('mediaIssues'), m)
            return {
              ...m,
              localRevision: crypto.randomUUID(),
            }
          })
        for (const m of checkpoint.media)
          updateRecord(tx.objectStore('media'), m.id, (old) => {
            if (!old) return exportedMedia(m, m)
          })
        for (const m of checkpoint.pendingMedia)
          updateRecord(tx.objectStore('media'), m.id, (old) => {
            if (!old || old.status === 'exported') return m
          })
      },
    )
  }
  async function finalizeBackup(
    snapshot,
    { cleanup = false, retainMessages = true, filename } = {},
  ) {
    validateCheckpoint(snapshot.checkpoint, account)
    const checkpoint = {
      ...snapshot.checkpoint,
      filename: filename?.split(/[\\/]/).at(-1),
    }
    const assets = new Map(checkpoint.media.map((m) => [m.id, m]))
    await write(['meta', 'messages', 'media', 'chunks'], (tx) => {
      const meta = tx.objectStore('meta')
      const parent = meta.get('checkpoint')
      parent.onsuccess = () => {
        if ((parent.result?.value.backupId || null) !== snapshot.parentId)
          tx.abort()
        else saveCheckpoint(meta, checkpoint)
      }
      if (!retainMessages)
        for (const record of snapshot.messages)
          updateRecord(tx.objectStore('messages'), record.key, (old) => {
            if (sameRevision(old, record) && !old.error) return null
          })
      if (cleanup)
        for (const job of snapshot.media)
          updateRecord(tx.objectStore('media'), job.id, (old) => {
            if (!sameRevision(old, job)) return
            removeMediaBytes(tx, job.id)
            return exportedMedia(old, assets.get(job.id))
          })
    })
  }
  async function cleanupExported({ messages = false } = {}) {
    const checkpoint = (await get('meta', 'checkpoint'))?.value
    if (!checkpoint) return
    const known = new Map(checkpoint.messages.map((m) => [messageKey(m), m]))
    const assets = new Map(checkpoint.media.map((m) => [m.id, m]))
    const removable = []
    if (messages)
      for await (const m of rows('messages'))
        if (
          !m.error &&
          known.get(messageKey(m))?.hash === (await messageDigest(m))
        )
          removable.push({ key: m.key, revision: m.localRevision })
    await write(['media', 'chunks', 'messages'], (tx) => {
      const req = tx.objectStore('media').openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return
        const job = cursor.value
        const reference = assets.get(job.id)
        if (job.status === 'saved' && mediaMatches(job, reference)) {
          cursor.update(exportedMedia(job, reference))
          removeMediaBytes(tx, job.id)
        }
        cursor.continue()
      }
      for (const m of removable)
        updateRecord(tx.objectStore('messages'), m.key, (old) => {
          if (sameRevision(old, m)) return null
        })
    })
  }
  async function storageUsage() {
    const checkpoint = (await get('meta', 'checkpoint'))?.value
    const assets = new Map((checkpoint?.media || []).map((m) => [m.id, m]))
    let attachmentBytes = 0,
      reclaimableBytes = 0
    for await (const chunk of rows('chunks')) attachmentBytes += chunk.blob.size
    for await (const job of rows('media'))
      if (job.status === 'saved' && mediaMatches(job, assets.get(job.id)))
        reclaimableBytes += job.size || 0
    return { attachmentBytes, reclaimableBytes }
  }
  async function clearLocal() {
    await write([...db.objectStoreNames], (tx) => {
      for (const name of db.objectStoreNames) tx.objectStore(name).clear()
    })
  }
  return {
    importBackup,
    finalizeBackup,
    cleanupExported,
    storageUsage,
    clearLocal,
  }
}
