/* Shared, dependency-free data helpers. Never executes Messenger response procedures. */
;(() => {
  const bytesToBase64 = (bytes) => {
    let text = ''
    for (let i = 0; i < bytes.length; i += 32768)
      text += String.fromCharCode(...bytes.subarray(i, i + 32768))
    return btoa(text)
  }
  const base64ToBytes = (text) =>
    Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  function pack(value) {
    if (value === undefined) return { $archive: 'undefined' }
    if (typeof value === 'bigint')
      return { $archive: 'bigint', value: String(value) }
    if (ArrayBuffer.isView(value))
      return {
        $archive: 'bytes',
        value: bytesToBase64(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      }
    if (value instanceof ArrayBuffer)
      return { $archive: 'bytes', value: bytesToBase64(new Uint8Array(value)) }
    if (value instanceof Map)
      return {
        $archive: 'map',
        value: [...value].map(([k, v]) => [pack(k), pack(v)]),
      }
    if (value instanceof Set)
      return { $archive: 'set', value: [...value].map(pack) }
    if (Array.isArray(value)) return value.map(pack)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, pack(v)]),
      )
    return value
  }
  function unpack(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      switch (value.$archive) {
        case 'undefined':
          return undefined
        case 'bigint':
          return BigInt(value.value)
        case 'bytes':
          return base64ToBytes(value.value)
        case 'map':
          return new Map(value.value.map(([k, v]) => [unpack(k), unpack(v)]))
        case 'set':
          return new Set(value.value.map(unpack))
      }
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, unpack(v)]),
      )
    }
    return Array.isArray(value) ? value.map(unpack) : value
  }
  function nextCursor(current, next, hasMore) {
    if (typeof hasMore !== 'boolean')
      throw Error(
        'Missing pagination status; stopping without marking complete.',
      )
    if (!hasMore) return null
    if (
      !Array.isArray(next) ||
      !Number.isSafeInteger(Number(next[0])) ||
      Number(next[0]) < 0
    )
      throw Error('Missing or invalid history cursor.')
    // The remote query ignores the message ID. Overlap the oldest millisecond,
    // then deduplicate by message ID so siblings at the boundary are not skipped.
    const overlap = Number(next[0]) + 1
    if (!Number.isSafeInteger(overlap) || overlap >= Number(current[0]))
      throw Object.assign(
        Error(
          'History timestamp group did not fit the page; stopping without skipping messages.',
        ),
        { code: 'HISTORY_CURSOR_STUCK' },
      )
    return [overlap, next[1] == null ? null : String(next[1])]
  }
  function inventoryCursor(current, next, hasMore) {
    if (typeof hasMore !== 'boolean')
      throw Error('Conversation-list response has no pagination status.')
    if (!hasMore) return null
    if (!/^\d+$/.test(String(next)) || BigInt(next) >= BigInt(current))
      throw Error('Conversation-list cursor did not move backwards.')
    return String(next)
  }
  function filename(id, mime = '') {
    const ext =
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'audio/mp4': 'm4a',
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'application/pdf': 'pdf',
      }[mime.split(';')[0]] || 'bin'
    return `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`
  }
  function fieldIndexes(source, fields) {
    const args = source.match(
      /(?:var|let|const)\s+([\w$]+)\s*=\s*arguments\b/,
    )?.[1]
    if (!args)
      throw Error(
        'Unrecognized conversation-list schema: argument array not found.',
      )
    const result = {}
    for (const field of fields) {
      const escaped = args.replace(/\$/g, '\\$')
      const matches = [
        ...source.matchAll(
          new RegExp(`\\b${field}\\s*:\\s*${escaped}\\[(\\d+)\\]`, 'g'),
        ),
      ]
      const indexes = new Set(matches.map((m) => Number(m[1])))
      if (indexes.size !== 1)
        throw Error(`Unrecognized conversation-list schema: ${field}.`)
      result[field] = [...indexes][0]
    }
    return result
  }
  // A small data decoder, not Meta's database evaluator. Procedures become records only.
  // Unknown instructions fail closed; unknown procedure results cannot drive branches.
  function readSteps(program, taskId) {
    const calls = [],
      refs = new Map(),
      UNKNOWN = Symbol('procedure result')
    const known = (value) => {
      if (value === UNKNOWN)
        throw Error('Unsupported procedure-dependent response.')
      return value
    }
    const value = (step) => {
      if (!Array.isArray(step)) return step
      const [op, ...a] = step
      switch (op) {
        case 1: {
          let last
          for (const s of a) last = value(s)
          return last
        }
        case 2:
          if (!refs.has(a[0])) throw Error('Missing response reference.')
          return refs.get(a[0])
        case 3: {
          const v = value(a[1])
          refs.set(a[0], v)
          return v
        }
        case 4: {
          const [start, count] = a,
            result = value(a[2])
          if (
            !Number.isSafeInteger(start) ||
            start < 0 ||
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count > 1000 ||
            (result !== UNKNOWN &&
              (!Array.isArray(result) || result.length < count))
          )
            throw Error('Unsupported response tuple.')
          for (let i = 0; i < count; i++)
            refs.set(start + i, result === UNKNOWN ? UNKNOWN : result[i])
          return result
        }
        case 5: {
          const args = a.slice(1).map(value)
          calls.push({ name: a[0], args })
          if (a[0] === 'taskExists' && taskId != null) {
            if (args.length !== 1 || String(args[0]) !== String(taskId))
              throw Error(
                'Conversation-list task guard did not match this request.',
              )
            // Project the response for our own task. No pending_tasks row is written.
            return [true]
          }
          return UNKNOWN
        }
        case 7:
          // This callback's unused result stays opaque. Never run native operations.
          if (
            taskId != null &&
            a[0] === 'processFetchedFtsThreads' &&
            a.length === 2 &&
            typeof known(value(a[1])) === 'boolean'
          )
            return UNKNOWN
          throw Error(
            'Unsupported conversation-list instruction 7; nothing was executed.',
          )
        case 8:
          return a.map(value)
        case 9:
          return undefined
        case 10:
          return Infinity
        case 12:
          return value(a[0])
        case 17:
          return BigInt(Math.trunc(known(value(a[0]))))
        case 18:
          return Number(known(value(a[0])))
        case 19:
          return BigInt(a[0])
        case 20:
          return String(known(value(a[0])))
        case 23:
          return known(value(a[0])) ? value(a[1]) : value(a[2])
        case 24:
          return known(value(a[0])) || known(value(a[1]))
        case 25:
          return known(value(a[0])) && known(value(a[1]))
        case 26:
          return !known(value(a[0]))
        case 27:
          return known(value(a[0])) == null
        case 28: {
          const v = known(value(a[0]))
          if (v == null) throw Error('Null response value.')
          return v
        }
        case 29:
        case 30:
          return known(value(a[0])) === known(value(a[1]))
        case 32:
        case 33:
          return known(value(a[0])) !== known(value(a[1]))
        case 35:
        case 36:
          return known(value(a[0])) > known(value(a[1]))
        case 38:
        case 39:
          return known(value(a[0])) >= known(value(a[1]))
        case 41:
        case 42:
          return known(value(a[0])) < known(value(a[1]))
        case 44:
        case 45:
          return known(value(a[0])) <= known(value(a[1]))
        case 47:
          throw Error('Messenger returned a conversation-list error.')
        case 48:
        case 49:
          return undefined
        case 50:
          return []
        case 51: {
          const list = known(value(a[0]))
          list.push(value(a[1]))
          return list
        }
        case 52:
          return known(value(a[0])).length
        case 53:
          return new Map()
        case 54:
          return known(value(a[0])).get(value(a[1]))
        case 55: {
          const map = known(value(a[0]))
          map.set(value(a[1]), value(a[2]))
          return map
        }
        case 59:
          return a.map((x) => String(known(value(x)))).join('')
        case 60:
          return Date.now()
        case 68:
        case 69:
          return known(value(a[0])) + known(value(a[1]))
        case 70:
          return BigInt(a[0])
        case 97:
          return known(value(a[0])) ? value(a[1]) : value(a[2])
        case 99:
          return known(value(a[0])) ?? value(a[1])
        default:
          throw Error(
            `Unsupported conversation-list instruction ${op}; nothing was executed.`,
          )
      }
    }
    value(program)
    return calls
  }
  globalThis.MessengerArchiveCore = Object.freeze({
    pack,
    unpack,
    bytesToBase64,
    base64ToBytes,
    nextCursor,
    inventoryCursor,
    filename,
    fieldIndexes,
    readSteps,
  })
})()
