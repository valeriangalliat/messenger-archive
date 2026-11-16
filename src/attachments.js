const representationFields = (record) => {
  const result = { ...record }
  for (const key of ['representation', 'requestedRepresentation']) {
    if (result[key] === 'native-preview') result[key] = 'preview'
    else if (result[key] === 'full-fallback') result[key] = 'full'
  }
  return result
}
// Normalize metadata at export; an active run can keep writing the old labels.
export function normalizeAttachment(record) {
  const result = representationFields(record)
  if (Array.isArray(record.downloadAttempts))
    result.downloadAttempts = record.downloadAttempts.map(representationFields)
  return result
}
// Source metadata travels together: a forwarded copy can have a different author or chat.
export function attachmentSource(job) {
  const {
    id,
    jid,
    messageId,
    timestamp,
    expectedHash,
    filename,
    mediaKind,
    mediaEntry,
    protocolMsgId,
  } = job
  return {
    id,
    jid,
    messageId,
    timestamp,
    expectedHash,
    filename,
    mediaKind,
    mediaEntry,
    protocolMsgId,
  }
}
export const sourceKey = (job) =>
  JSON.stringify([
    job.jid,
    job.messageId,
    job.timestamp,
    job.mediaEntry,
    job.protocolMsgId,
  ])
export function attachmentSources(job) {
  return [
    ...new Map(
      [...(job.sources || []), job].map((source) => [
        sourceKey(source),
        attachmentSource(source),
      ]),
    ).values(),
  ]
}
