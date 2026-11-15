/* Runs in Messenger's MAIN world. Only the explicitly listed read operations are exposed. */
;(() => {
  if (globalThis.MessengerArchivePage?.version === 5) return
  const C = globalThis.MessengerArchiveCore
  const modules = new Map(),
    buffers = new Map()
  const unwrap = (x) => x?.default ?? x
  async function mod(name) {
    if (modules.has(name)) return modules.get(name)
    if (typeof globalThis.require !== 'function')
      throw Error(
        'Messenger module loader unavailable. Open the full Messenger web app and restore history first.',
      )
    let result
    try {
      result = globalThis.require(name)
    } catch {
      /* Try Meta's lazy module loader. */
    }
    if (result == null) {
      let deferred
      try {
        deferred = globalThis.require('requireDeferred')
      } catch {
        /* Report the missing module below. */
      }
      if (typeof unwrap(deferred) !== 'function')
        throw Error(`Messenger module unavailable: ${name}.`)
      result = await unwrap(deferred)(name).load()
    }
    result = unwrap(result)
    if (result == null) throw Error(`Messenger module unavailable: ${name}.`)
    modules.set(name, result)
    return result
  }
  async function account() {
    return String((await mod('CurrentUser')).getAccountID())
  }
  async function check(expected) {
    const actual = await account()
    if (!/^[1-9]\d*$/.test(actual)) throw Error('Not logged into Messenger.')
    if (expected && actual !== expected)
      throw Object.assign(
        Error('Messenger account changed. Reconnect before continuing.'),
        { code: 'ACCOUNT_CHANGED' },
      )
    return actual
  }
  const num = (i64, value) => (value == null ? null : i64.to_string(value))
  async function localInventory() {
    const db = await (await mod('LSDatabaseSingleton')).LSDatabaseSingleton
    const reql = await mod('ReQL'),
      i64 = await mod('I64')
    const read = (name) =>
      db.tables[name]
        ? reql.toArrayAsync(reql.fromTableAscending(db.tables[name]))
        : []
    const [threads, mappings, contacts, fts] = await Promise.all(
      [
        'threads',
        'mi_act_mapping_table',
        'contacts',
        'messenger_fts_threads',
      ].map(read),
    )
    const names = Object.fromEntries(
      contacts.filter((c) => c.name).map((c) => [num(i64, c.id), c.name]),
    )
    const mapped = new Map(
      mappings.map((m) => [num(i64, m.serverThreadKey), num(i64, m.jid)]),
    )
    const types = await mod('LSMessagingThreadTypeUtil')
    const jids = await mod('MAWJids')
    const result = new Map()
    for (const t of threads) {
      const key = num(i64, t.threadKey),
        id = mapped.get(key) || key
      const encrypted = types.isArmadilloSecure(t.threadType)
      const group = types.isGroup(t.threadType)
      const jid = jids.convertIntJidToChatJid(i64.of_string(id), group)
      result.set(jid, {
        jid,
        id,
        name: t.threadName || names[id] || id,
        encrypted,
        source: 'local',
        folder: num(i64, t.parentThreadKey),
      })
    }
    for (const t of fts) {
      const id = num(i64, t.threadId),
        group = types.isGroup(t.threadType)
      const jid = jids.convertIntJidToChatJid(t.threadId, group)
      const old = result.get(jid)
      result.set(jid, {
        ...old,
        jid,
        id,
        encrypted: true,
        source: 'local+fts',
        name: old?.name || names[id] || id,
      })
    }
    return { threads: [...result.values()], names }
  }
  async function listPage(cursor) {
    if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)
      throw Error('Invalid conversation-list cursor.')
    const request = await mod('LSPlatformGraphQLLightspeedRequest')
    const device = await mod('LSPlatformDeviceId'),
      version = await mod('LSVersion')
    const id = (await mod('LSPlatformRequestId')).generate()
    // Task 760 fetches FTS conversation IDs. No generic task submission entry point exists.
    const task = {
      label: '760',
      queue_name: 'fts_thread_fetch',
      task_id: id,
      failure_count: null,
      payload: `{"timestamp":${cursor},"session_id":"","client_caller_id":"msgr_search_web_fts_threads_fetch"}`,
    }
    const payload = `{"epoch_id":${BigInt(Date.now()) << 22n},"tasks":${JSON.stringify([task])},"version_id":${JSON.stringify(version)}}`
    const response = await request(device.deviceId, id, payload, 3, {
      fetchPolicy: 'network-only',
    })
    if (!response?.payload) throw Error('Empty conversation-list response.')
    const body = JSON.parse(response.payload),
      calls = C.readSteps(body.step, id)
    const dynamic = await mod('LSDynamicDependencies')
    // Load definitions to READ their field layouts. Never call any returned procedure.
    await dynamic.downloadRelayDependencies(response.dependencies || [])
    let page
    const threads = [],
      types = await mod('LSMessagingThreadTypeUtil'),
      i64 = await mod('I64'),
      jids = await mod('MAWJids')
    for (const call of calls) {
      let proc = dynamic.cachedModules[call.name]
      if (proc?.load) proc = await proc.load()
      proc = unwrap(proc)
      if (typeof proc !== 'function') continue
      const source = Function.prototype.toString.call(proc)
      if (/\.table\(331\)/.test(source) && /threadId\s*:/.test(source)) {
        const fields = C.fieldIndexes(source, ['threadId', 'threadType'])
        const id = String(call.args[fields.threadId]),
          type = call.args[fields.threadType]
        if (!/^[1-9]\d*$/.test(id) || type == null)
          throw Error('Invalid conversation identifier or type.')
        const jid = jids.convertIntJidToChatJid(
          i64.of_string(id),
          types.isGroup(i64.of_string(String(type))),
        )
        threads.push({ jid, id, encrypted: true, source: 'server', name: id })
      }
      if (/\.table\(332\)/.test(source) && /hasNextPage\s*:/.test(source)) {
        const fields = C.fieldIndexes(source, [
          'hasNextPage',
          'nextPageCursor',
          'resultCount',
        ])
        if (page)
          throw Error('Ambiguous conversation-list pagination response.')
        const flag = call.args[fields.hasNextPage]
        page = {
          hasMore: flag === true || flag === 1 || flag === 1n,
          cursor: String(call.args[fields.nextPageCursor]),
          count: Number(call.args[fields.resultCount]),
        }
        if (![true, false, 0, 1, 0n, 1n].includes(flag))
          throw Error('Invalid conversation-list pagination flag.')
      }
    }
    if (
      !page ||
      !Number.isSafeInteger(page.count) ||
      page.count !== threads.length
    ) {
      throw Error(
        `Conversation-list schema not recognized completely (${threads.length} rows). Procedures: ${calls
          .map((c) => c.name)
          .join(', ')
          .slice(0, 800)}`,
      )
    }
    C.inventoryCursor(cursor, page.cursor, page.hasMore)
    return { threads, ...page }
  }
  async function history(jid, cursor, batchSize) {
    if (!/^[1-9]\d*@(?:msgr|g\.us)$/.test(jid))
      throw Error('Invalid Messenger chat identifier.')
    if (
      !Array.isArray(cursor) ||
      !Number.isSafeInteger(cursor[0]) ||
      cursor[0] < 0
    )
      throw Error('Invalid history cursor.')
    if (!Number.isInteger(batchSize) || batchSize < 20 || batchSize > 500)
      throw Error('Invalid batch size.')
    const mps = (await mod('MpsOverBridge')).mps()
    const response = await mps.loadMessages({
      config: {
        persistToReverb: 'no-persist',
        shouldFetchSupplementals: true,
        shouldFetchTags: true,
        strategy: 'remote-only',
      },
      debug: { purpose: 'dyi' },
      direction: 'desc',
      from: cursor,
      numMessages: batchSize,
      source: 46,
      threadId: jid,
    })
    if (!response.success)
      throw Error(
        'History query failed: ' +
          String(
            response.error?.code || response.error?.message || response.error,
          ),
      )
    const { messages, cursorInfo } = response.value
    if (!Array.isArray(messages) || !cursorInfo)
      throw Error('Unrecognized history response.')
    let next
    try {
      next = C.nextCursor(cursor, cursorInfo.endCursor, cursorInfo.hasNext)
    } catch (error) {
      if (error.code === 'HISTORY_CURSOR_STUCK' && batchSize < 500)
        return history(jid, cursor, 500)
      throw error
    }
    return decodeMessages(messages, jid, next)
  }
  async function decodeMessages(messages, jid, next = null) {
    const defs = await mod('MAWJobDefinitions'),
      decoder = await mod('MAWHandleEchoProtobufsRestoreApi'),
      jids = await mod('MAWJids')
    const self = jids.toUserJid(await account())
    const types = (await mod('MAWMsgType')).MSG_TYPE
    const mediaTypes = new Set(
      [
        'IMAGE',
        'VIDEO',
        'GIF',
        'STICKER',
        'PTT',
        'DOCUMENT_FILE',
        'RAVEN',
        'RECEIVER_FETCH',
      ]
        .map((t) => types[t])
        .filter((t) => t != null),
    )
    const records = [],
      attachments = [],
      decodeErrors = []
    for (const message of messages) {
      const top = message.toplevelProtobuf
      if (!top?.messageId)
        throw Error('History message has no identifier; page was not saved.')
      const id = String(top.messageId),
        media = new Map()
      let decoded, error, type, event
      try {
        decoded = decoder.decodeDecryptedMessageProtobuf(
          defs.mpsMessageToEncryptedBackupsMessage(message),
          self,
          undefined,
          new Set(),
          new Set(),
          new Map(),
          media,
          new Map(),
          true,
        )
        type = decoded?.msgType
        if (!type) {
          const outer = (await mod('decodeProtobuf')).decodeProtobuf(
            (await mod('WAArmadilloBackupMessage.pb')).BackupMessageSpec,
            top.payload,
          )
          if (outer.miTransportAdminMessage) {
            type = 'AdminEvent'
            event = outer.miTransportAdminMessage
          } else error = 'Unsupported message type; raw payload preserved.'
        }
        if (type === types.RAVEN && decoded?.ravenActionUnstoredMsg) {
          type = 'RavenAction'
          event = decoded.ravenActionUnstoredMsg
        }
      } catch {
        error = 'Message decoding failed; raw payload preserved.'
      }
      const metadata = decoded?.metadata
      const timestamp = Number(top.timestampMs)
      if (!Number.isSafeInteger(timestamp))
        throw Error('History message has an invalid timestamp.')
      let text = decoded?.decodedPayload?.text || ''
      for (const edit of [...(decoded?.editMsgData || [])].sort(
        (a, b) => a.ts - b.ts,
      ))
        text = edit.editMsgContent?.message?.text ?? text
      if (!text && decoded?.xmaData)
        text = (decoded.xmaData.ctas || [])
          .map((c) => c.nativeUrl)
          .filter(Boolean)
          .join('\n')
      const entries = [...media.values()]
        .flat()
        .map((x) => x.mediaMetadata)
        .filter(Boolean)
      if (
        decoded?.mediaMetadata &&
        !entries.some(
          (x) => x.plaintextHash === decoded.mediaMetadata.plaintextHash,
        )
      )
        entries.push(decoded.mediaMetadata)
      const attachmentIds = []
      let unresolvedMedia = false
      if (mediaTypes.has(type) && !entries.length) {
        unresolvedMedia = true
        error =
          'Media could not be resolved without opening it; raw payload preserved.'
      }
      for (const m of entries) {
        const hash = m.plaintextHash
        if (!hash || !m.mediaEntryData) {
          unresolvedMedia = true
          error = 'Attachment metadata missing; raw payload preserved.'
          continue
        }
        const key = String(hash)
        attachmentIds.push(key)
        attachments.push({
          id: key,
          jid,
          messageId: id,
          timestamp,
          expectedHash: key,
          filename: m.filename || '',
          mediaKind:
            type != null && type === types.IMAGE
              ? 'photo'
              : type != null && type === types.VIDEO
                ? 'video'
                : 'other',
          mediaEntry: C.pack(m.mediaEntryData),
          protocolMsgId: {
            author: jids.toUserJid(String(metadata?.senderId || '0')),
            chat: jid,
            externalId: String(decoded.externalId || id),
          },
        })
      }
      if (error) decodeErrors.push(id)
      records.push({
        key: [jid, id],
        jid,
        id,
        timestamp,
        senderId: String(metadata?.senderId || ''),
        text,
        type: type || 'unknown',
        event: C.pack(event),
        reactions: C.pack(decoded?.reactionData || []),
        attachments: attachmentIds,
        unresolvedMedia,
        error: error || null,
        raw: C.pack(message),
        decoded: C.pack(decoded),
      })
    }
    return { records, attachments, next, decodeErrors }
  }
  async function media(job) {
    const bridge = (await mod('MAWBridge')).getBridge()
    const preview = job.mediaKind === 'photo' && job.photoMode !== 'full'
    // Uses the export media reader; its native code may refresh Meta's local CDN URL cache.
    const result = await bridge.sendAndReceive(
      'backend',
      'dyiDownloadMediaV2',
      {
        mediaEntry: C.unpack(job.mediaEntry),
        mediaOption: preview ? 1 : 0,
        plaintextHash: job.expectedHash,
        protocolMsgId: job.protocolMsgId,
        sortOrderMs: job.timestamp,
      },
    )
    if (!result?.success)
      throw Error(
        `Attachment download failed: ${String(result?.error || 'no result')}`,
      )
    const payload = result.value,
      validated = payload.validatedResult
    const plaintext = validated?.validatedPlaintext
    if (!(plaintext instanceof ArrayBuffer) && !ArrayBuffer.isView(plaintext))
      throw Error('Media downloader returned no plaintext bytes.')
    const bytes =
      plaintext instanceof ArrayBuffer
        ? new Uint8Array(plaintext)
        : new Uint8Array(
            plaintext.buffer,
            plaintext.byteOffset,
            plaintext.byteLength,
          )
    if (!bytes.length) throw Error('Media downloader returned empty plaintext.')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const hex = [...digest].map((x) => x.toString(16).padStart(2, '0')).join('')
    const matches = (hash) => {
      if (!hash) return false
      const normalized = (text) =>
        String(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
      return (
        String(hash).toLowerCase() === hex ||
        normalized(hash) === normalized(C.bytesToBase64(digest))
      )
    }
    const sourceVerified = matches(job.expectedHash)
    const metadata = preview ? C.photoMetadata(C.unpack(job.mediaEntry)) : {}
    const thumbnailVerified = metadata.thumbnailHash
      ? matches(metadata.thumbnailHash)
      : null
    if (!preview && !sourceVerified)
      throw Error('Attachment SHA-256 does not match its message metadata.')
    if (
      preview &&
      !sourceVerified &&
      metadata.thumbnailHash &&
      !metadata.progressive &&
      !thumbnailVerified
    )
      throw Error(
        'Photo preview SHA-256 does not match its thumbnail metadata.',
      )
    const token = crypto.randomUUID()
    buffers.set(token, { bytes, expires: Date.now() + 300000 })
    for (const [key, data] of buffers)
      if (data.expires < Date.now()) buffers.delete(key)
    return {
      token,
      size: bytes.length,
      mime: C.detectedMime(
        bytes,
        validated.mimeType ||
          payload.unvalidatedMimeType ||
          'application/octet-stream',
      ),
      nativeMime: validated.mimeType || payload.unvalidatedMimeType || null,
      representation: preview
        ? sourceVerified
          ? 'full-fallback'
          : 'native-preview'
        : 'full',
      requestedRepresentation: preview ? 'native-preview' : 'full',
      verification: {
        storedSha256: 'computed',
        sourceHashVerified: sourceVerified,
        thumbnailHashVerified: thumbnailVerified,
        nativeSkipValidation: validated.skipValidation ?? null,
      },
      sha256: hex,
    }
  }
  const actions = {
    probe: async () => {
      const id = await check()
      const required = [
        'LSDatabaseSingleton',
        'ReQL',
        'MpsOverBridge',
        'MAWBridge',
        'MAWJobDefinitions',
        'MAWHandleEchoProtobufsRestoreApi',
        'LSPlatformGraphQLLightspeedRequest',
        'LSDynamicDependencies',
      ]
      const missing = []
      await Promise.all(
        required.map(async (name) => {
          try {
            await mod(name)
          } catch {
            missing.push(name)
          }
        }),
      )
      return { account: id, missing }
    },
    redecode: async ({ jid, raw }) => {
      if (
        !/^[1-9]\d*@(?:msgr|g\.us)$/.test(jid) ||
        !Array.isArray(raw) ||
        !raw.length ||
        raw.length > 100
      )
        throw Error('Invalid saved-message batch.')
      const messages = raw.map(C.unpack)
      if (messages.some((m) => String(m.toplevelProtobuf?.threadId) !== jid))
        throw Error('Saved messages belong to a different conversation.')
      return decodeMessages(messages, jid)
    },
    localInventory,
    listPage: (args) => listPage(args.cursor),
    history: (args) => history(args.jid, args.cursor, args.batchSize),
    media,
    refreshMedia: async (job) => {
      const result = await (await mod('MpsOverBridge')).mps().loadMessage({
        config: {
          persistToReverb: 'no-persist',
          shouldFetchSupplementals: true,
          shouldFetchTags: true,
          strategy: 'remote-only',
        },
        debug: { purpose: 'dyi' },
        messageId: job.messageId,
        threadId: job.jid,
      })
      if (!result?.success || !result.value)
        throw Error('Could not refresh attachment metadata from its message.')
      const page = await decodeMessages([result.value], job.jid)
      const fresh = page.attachments.find((a) => a.id === job.id)
      if (!fresh)
        throw Error('Refreshed message no longer contains this attachment.')
      return fresh
    },
    chunk: ({ token, offset }) => {
      const buffer = buffers.get(token)
      if (!buffer || buffer.expires < Date.now())
        throw Error('Attachment buffer expired; retry the download.')
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= buffer.bytes.length
      )
        throw Error('Invalid chunk offset.')
      buffer.expires = Date.now() + 300000
      return C.bytesToBase64(buffer.bytes.subarray(offset, offset + 524288))
    },
    release: ({ token }) => {
      buffers.delete(token)
      return true
    },
  }
  globalThis.MessengerArchivePage = Object.freeze({
    version: 5,
    async call(action, args = {}, expectedAccount) {
      try {
        if (!Object.hasOwn(actions, action))
          throw Error('Operation not allowed.')
        await check(expectedAccount)
        const value = await actions[action](args)
        await check(expectedAccount)
        return { ok: true, value }
      } catch (e) {
        return {
          ok: false,
          error: String(e.message || e),
          code: e.code || null,
        }
      }
    },
  })
})()
