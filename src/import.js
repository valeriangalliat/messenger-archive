import { validateCheckpoint } from './checkpoint.js'

// Read the directory and selected metadata entries, never the archive's media.
const view = async (blob) => new DataView(await blob.arrayBuffer())
const number64 = (v, at) => {
  const n = Number(v.getBigUint64(at, true))
  if (!Number.isSafeInteger(n))
    throw Error('ZIP offset exceeds supported range.')
  return n
}
export async function zipEntries(file) {
  const tailAt = Math.max(0, file.size - 65557)
  const tail = await view(file.slice(tailAt))
  let end = tail.byteLength - 22
  while (end >= 0 && tail.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw Error('ZIP directory not found.')
  let offset = tail.getUint32(end + 16, true)
  let size = tail.getUint32(end + 12, true)
  if (offset === 0xffffffff || size === 0xffffffff) {
    const locator = await view(file.slice(tailAt + end - 20, tailAt + end))
    if (locator.getUint32(0, true) !== 0x07064b50)
      throw Error('ZIP64 locator missing.')
    const at = number64(locator, 8)
    const record = await view(file.slice(at, at + 56))
    size = number64(record, 40)
    offset = number64(record, 48)
  }
  const directory = await view(file.slice(offset, offset + size))
  const entries = new Map(),
    decoder = new TextDecoder()
  for (let at = 0; at < size; ) {
    if (directory.getUint32(at, true) !== 0x02014b50)
      throw Error('Invalid ZIP directory.')
    const nameSize = directory.getUint16(at + 28, true),
      extraSize = directory.getUint16(at + 30, true)
    const name = decoder.decode(
      new Uint8Array(directory.buffer, at + 46, nameSize),
    )
    let compressed = directory.getUint32(at + 20, true),
      uncompressed = directory.getUint32(at + 24, true),
      local = directory.getUint32(at + 42, true)
    for (let e = at + 46 + nameSize; e < at + 46 + nameSize + extraSize; ) {
      const kind = directory.getUint16(e, true),
        length = directory.getUint16(e + 2, true)
      if (kind === 1) {
        let p = e + 4
        if (uncompressed === 0xffffffff) {
          uncompressed = number64(directory, p)
          p += 8
        }
        if (compressed === 0xffffffff) {
          compressed = number64(directory, p)
          p += 8
        }
        if (local === 0xffffffff) local = number64(directory, p)
      }
      e += length + 4
    }
    if (entries.has(name)) throw Error('Duplicate ZIP entry.')
    entries.set(name, {
      local,
      compressed,
      method: directory.getUint16(at + 10, true),
      crc: directory.getUint32(at + 16, true),
      uncompressed,
    })
    at += 46 + nameSize + extraSize + directory.getUint16(at + 32, true)
  }
  async function stream(name) {
    const entry = entries.get(name)
    if (!entry) throw Error(`Missing ZIP entry: ${name}`)
    const local = await view(file.slice(entry.local, entry.local + 30))
    if (local.getUint32(0, true) !== 0x04034b50)
      throw Error('Invalid ZIP entry header.')
    const start =
      entry.local + 30 + local.getUint16(26, true) + local.getUint16(28, true)
    let output = file.slice(start, start + entry.compressed).stream()
    if (entry.method === 8)
      output = output.pipeThrough(new DecompressionStream('deflate-raw'))
    else if (entry.method !== 0) throw Error('Unsupported ZIP compression.')
    let crc = 0xffffffff,
      count = 0
    return output.pipeThrough(
      new TransformStream({
        transform(bytes, out) {
          count += bytes.length
          for (const byte of bytes) {
            crc ^= byte
            for (let i = 0; i < 8; i++)
              crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
          }
          out.enqueue(bytes)
        },
        flush() {
          if (
            count !== entry.uncompressed ||
            (crc ^ 0xffffffff) >>> 0 !== entry.crc
          )
            throw Error(`Corrupt ZIP metadata: ${name}`)
        },
      }),
    )
  }
  return {
    entries,
    stream,
    json: async (name) =>
      JSON.parse(await new Response(await stream(name)).text()),
  }
}
export async function importCheckpoint(file, account) {
  if (!/\.zip$/i.test(file.name || ''))
    return validateCheckpoint(JSON.parse(await file.text()), account)
  const zip = await zipEntries(file)
  if (!zip.entries.has('checkpoint.json'))
    throw Error('Unsupported backup ZIP: checkpoint.json is required.')
  const checkpoint = validateCheckpoint(
    { ...(await zip.json('checkpoint.json')), filename: file.name },
    account,
  )
  const manifest = await zip.json('manifest.json')
  if (
    manifest.format !== 'messenger-archive/3' ||
    manifest.backupId !== checkpoint.backupId ||
    String(manifest.account) !== String(account)
  )
    throw Error('ZIP manifest and checkpoint do not match.')
  for (const m of checkpoint.media)
    if (
      m.backupId === checkpoint.backupId &&
      (!zip.entries.has(m.path) ||
        zip.entries.get(m.path).uncompressed !== m.size)
    )
      throw Error('Checkpoint attachment entry missing or size changed.')
  const threads = await zip.json('threads.json')
  const jids = new Set(threads.map((t) => t.jid))
  if (checkpoint.threads.some((t) => !jids.has(t.jid)))
    throw Error('Checkpoint conversation index is incomplete.')
  for (const thread of threads)
    if (!zip.entries.has(`${thread.directory}/messages.ndjson`))
      throw Error('Checkpoint message entry missing.')
  return checkpoint
}
