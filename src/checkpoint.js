// Portable metadata only: media bytes remain in the baseline and delta ZIPs.
export const checkpointFormat = 'messenger-archive-checkpoint/1'
export const messageKey = (m) => JSON.stringify(m.key)
// Local cache markers and display names are not part of a message's content.
export function messageContent(message) {
  const { localRevision, senderName, ...record } = message
  return record
}
export async function messageDigest(message) {
  const text = JSON.stringify(messageContent(message), (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  )
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
}
export const mediaPath = (job) =>
  `media/${globalThis.MessengerArchiveCore.filename(job.id, job.mime)}`
export const mediaMatches = (job, reference) =>
  !!job.sha256 &&
  job.sha256 === reference?.sha256 &&
  job.size === reference.size
export function validateCheckpoint(value, account) {
  if (
    value?.format !== checkpointFormat ||
    typeof value.backupId !== 'string' ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.threads) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.media) ||
    !Array.isArray(value.failures) ||
    !Array.isArray(value.pendingMedia)
  )
    throw Error('Unsupported or incomplete portable checkpoint.')
  if (String(value.account) !== String(account))
    throw Error('Backup belongs to a different Messenger account.')
  const backups = new Set([
    ...value.dependencies.map((d) => d.backupId),
    value.backupId,
  ])
  if (
    [...backups].some((id) => typeof id !== 'string' || !id) ||
    backups.size !== value.dependencies.length + 1
  )
    throw Error('Duplicate backup identifiers in checkpoint.')
  const jids = new Set(value.threads.map((t) => t.jid))
  if (jids.size !== value.threads.length)
    throw Error('Duplicate conversations in checkpoint.')
  const keys = new Set(),
    assets = new Set()
  for (const t of value.threads)
    if (
      !t.jid ||
      (t.coveredThrough != null &&
        (!Number.isSafeInteger(t.coveredThrough) || t.coveredThrough < 0))
    )
      throw Error('Invalid conversation coverage boundary.')
  for (const m of value.messages) {
    if (
      !Array.isArray(m.key) ||
      m.key.length !== 2 ||
      typeof m.key[1] !== 'string' ||
      !jids.has(m.key[0]) ||
      !/^[a-f0-9]{64}$/.test(m.hash || '') ||
      !backups.has(m.backupId) ||
      keys.has(messageKey(m))
    )
      throw Error('Invalid message backup reference.')
    keys.add(messageKey(m))
  }
  for (const m of value.media) {
    if (
      !m.id ||
      !backups.has(m.backupId) ||
      !/^media\/(?!\.{1,2}$)[^/\\]+$/.test(m.path || '') ||
      (m.path || '').includes(String.fromCharCode(0)) ||
      assets.has(m.id)
    )
      throw Error('Invalid attachment backup reference.')
    assets.add(m.id)
  }
  for (const m of value.failures)
    if (!m.error || !keys.has(messageKey(m)) || m.jid !== m.key[0])
      throw Error('Invalid retryable message.')
  const pending = new Set()
  for (const m of value.pendingMedia) {
    if (!m.id || pending.has(m.id) || ['saved', 'exported'].includes(m.status))
      throw Error('Invalid unfinished attachment.')
    pending.add(m.id)
  }
  return value
}
export async function makeCheckpoint(
  archive,
  account,
  backupId,
  included,
  threads,
  media,
  value,
) {
  const messages = new Map(
    (value?.messages || []).map((m) => [messageKey(m), m]),
  )
  for (const m of included)
    messages.set(messageKey(m), { key: m.key, hash: m.hash, backupId })
  const assets = new Map((value?.media || []).map((m) => [m.id, m]))
  for (const job of media)
    if (job.status === 'saved' && !mediaMatches(job, assets.get(job.id)))
      assets.set(job.id, {
        id: job.id,
        expectedHash: job.expectedHash,
        size: job.size,
        mime: job.mime,
        nativeMime: job.nativeMime,
        sha256: job.sha256,
        representation: job.representation,
        requestedRepresentation: job.requestedRepresentation,
        fallbackReason: job.fallbackReason,
        verification: job.verification,
        status: 'exported',
        backupId,
        path: mediaPath(job),
      })
  const failures = []
  // Keep raw failed records so a laptop migration can retry decode/metadata errors.
  for await (const m of archive.rows('messages'))
    if (m.error) failures.push(messageContent(m))
  return {
    format: checkpointFormat,
    account: String(account),
    backupId,
    dependencies: value
      ? [
          ...value.dependencies,
          { backupId: value.backupId, filename: value.filename || null },
        ]
      : [],
    createdAt: new Date().toISOString(),
    coverageScope:
      'Encrypted conversations only; boundaries describe fetched message history, with decode and media failures listed separately.',
    gaps: threads
      .filter((t) => t.encrypted && t.status !== 'reached-start')
      .map((t) => ({
        jid: t.jid,
        cursor: t.cursor,
        coveredThrough: t.coveredThrough ?? null,
        error: t.error || null,
      })),
    threads: threads.map(({ directory, ...t }) => t),
    inventory: await archive.get('meta', 'inventory'),
    messages: [...messages.values()],
    media: [...assets.values()],
    failures,
    pendingMedia: media.filter(
      (m) => !['saved', 'exported'].includes(m.status),
    ),
  }
}
