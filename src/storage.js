// Keep transforms synchronous: IndexedDB transactions cannot await other work.
// undefined leaves a record unchanged; null deletes it.
export function updateRecord(store, key, transform) {
  const req = store.get(key)
  req.onsuccess = () => {
    const value = transform(req.result)
    if (value === null) store.delete(key)
    else if (value !== undefined) store.put(value)
  }
}
export const sameRevision = (record, snapshot) =>
  !!record && record.localRevision === snapshot.revision
export const mediaRange = (id) =>
  IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
export const removeMediaBytes = (tx, id) =>
  tx.objectStore('chunks').delete(mediaRange(id))
export function exportedMedia(job, reference) {
  return {
    ...job,
    backupId: reference.backupId,
    path: reference.path,
    status: 'exported',
  }
}
export function saveCheckpoint(meta, checkpoint) {
  meta.put({ key: 'checkpoint', value: checkpoint })
  meta.put({
    key: 'backupSummary',
    backupId: checkpoint.backupId,
    dependencies: checkpoint.dependencies.length,
  })
  meta.delete('pendingExport')
}
