import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const sources = await Promise.all(
  ['core.js', 'adapter.js'].map((f) =>
    readFile(new URL(`../src/${f}`, import.meta.url), 'utf8'),
  ),
)
async function setup() {
  const calls = [],
    bytes = new TextEncoder().encode('attachment contents')
  const digest = Buffer.from(
    await crypto.subtle.digest('SHA-256', bytes),
  ).toString('base64url')
  const id = 'message-1',
    jid = '123@msgr'
  const message = {
    toplevelProtobuf: {
      messageId: id,
      threadId: jid,
      timestampMs: 50,
      payload: bytes,
    },
    supplementalProtobufs: new Map(),
    tags: [],
  }
  // These definitions are inspected but MUST NOT be invoked.
  function row() {
    // biome-ignore lint/complexity/noArguments: The parser inspects Messenger's arguments alias.
    var e = arguments
    throw Error('procedure was executed')
    // biome-ignore lint/correctness/noUnreachable: Inspect this source without allowing database writes.
    return t.db.table(331).put({ threadId: e[0], threadType: e[4] })
  }
  function page() {
    // biome-ignore lint/complexity/noArguments: The parser inspects Messenger's arguments alias.
    var e = arguments
    throw Error('procedure was executed')
    // biome-ignore lint/correctness/noUnreachable: Inspect this source without allowing database writes.
    return t.db
      .table(332)
      .put({ hasNextPage: e[2], nextPageCursor: e[3], resultCount: e[4] })
  }
  const modules = {
    CurrentUser: { getAccountID: () => '999' },
    LSPlatformDeviceId: { deviceId: 'existing-device' },
    LSVersion: 'current-version',
    LSPlatformRequestId: { generate: () => 42 },
    MAWMsgType: { MSG_TYPE: { DOCUMENT_FILE: 'Document' } },
    LSPlatformGraphQLLightspeedRequest: async (...args) => {
      calls.push(['list', ...args])
      // Sanitized Messenger response structure and field offsets.
      const guard = (step) => [
        1,
        [4, 0, 1, [5, 'taskExists', [19, String(args[1])]]],
        [23, [2, 0], [1, step]],
      ]
      return {
        payload: JSON.stringify({
          step: [
            1,
            guard([
              5,
              'row',
              [19, '123'],
              [19, '50'],
              [19, '0'],
              [19, '0'],
              [19, '15'],
            ]),
            guard([
              5,
              'page',
              'query',
              [19, '0'],
              false,
              [19, '0'],
              [19, '1'],
              '',
            ]),
            guard([4, 1, 1, [7, 'processFetchedFtsThreads', true]]),
            guard([5, 'removeTask', [19, String(args[1])], [9]]),
          ],
        }),
        dependencies: [],
      }
    },
    LSDynamicDependencies: {
      downloadRelayDependencies: async () => {},
      cachedModules: { row, page },
    },
    I64: { of_string: String, to_string: String },
    LSMessagingThreadTypeUtil: {
      isGroup: (value) => value === '16',
      isArmadilloSecure: (value) => value === '15' || value === '16',
    },
    MAWJids: {
      toUserJid: (id) => `${id}@msgr`,
      convertIntJidToChatJid: (id, group) => id + (group ? '@g.us' : '@msgr'),
    },
    MAWJobDefinitions: { mpsMessageToEncryptedBackupsMessage: (x) => x },
    MAWHandleEchoProtobufsRestoreApi: {
      decodeDecryptedMessageProtobuf: (...args) => {
        args[6].set(id, [
          {
            mediaMetadata: {
              plaintextHash: digest,
              mediaEntryData: new Uint8Array([1, 2]),
              filename: 'document.pdf',
            },
          },
        ])
        return {
          metadata: { senderId: '456' },
          externalId: id,
          msgType: 'Document',
          decodedPayload: { text: 'hello' },
          reactionData: [],
          editMsgData: [],
        }
      },
    },
    MpsOverBridge: {
      mps: () => ({
        loadMessages: async (args) => {
          calls.push(['history', args])
          return {
            success: true,
            value: {
              messages: [message],
              cursorInfo: { hasNext: false, endCursor: [50, id] },
            },
          }
        },
        loadMessage: async (args) => {
          calls.push(['point', args])
          return { success: true, value: message }
        },
      }),
    },
    MAWBridge: {
      getBridge: () => ({
        sendAndReceive: async (...args) => {
          calls.push(['bridge', ...args])
          return {
            success: true,
            value: {
              validatedResult: {
                validatedPlaintext: bytes,
                mimeType: 'application/pdf',
              },
            },
          }
        },
      }),
    },
  }
  const context = vm.createContext({
    require: (name) => {
      if (!(name in modules)) throw Error('missing')
      return modules[name]
    },
    crypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    btoa,
    atob,
    console,
  })
  for (const source of sources) vm.runInContext(source, context)
  const rpc = async (action, args = {}, expected = '999') => {
    const result = await context.MessengerArchivePage.call(
      action,
      args,
      expected,
    )
    if (!result.ok) throw Error(result.error)
    return result.value
  }
  return {
    rpc,
    calls,
    modules,
    message,
    jid,
    bytes,
    digest,
    core: context.MessengerArchiveCore,
  }
}
test('server discovery submits ONLY task 760 and never runs returned DB procedures', async () => {
  const { rpc, calls } = await setup()
  const page = await rpc('listPage', { cursor: '9223372036854775807' })
  assert.equal(page.threads.length, 1)
  assert.equal(page.threads[0].jid, '123@msgr')
  assert.equal(page.hasMore, false)
  const [, device, , payload, type] = calls[0]
  assert.equal(device, 'existing-device')
  assert.equal(type, 3)
  const task = JSON.parse(payload).tasks[0]
  assert.equal(task.label, '760')
  assert.equal(task.queue_name, 'fts_thread_fetch')
  assert.match(task.payload, /"timestamp":9223372036854775807/)
})
test('account changes and unsupported operations issue no requests', async () => {
  const { rpc, calls } = await setup()
  await assert.rejects(rpc('history', {}, 'another-account'), /account changed/)
  for (const action of [
    'sendMsg',
    'markThreadAsRead',
    'deleteThread',
    'updateDYIStatus',
    '__proto__',
  ])
    await assert.rejects(rpc(action), /not allowed/)
  assert.equal(calls.length, 0)
})
test('history and metadata refresh always use no-persist remote reads; documents are retained', async () => {
  const { rpc, calls, jid, message } = await setup()
  const page = await rpc('history', {
    jid,
    cursor: [100, null],
    batchSize: 100,
  })
  assert.equal(page.records[0].text, 'hello')
  assert.equal(page.attachments.length, 1)
  assert.equal(page.next, null)
  assert.equal(page.records[0].raw.toplevelProtobuf.payload.$archive, 'bytes')
  await rpc('refreshMedia', page.attachments[0])
  for (const [, args] of calls) {
    assert.equal(args.config.persistToReverb, 'no-persist')
    assert.equal(args.config.strategy, 'remote-only')
  }
  assert.equal(message.toplevelProtobuf.timestampMs, 50)
})
test('download uses export-only media reader, verifies hash, transfers bytes and releases buffers', async () => {
  const { rpc, calls, jid, bytes } = await setup()
  const page = await rpc('history', {
    jid,
    cursor: [100, null],
    batchSize: 100,
  })
  const result = await rpc('media', page.attachments[0])
  assert.equal(result.size, bytes.length)
  const base64 = await rpc('chunk', { token: result.token, offset: 0 })
  assert.equal(Buffer.from(base64, 'base64').toString(), 'attachment contents')
  assert.equal(calls.find((c) => c[0] === 'bridge')[2], 'dyiDownloadMediaV2')
  assert.equal(calls.find((c) => c[0] === 'bridge')[3].mediaOption, 0)
  await rpc('release', { token: result.token })
  await assert.rejects(
    rpc('chunk', { token: result.token, offset: 0 }),
    /expired/,
  )
  await assert.rejects(
    rpc('media', { ...page.attachments[0], expectedHash: 'wrong' }),
    /SHA-256/,
  )
})
test('unsupported message decoding keeps raw records and exposes an issue', async () => {
  const { rpc, modules, jid } = await setup()
  modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf =
    () => {
      throw Error('new format')
    }
  const page = await rpc('history', {
    jid,
    cursor: [100, null],
    batchSize: 100,
  })
  assert.equal(page.records.length, 1)
  assert.equal(page.decodeErrors.length, 1)
  assert.ok(page.records[0].raw)
  assert.match(page.records[0].error, /raw payload preserved/)
})
test('receiver-fetch stickers have a structured unresolved-media flag without opening them', async () => {
  const { rpc, calls, modules, jid } = await setup()
  modules.MAWMsgType.MSG_TYPE.RECEIVER_FETCH = 'ReceiverFetch'
  modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf =
    () => ({
      msgType: 'ReceiverFetch',
      metadata: { senderId: '456' },
      receiverFetchInfo: { type: 'sticker', receiverFetchId: '987' },
    })
  const page = await rpc('history', {
    jid,
    cursor: [100, null],
    batchSize: 100,
  })
  assert.equal(page.records[0].unresolvedMedia, true)
  assert.equal(page.records[0].attachments.length, 0)
  assert.equal(page.records[0].decoded.receiverFetchInfo.receiverFetchId, '987')
  assert.equal(page.attachments.length, 0)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['history'],
  )
})

