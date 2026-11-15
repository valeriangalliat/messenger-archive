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
