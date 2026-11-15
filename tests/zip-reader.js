import assert from 'node:assert/strict'
import { buffer } from 'node:stream/consumers'
import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'
// Independent ZIP parser and CRC validator; used only for small test fixtures.
export async function readZip(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes)
  const files = Object.create(null)
  for await (const entry of zip.eachEntry()) {
    const data = await buffer(await zip.openReadStreamPromise(entry))
    assert.equal(crc32(data), entry.crc32, `CRC mismatch: ${entry.fileName}`)
    files[entry.fileName] = data
  }
  return files
}