test('local inventory joins serverThreadKey to the encrypted jid, not clientThreadPk', async () => {
  const { rpc, modules } = await setup()
  modules.LSDatabaseSingleton = {
    LSDatabaseSingleton: Promise.resolve({
      tables: {
        threads: [
          { threadKey: '8001', threadType: '15', threadName: 'Mapped chat' },
        ],
        mi_act_mapping_table: [
          { serverThreadKey: '8001', clientThreadPk: '9', jid: '123' },
        ],
        contacts: [{ id: '123', name: 'Mapped contact' }],
        messenger_fts_threads: [],
      },
    }),
  }
  modules.ReQL = {
    fromTableAscending: (rows) => rows,
    toArrayAsync: async (rows) => rows,
  }
  const inventory = await rpc('localInventory')
  assert.equal(inventory.threads[0].jid, '123@msgr')
  assert.equal(inventory.threads[0].id, '123')
  assert.equal(inventory.threads[0].encrypted, true)
})

test('saved admin and Raven action records re-decode locally without chat or media requests', async () => {
  const { rpc, calls, modules, message, jid, core: C } = await setup()
  modules.decodeProtobuf = {
    decodeProtobuf: () => ({
      miTransportAdminMessage: { protocol: 1, payload: new Uint8Array([7]) },
    }),
  }
  modules['WAArmadilloBackupMessage.pb'] = { BackupMessageSpec: {} }
  modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf =
    () => ({ metadata: { senderId: '456' }, editMsgData: [], reactionData: [] })
  const admin = await rpc('redecode', { jid, raw: [C.pack(message)] })
  assert.equal(admin.records[0].type, 'AdminEvent')
  assert.equal(admin.records[0].error, null)
  assert.equal(admin.records[0].event.protocol, 1)
  assert.deepEqual(calls, [])
  modules.MAWMsgType.MSG_TYPE.RAVEN = 'Raven'
  modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf =
    () => ({
      msgType: 'Raven',
      ravenActionUnstoredMsg: { actionType: 'seen' },
      editMsgData: [],
      reactionData: [],
    })
  const action = await rpc('redecode', { jid, raw: [C.pack(message)] })
  assert.equal(action.records[0].type, 'RavenAction')
  assert.equal(action.records[0].error, null)
  assert.equal(action.records[0].event.actionType, 'seen')
  assert.deepEqual(calls, [])
  await assert.rejects(
    rpc('redecode', { jid: '999@msgr', raw: [C.pack(message)] }),
    /different conversation/,
  )
  await assert.rejects(rpc('redecode', { jid, raw: [] }), /Invalid/)
})

