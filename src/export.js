import {
  makeCheckpoint,
  mediaMatches,
  mediaPath,
  messageContent,
  messageDigest,
  messageKey,
} from './checkpoint.js'
import { Zip } from './zip.js'

const encoder = new TextEncoder()
const component = (text) =>
  String(text)
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .slice(0, 90) || 'conversation'
export async function archiveZip(
  archive,
  account,
  progress = () => {},
  cancelled = () => false,
  prepared = () => {},
  { standalone = false } = {},
) {
  if (archive.account && String(account) !== archive.account)
    throw Error('Archive belongs to a different Messenger account.')
  const check = () => {
    if (cancelled())
      throw new DOMException(
        'Export paused. Saved browser data is unchanged.',
        'AbortError',
      )
  }
  const zip = new Zip(check)
  const [
    threads,
    media,
    contacts,
    inventory,
    expectedMessages,
    unresolvedMedia,
  ] = await Promise.all([
    archive.all('threads'),
    archive.all('media'),
    archive.get('meta', 'names'),
    archive.get('meta', 'inventory'),
    archive.count('messages'),
    archive.all('mediaIssues'),
  ])
  const parent = (await archive.get('meta', 'checkpoint'))?.value
  const previous = standalone ? null : parent
  if (standalone && parent) {
    const localAssets = new Map(media.map((job) => [job.id, job]))
    if (
      parent.media.some((item) => localAssets.get(item.id)?.status !== 'saved')
    )
      throw Error(
        'Some attachments are only in earlier ZIPs. The browser cannot create a complete standalone ZIP.',
      )
  }
  const known = new Map(
    (previous?.messages || []).map((m) => [messageKey(m), m]),
  )
  const assets = new Map((previous?.media || []).map((m) => [m.id, m]))
  const backupId = crypto.randomUUID()
  const included = []
  const messageSnapshot = []
  const names = { ...parent?.names, ...contacts?.value }
  for (const t of threads)
    if (
      t.jid === `${t.id}@msgr` &&
      t.name &&
      t.name !== t.id &&
      (!names[t.id] || names[t.id] === t.id)
    )
      names[t.id] = t.name
  let messages = 0
  const json = (path, value) =>
    zip.add(path, new Blob([JSON.stringify(value, null, 2)]), true)
  for (const [index, thread] of threads.entries()) {
    check()
    thread.directory = `threads/${component(thread.name || thread.id)}_${component(thread.jid)}`
    progress(
      `Packing conversation ${index + 1}/${threads.length}: ${thread.name}`,
    )
    await json(`${thread.directory}/thread.json`, thread)
    const rows = async function* () {
      let chunk = ''
      for await (const message of archive.rows('messages', thread.jid)) {
        check()
        messages++
        const record = {
          key: message.key,
          hash: await messageDigest(message),
          revision: message.localRevision,
        }
        messageSnapshot.push(record)
        if (known.get(messageKey(message))?.hash === record.hash) continue
        included.push(record)
        chunk += `${JSON.stringify({
          ...messageContent(message),
          senderName: names[message.senderId] || message.senderId,
        })}\n`
        if (chunk.length >= 262144) {
          yield encoder.encode(chunk)
          chunk = ''
        }
      }
      if (chunk) yield encoder.encode(chunk)
    }
    const iterator = rows()
    const stream = new ReadableStream({
      async pull(out) {
        const next = await iterator.next()
        if (next.done) out.close()
        else out.enqueue(next.value)
      },
      cancel() {
        return iterator.return()
      },
    })
    await zip.add(`${thread.directory}/messages.ndjson`, stream, true)
  }
  if (messages !== expectedMessages)
    throw Error(
      'Message count changed or conversation records are missing. Retry export.',
    )
  if (standalone && parent) {
    const localMessages = new Set(messageSnapshot.map(messageKey))
    if (parent.messages.some((m) => !localMessages.has(messageKey(m))))
      throw Error(
        'Some messages are only in earlier ZIPs. The browser cannot create a complete standalone ZIP.',
      )
  }
  await json('threads.json', threads)
  await json('contacts.json', names)
  const saved = media.filter(
    (job) => job.status === 'saved' && !mediaMatches(job, assets.get(job.id)),
  )
  for (const [index, job] of saved.entries()) {
    check()
    if (index % 25 === 0)
      progress(`Packing attachment ${index + 1}/${saved.length}…`)
    job.path = mediaPath(job)
    await zip.add(job.path, await archive.mediaBlob(job))
  }
  const checkpoint = await makeCheckpoint(
    archive,
    account,
    backupId,
    included,
    threads,
    media,
    previous,
    names,
  )
  await json('checkpoint.json', checkpoint)
  const references = new Map(checkpoint.media.map((m) => [m.id, m]))
  await json(
    'attachments.json',
    media.map((job) => {
      const reference = references.get(job.id)
      return reference
        ? {
            ...job,
            backupId: reference.backupId,
            path: reference.path,
            availability:
              reference.backupId === backupId
                ? 'this-backup'
                : 'earlier-backup',
          }
        : job
    }),
  )
  await json('manifest.json', {
    format: 'messenger-archive/3',
    backupId,
    dependencies: checkpoint.dependencies,
    checkpoint: 'checkpoint.json',
    exportComplete: true,
    account,
    exportedAt: new Date().toISOString(),
    inventory,
    messages: included.length,
    cachedMessages: messages,
    threads: threads.length,
    attachmentsSaved: saved.length,
    historyFailures: threads
      .filter((t) => t.error)
      .map((t) => ({ jid: t.jid, error: t.error })),
    contactNameFailures: threads
      .filter((t) => t.nameError)
      .map((t) => ({ jid: t.jid, error: t.nameError })),
    decodeIssues: threads
      .filter((t) => t.decodeErrors)
      .map((t) => ({ jid: t.jid, count: t.decodeErrors })),
    attachmentFailures: media
      .filter((m) => !['saved', 'exported'].includes(m.status))
      .map((m) => ({ id: m.id, error: m.error })),
    unresolvedMediaMessages: unresolvedMedia.length,
    unresolvedMedia,
    coverage:
      'Encrypted conversations only. Unencrypted history is not included.',
  })
  progress('Preparing download…')
  const blob = zip.finish()
  // Caller holds the account lock through download completion and finalization.
  // Record revisions bind cleanup to the bytes and messages packed in this ZIP.
  const snapshot = {
    parentId: parent?.backupId || null,
    checkpoint,
    messages: messageSnapshot,
    media: media
      .filter((m) => m.status === 'saved')
      .map((m) => ({ id: m.id, revision: m.localRevision })),
  }
  await prepared(snapshot)
  return blob
}
