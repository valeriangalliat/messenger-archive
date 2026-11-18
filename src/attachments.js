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
// Only current attachment fields belong in portable metadata.
export function attachmentMetadata(job) {
  const {
    sources,
    status,
    size,
    mime,
    nativeMime,
    sha256,
    localRevision,
    savedAt,
    backupId,
    path,
    error,
    nativeCode,
    downloadAttempts,
  } = job
  return {
    ...attachmentSource(job),
    sources: sources?.map(attachmentSource),
    status,
    size,
    mime,
    nativeMime,
    sha256,
    localRevision,
    savedAt,
    backupId,
    path,
    error,
    nativeCode,
    downloadAttempts: downloadAttempts?.map(
      ({
        at,
        operation,
        jid,
        messageId,
        timestamp,
        error,
        code,
        nativeCode,
      }) => ({
        at,
        operation,
        jid,
        messageId,
        timestamp,
        error,
        code,
        nativeCode,
      }),
    ),
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