test('timestamp overlap retrieves both images split across a page boundary', async () => {
  const { rpc, modules, message, jid } = await setup()
  const rows = [
    ...Array.from({ length: 19 }, (_, i) => [String(i), 1000 - i]),
    ['photo-a', 900],
    ['photo-b', 900],
    ['older', 800],
  ].map(([id, timestampMs]) => ({
    ...message,
    toplevelProtobuf: {
      ...message.toplevelProtobuf,
      messageId: id,
      timestampMs,
    },
  }))
  modules.MpsOverBridge.mps = () => ({
    loadMessages: async (args) => {
      const available = rows.filter(
          (m) => m.toplevelProtobuf.timestampMs < args.from[0],
        ),
        messages = available.slice(0, args.numMessages)
      return {
        success: true,
        value: {
          messages,
          cursorInfo: {
            hasNext: available.length > messages.length,
            endCursor: [messages.at(-1).toplevelProtobuf.timestampMs, null],
          },
        },
      }
    },
  })
  const first = await rpc('history', {
    jid,
    cursor: [2000, null],
    batchSize: 20,
  })
  assert.equal(first.next[0], 901)
  const second = await rpc('history', {
    jid,
    cursor: first.next,
    batchSize: 20,
  })
  const ids = new Set([...first.records, ...second.records].map((r) => r.id))
  assert.ok(ids.has('photo-a'))
  assert.ok(ids.has('photo-b'))
  assert.equal(ids.size, rows.length)
  assert.equal(second.next, null)
})
test('dense timestamp groups expand the page instead of skipping IDs; oversized groups fail visibly', async () => {
  const { rpc, modules, message, jid } = await setup()
  let count = 21
  const batches = []
  modules.MpsOverBridge.mps = () => ({
    loadMessages: async (args) => {
      batches.push(args.numMessages)
      const rows = Array.from({ length: count }, (_, i) => ({
        ...message,
        toplevelProtobuf: {
          ...message.toplevelProtobuf,
          messageId: String(i),
          timestampMs: 900,
        },
      }))
      rows.push({
        ...message,
        toplevelProtobuf: {
          ...message.toplevelProtobuf,
          messageId: 'older',
          timestampMs: 800,
        },
      })
      const messages = rows.slice(0, args.numMessages)
      return {
        success: true,
        value: {
          messages,
          cursorInfo: {
            hasNext: rows.length > messages.length,
            endCursor: [messages.at(-1).toplevelProtobuf.timestampMs, null],
          },
        },
      }
    },
  })
  const page = await rpc('history', { jid, cursor: [901, null], batchSize: 20 })
  assert.deepEqual(batches, [20, 500])
  assert.equal(page.records.length, 22)
  assert.equal(page.next, null)
  count = 501
  await assert.rejects(
    rpc('history', { jid, cursor: [901, null], batchSize: 20 }),
    /timestamp group did not fit/,
  )
})

