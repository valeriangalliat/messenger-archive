// ZIP64 container; raw DEFLATE comes from the browser. No archive-sized byte array.
// Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
const header = (length) => new DataView(new ArrayBuffer(length))
const bytes = (view) => new Uint8Array(view.buffer)
export class Zip {
  constructor(check = () => {}) {
    this.check = check
    this.parts = []
    this.directory = []
    this.offset = 0
    this.directorySize = 0
    this.names = new Set()
    this.finished = false
  }
  async add(name, source, compress = false) {
    this.check()
    if (this.finished) throw Error('ZIP is already finished.')
    const path = encoder.encode(name)
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((s) => !s || s === '.' || s === '..') ||
      path.length > 65535 ||
      this.names.has(name)
    )
      throw Error('Invalid or duplicate ZIP path.')
    this.names.add(name)
    let crc = 0xffffffff,
      size = 0
    const measure = (chunk) => {
      this.check()
      size += chunk.byteLength
      for (let i = 0; i < chunk.length; i++)
        crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8)
    }
    let data
    if (compress) {
      const stream = source instanceof Blob ? source.stream() : source
      data = await new Response(
        stream
          .pipeThrough(
            new TransformStream({
              transform(chunk, out) {
                measure(chunk)
                out.enqueue(chunk)
              },
            }),
          )
          .pipeThrough(new CompressionStream('deflate-raw')),
      ).blob()
    } else {
      if (!(source instanceof Blob))
        throw Error('Uncompressed ZIP entries must be Blobs.')
      for await (const chunk of source.stream()) measure(chunk)
      data = source // Retain the existing disk-backed Blob instead of copying its bytes.
    }
    this.check()
    crc = (crc ^ 0xffffffff) >>> 0
    const method = compress ? 8 : 0,
      local = header(30),
      extra = header(20)
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 45, true)
    local.setUint16(6, 0x800, true)
    local.setUint16(8, method, true)
    local.setUint16(12, 33, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, 0xffffffff, true)
    local.setUint32(22, 0xffffffff, true)
    local.setUint16(26, path.length, true)
    local.setUint16(28, 20, true)
    extra.setUint16(0, 1, true)
    extra.setUint16(2, 16, true)
    extra.setBigUint64(4, BigInt(size), true)
    extra.setBigUint64(12, BigInt(data.size), true)
    const central = header(46),
      centralExtra = header(28)
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 45, true)
    central.setUint16(6, 45, true)
    central.setUint16(8, 0x800, true)
    central.setUint16(10, method, true)
    central.setUint16(14, 33, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, 0xffffffff, true)
    central.setUint32(24, 0xffffffff, true)
    central.setUint16(28, path.length, true)
    central.setUint16(30, 28, true)
    central.setUint32(42, 0xffffffff, true)
    centralExtra.setUint16(0, 1, true)
    centralExtra.setUint16(2, 24, true)
    centralExtra.setBigUint64(4, BigInt(size), true)
    centralExtra.setBigUint64(12, BigInt(data.size), true)
    centralExtra.setBigUint64(20, BigInt(this.offset), true)
    this.parts.push(bytes(local), path, bytes(extra), data)
    this.directory.push(bytes(central), path, bytes(centralExtra))
    this.offset += 30 + path.length + 20 + data.size
    this.directorySize += 46 + path.length + 28
    return { size, compressedSize: data.size }
  }
  finish() {
    this.check()
    if (this.finished) throw Error('ZIP is already finished.')
    this.finished = true
    const end64 = header(56),
      locator = header(20),
      end = header(22),
      count = this.names.size
    end64.setUint32(0, 0x06064b50, true)
    end64.setBigUint64(4, 44n, true)
    end64.setUint16(12, 45, true)
    end64.setUint16(14, 45, true)
    end64.setBigUint64(24, BigInt(count), true)
    end64.setBigUint64(32, BigInt(count), true)
    end64.setBigUint64(40, BigInt(this.directorySize), true)
    end64.setBigUint64(48, BigInt(this.offset), true)
    locator.setUint32(0, 0x07064b50, true)
    locator.setBigUint64(8, BigInt(this.offset + this.directorySize), true)
    locator.setUint32(16, 1, true)
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, 0xffff, true)
    end.setUint16(10, 0xffff, true)
    end.setUint32(12, 0xffffffff, true)
    end.setUint32(16, 0xffffffff, true)
    const blob = new Blob(
      [
        ...this.parts,
        ...this.directory,
        bytes(end64),
        bytes(locator),
        bytes(end),
      ],
      { type: 'application/zip' },
    )
    this.parts = []
    this.directory = []
    return blob
  }
}
