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
) {
  const check = () => {
    if (cancelled())
      throw new DOMException(
        'Export paused. Saved browser data is unchanged.',
        'AbortError',
      )
  }
  const zip = new Zip(check),
    C = globalThis.MessengerArchiveCore
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
  const names = contacts?.value || {}
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
        chunk += `${JSON.stringify({
          ...message,
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
  await json('threads.json', threads)
  const saved = media.filter((job) => job.status === 'saved')
  for (const [index, job] of saved.entries()) {
    check()
    if (index % 25 === 0)
      progress(`Packing attachment ${index + 1}/${saved.length}…`)
    job.path = `media/${C.filename(job.id, job.mime)}`
    await zip.add(job.path, await archive.mediaBlob(job))
  }
  await json('attachments.json', media)
  await json('manifest.json', {
    format: 'messenger-archive/2',
    exportComplete: true,
    account,
    exportedAt: new Date().toISOString(),
    inventory,
    messages,
    threads: threads.length,
    attachmentsSaved: saved.length,
    historyFailures: threads
      .filter((t) => t.error)
      .map((t) => ({ jid: t.jid, error: t.error })),
    decodeIssues: threads
      .filter((t) => t.decodeErrors)
      .map((t) => ({ jid: t.jid, count: t.decodeErrors })),
    attachmentFailures: media
      .filter((m) => m.status !== 'saved')
      .map((m) => ({ id: m.id, error: m.error })),
    unresolvedMediaMessages: unresolvedMedia.length,
    unresolvedMedia,
    coverage:
      'Encrypted conversations only. Unencrypted history is not included.',
  })
  progress('Preparing download…')
  return zip.finish()
}