test('native photo previews keep source identity separate, detect real MIME, and do not reduce videos', async () => {
  const { rpc, modules, calls, digest, core } = await setup()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])
  const pngHash = Buffer.from(await crypto.subtle.digest('SHA-256', png))
  let responseBytes = png
  modules.MAWBridge.getBridge = () => ({
    sendAndReceive: async (...args) => {
      calls.push(['bridge', ...args])
      return {
        success: true,
        value: {
          validatedResult: {
            validatedPlaintext: responseBytes,
            skipValidation: true,
          },
          unvalidatedMimeType: 'image/jpeg',
        },
      }
    },
  })
  const job = {
    expectedHash: digest,
    mediaKind: 'photo',
    mediaEntry: core.pack(new Uint8Array([1, 2])),
  }
  const preview = await rpc('media', job)
  assert.equal(calls.at(-1)[3].mediaOption, 1)
  assert.equal(preview.mime, 'image/png')
  assert.equal(preview.nativeMime, 'image/jpeg')
  assert.equal(preview.representation, 'native-preview')
  assert.equal(preview.verification.sourceHashVerified, false)
  assert.equal(preview.verification.nativeSkipValidation, true)
  assert.equal(preview.sha256, pngHash.toString('hex'))
  assert.equal(core.filename('photo', preview.mime), 'photo.png')
  await rpc('release', { token: preview.token })

  // A separate native thumbnail has its own known hash, protobuf field 12.1.
  job.mediaEntry = core.pack(new Uint8Array([98, 34, 10, 32, ...pngHash]))
  const thumbnail = await rpc('media', job)
  assert.equal(thumbnail.verification.thumbnailHashVerified, true)
  assert.equal(thumbnail.verification.sourceHashVerified, false)
  responseBytes = new Uint8Array([255, 216, 255, 217])
  await assert.rejects(rpc('media', job), /thumbnail metadata/)
  // Progressive preview bytes are not asserted to match the full photo or thumbnail.
  job.mediaEntry = core.pack(
    new Uint8Array([98, 34, 10, 32, ...pngHash, 122, 0]),
  )
  const progressive = await rpc('media', job)
  assert.equal(progressive.representation, 'native-preview')
  assert.equal(progressive.verification.thumbnailHashVerified, false)
  assert.equal(progressive.verification.sourceHashVerified, false)

  responseBytes = png
  job.expectedHash = pngHash.toString('base64url')
  const fallback = await rpc('media', job)
  assert.equal(fallback.representation, 'full-fallback')
  assert.equal(fallback.verification.sourceHashVerified, true)
  const full = await rpc('media', { ...job, photoMode: 'full' })
  assert.equal(calls.at(-1)[3].mediaOption, 0)
  assert.equal(full.representation, 'full')
  await rpc('media', { ...job, mediaKind: 'video' })
  assert.equal(calls.at(-1)[3].mediaOption, 0)
  await assert.rejects(
    rpc('media', { ...job, mediaKind: 'video', expectedHash: digest }),
    /does not match/,
  )
})

test('history labels photos and videos from message types for the native downloader', async () => {
  const { rpc, modules, jid } = await setup()
  modules.MAWMsgType.MSG_TYPE.IMAGE = 'Image'
  modules.MAWMsgType.MSG_TYPE.VIDEO = 'Video'
  const decode =
    modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf
  let type = 'Image'
  modules.MAWHandleEchoProtobufsRestoreApi.decodeDecryptedMessageProtobuf = (
    ...args
  ) => ({ ...decode(...args), msgType: type })
  assert.equal(
    (await rpc('history', { jid, cursor: [100, null], batchSize: 100 }))
      .attachments[0].mediaKind,
    'photo',
  )
  type = 'Video'
  assert.equal(
    (await rpc('history', { jid, cursor: [100, null], batchSize: 100 }))
      .attachments[0].mediaKind,
    'video',
  )
})
