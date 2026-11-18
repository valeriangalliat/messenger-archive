import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import 'fake-indexeddb/auto'
import '../src/core.js'
import { openArchive } from '../src/db.js'
import { archiveZip } from '../src/export.js'

// Exercise the panel with real archive storage and a small DOM surface.
class Element {
  children = []
  textContent = ''
  hidden = false
  disabled = false
  open = false
  constructor(fragment = false) {
    this.fragment = fragment
  }
  append(element) {
    this.children.push(...(element.fragment ? element.children : [element]))
  }
  replaceChildren(...elements) {
    this.children = []
    for (const element of elements) this.append(element)
  }
}

test('archive control resumes checkpoints, updates despite issues, and exposes every issue page', async (t) => {
  const html = await readFile(
    new URL('../assets/panel.html', import.meta.url),
    'utf8',
  )
  const nodes = new Map()
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element()
    element.hidden = /\bhidden\b/.test(match[0])
    element.disabled = /\bdisabled\b/.test(match[0])
    nodes.set(match[1], element)
  }
  const $ = (id) => {
    assert.ok(nodes.has(id), `Missing panel element: ${id}`)
    return nodes.get(id)
  }
  const account = crypto.randomUUID()
  const thread = { id: '123', jid: '123@msgr', name: 'A chat', encrypted: true }
  const calls = []
  let holdHistory,
    enteredHistory,
    persistentIssue = false
  globalThis.document = {
    getElementById: $,
    createElement: () => new Element(),
    createDocumentFragment: () => new Element(true),
  }
  globalThis.location = { href: 'https://extension.test/assets/panel.html' }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, _options, run) => run({}) } },
  })
  globalThis.browser = {
    tabs: { query: async () => [{ id: 1 }], onUpdated: { addListener() {} } },
    scripting: {
      async executeScript({ args, files }) {
        if (!args) {
          // Match Firefox's URL resolution from the nested archive page.
          for (const file of files) {
            const path = new URL(file, location.href).pathname
            try {
              await readFile(new URL(`..${path}`, import.meta.url))
            } catch (e) {
              return [{ frameId: 0, error: e.message }]
            }
          }
          return [{ frameId: 0 }]
        }
        const [action, values] = args
        calls.push([action, values])
        let value
        switch (action) {
          case 'probe':
            value = { account, missing: [] }
            break
          case 'localInventory':
            value = { threads: [{ ...thread }], names: {} }
            break
          case 'listPage':
            value = { threads: [{ ...thread }], cursor: '0', hasMore: false }
            break
          case 'history': {
            enteredHistory?.()
            if (holdHistory) await holdHistory
            const first = values.cursor[0] > 100
            const id = first ? 'new' : 'old'
            value = {
              records: [
                {
                  key: [thread.jid, id],
                  jid: thread.jid,
                  id,
                  timestamp: first ? 50 : 10,
                  raw: { id },
                  error: persistentIssue ? 'unsupported' : null,
                },
              ],
              attachments: [],
              next: first ? [50, id] : null,
            }
            break
          }
          case 'redecode':
            value = {
              records: values.raw.map(({ id }) => ({
                key: [thread.jid, id],
                jid: thread.jid,
                id,
                raw: { id },
                timestamp: id === 'new' ? 50 : 10,
                error: persistentIssue ? 'unsupported' : null,
              })),
              attachments: [],
            }
            break
          default:
            assert.fail(`Unexpected RPC: ${action}`)
        }
        return [{ result: { ok: true, value } }]
      },
    },
  }
  await import(`../src/panel.js?test=${account}`)
  const db = await openArchive(account)
  t.after(() => db.db.close())
  assert.equal($('start').textContent, 'Start archive')
  assert.equal($('start').disabled, false)
  assert.equal($('export').disabled, true)
  for (const id of ['discover', 'recheck', 'repair', 'pause'])
    assert.equal(nodes.has(id), false)
  assert.equal(nodes.has('fullPhotos'), false)
  await db.put('meta', {
    key: 'names',
    value: { 123: 'Previously known contact' },
  })

  // Pause during a request, reconnect, and continue from its committed cursor.
  let releaseHistory
  holdHistory = new Promise((resolve) => {
    releaseHistory = resolve
  })
  const entered = new Promise((resolve) => {
    enteredHistory = resolve
  })
  const run = $('start').onclick()
  await entered
  assert.equal(
    (await db.get('meta', 'names')).value['123'],
    'Previously known contact',
  )
  assert.equal($('start').textContent, 'Pause')
  $('start').onclick()
  assert.equal($('start').textContent, 'Pausing…')
  assert.equal($('start').disabled, true)
  releaseHistory()
  await run
  holdHistory = null
  enteredHistory = null
  assert.equal($('start').textContent, 'Resume archive')
  assert.equal($('export').disabled, false)
  await $('connect').onclick()
  assert.equal($('start').textContent, 'Resume archive')
  await $('start').onclick()
  assert.equal($('start').textContent, 'Update archive')
  assert.equal(await db.count('messages'), 2)
  assert.deepEqual(
    calls
      .filter(([action]) => action === 'history')
      .map(([, args]) => args.cursor[0] > 100),
    [true, false],
  )
  assert.equal(calls.filter(([action]) => action === 'listPage').length, 1)

  // A permanent decode issue must not prevent finding new chats on the next run.
  persistentIssue = true
  await $('start').onclick()
  assert.equal($('start').textContent, 'Update archive')
  assert.equal($('failureDetails').hidden, false)
  assert.equal((await db.get('threads', thread.jid)).decodeErrors, 2)
  await $('connect').onclick()
  assert.equal($('start').textContent, 'Update archive')
  await $('start').onclick()
  assert.equal(calls.filter(([action]) => action === 'listPage').length, 3)
  assert.equal($('start').textContent, 'Update archive')
  assert.equal(await db.count('messages'), 2)

  // A failed scan resumes while saved decode issues are retried.
  const unfinished = await db.get('threads', thread.jid)
  await db.put('threads', {
    ...unfinished,
    status: 'error',
    cursor: [1000, null],
  })
  await db.put('meta', { key: 'run', complete: false })
  await db.put('meta', {
    key: 'inventory',
    complete: false,
    cursor: '0',
    pages: 1,
  })
  persistentIssue = false
  await $('connect').onclick()
  await $('start').onclick()
  assert.equal((await db.get('threads', thread.jid)).decodeErrors, 0)
  assert.equal($('failureDetails').hidden, true)

  // More than 50 failures of each kind remain accessible, without duplicates.
  const savedThread = await db.get('threads', thread.jid)
  await db.put('threads', {
    ...savedThread,
    error: 'history issue',
    decodeErrors: 2,
  })
  await db.put('meta', {
    key: 'inventory',
    complete: false,
    error: 'inventory issue',
  })
  for (let i = 0; i < 63; i++)
    await db.saveMedia({
      id: `failed-${i}`,
      jid: thread.jid,
      messageId: `failed-${i}`,
      status: 'error',
      error: 'download failed',
    })
  for (let i = 0; i < 64; i++)
    await db.put('mediaIssues', {
      key: [thread.jid, `missing-${i}`],
      jid: thread.jid,
      messageId: `missing-${i}`,
    })
  await $('connect').onclick()
  assert.equal($('issueSummary').textContent, 'Issues (129 entries)')
  $('failureDetails').open = true
  await $('failureDetails').ontoggle()
  assert.equal($('issueRange').textContent, '1–50 of 129 entries')
  assert.equal($('previousIssues').disabled, true)
  const entries = $('failures').children.map((p) => p.textContent)
  assert.match(entries[0], /history issue.*2 messages could not be fully read/)
  await $('nextIssues').onclick()
  assert.equal($('issueRange').textContent, '51–100 of 129 entries')
  entries.push(...$('failures').children.map((p) => p.textContent))
  await $('nextIssues').onclick()
  assert.equal($('issueRange').textContent, '101–129 of 129 entries')
  assert.equal($('failures').children.length, 29)
  assert.equal($('nextIssues').disabled, true)
  entries.push(...$('failures').children.map((p) => p.textContent))
  assert.equal(new Set(entries).size, 129)
  assert.equal(
    entries.filter((entry) => entry.includes('download failed')).length,
    63,
  )
  assert.equal(
    entries.filter((entry) => entry.includes('could not be found')).length,
    64,
  )
  await $('previousIssues').onclick()
  assert.equal($('issueRange').textContent, '51–100 of 129 entries')

  // Download construction is not a durable backup. Hold completion, interrupt,
  // and complete a second download with automatic cleanup enabled.
  await db.clearLocal()
  await db.discover([thread], { complete: true })
  await db.commitPage(await db.get('threads', thread.jid), {
    records: [
      {
        key: [thread.jid, 'exported'],
        jid: thread.jid,
        id: 'exported',
        timestamp: 100,
        raw: {},
        error: null,
      },
    ],
    attachments: [],
    next: null,
  })
  const job = {
    id: 'snapshot',
    jid: thread.jid,
    size: 3,
    mime: 'image/png',
    status: 'saved',
  }
  await db.beginMedia(job)
  await db.saveChunk(job.id, 0, new Uint8Array([1, 2, 3]))
  await db.saveMedia(job)
  await db.saveMedia({ id: 'unfinished', status: 'pending' })
  await db.saveChunk('unfinished', 0, new Uint8Array([7]))
  const changed = new Set(),
    erased = new Set()
  let downloadState = 'in_progress',
    enteredDownload,
    downloadId = 0
  globalThis.browser.downloads = {
    download: async () => {
      enteredDownload?.()
      return ++downloadId
    },
    search: async ({ id }) => [
      { id, state: downloadState, filename: '/downloads/backup.zip' },
    ],
    onChanged: {
      addListener: (fn) => changed.add(fn),
      removeListener: (fn) => changed.delete(fn),
    },
    onErased: {
      addListener: (fn) => erased.add(fn),
      removeListener: (fn) => erased.delete(fn),
    },
  }
  await $('connect').onclick()
  $('autoCleanup').checked = true
  $('retainMessages').checked = false
  let requested = new Promise((resolve) => {
    enteredDownload = resolve
  })
  const interrupted = $('export').onclick()
  await requested
  assert.equal($('cleanup').disabled, true)
  assert.equal($('clearLocal').disabled, true)
  assert.equal($('importBackup').disabled, true)
  assert.equal($('export').disabled, true)
  assert.equal(await db.get('meta', 'checkpoint'), undefined)
  assert.equal((await db.storageUsage()).attachmentBytes, 4)
  downloadState = 'interrupted'
  for (const fn of changed)
    fn({ id: downloadId, state: { current: downloadState } })
  await interrupted
  assert.equal(await db.get('meta', 'checkpoint'), undefined)
  assert.equal((await db.get('media', 'snapshot')).status, 'saved')
  assert.equal(await db.count('messages'), 1)

  downloadState = 'in_progress'
  requested = new Promise((resolve) => {
    enteredDownload = resolve
  })
  const successful = $('export').onclick()
  await requested
  downloadState = 'complete'
  for (const fn of changed)
    fn({ id: downloadId, state: { current: downloadState } })
  await successful
  assert.match($('status').textContent, /Saved archive:/)
  assert.ok(await db.get('meta', 'checkpoint'))
  assert.equal((await db.get('media', 'snapshot')).status, 'exported')
  assert.equal((await db.get('media', 'unfinished')).status, 'pending')
  assert.equal((await db.storageUsage()).attachmentBytes, 1)
  assert.equal(await db.count('messages'), 0)

  // Reopening can finalize a completed download whose original tab closed.
  await db.saveMessage({
    key: [thread.jid, 'after-restart'],
    jid: thread.jid,
    id: 'after-restart',
    timestamp: 200,
  })
  let snapshot
  await archiveZip(db, account, undefined, undefined, (value) => {
    snapshot = value
  })
  await db.put('meta', {
    key: 'pendingExport',
    snapshot,
    options: { cleanup: true, retainMessages: false },
    downloadId: 99,
  })
  await $('connect').onclick()
  assert.equal(
    (await db.get('meta', 'checkpoint')).value.backupId,
    snapshot.checkpoint.backupId,
  )
  assert.equal(await db.get('meta', 'pendingExport'), undefined)
  assert.equal(await db.count('messages'), 0)
  assert.equal((await db.storageUsage()).attachmentBytes, 1)

  // Local work reserves the operation before waiting for the account lock.
  // It must not expose Pause or allow another operation to start meanwhile.
  let releaseLock, enteredLock
  const waiting = new Promise((resolve) => {
    enteredLock = resolve
  })
  const held = new Promise((resolve) => {
    releaseLock = resolve
  })
  navigator.locks.request = async (_name, _options, run) => {
    enteredLock()
    await held
    return run({})
  }
  const label = $('start').textContent
  const beforeCalls = calls.length
  const cleanup = $('cleanup').onclick()
  await waiting
  assert.equal($('start').disabled, true)
  assert.equal($('start').textContent, label)
  assert.equal($('connect').disabled, true)
  assert.equal($('export').disabled, true)
  await $('start').onclick()
  await $('connect').onclick()
  assert.equal(calls.length, beforeCalls)
  releaseLock()
  await cleanup
  assert.equal($('cleanup').disabled, false)
  assert.equal($('start').disabled, false)

  // Lock contention must leave data intact and release the local operation state.
  navigator.locks.request = async (_name, _options, run) => run(null)
  await $('cleanup').onclick()
  assert.match($('status').textContent, /another extension tab/)
  assert.equal($('start').disabled, false)
  assert.equal($('cleanup').disabled, false)
  assert.equal((await db.storageUsage()).attachmentBytes, 1)

  // Firefox can resolve executeScript with an error on the individual result.
  // Report the failing helper and stop before probing or opening storage.
  const executeScript = browser.scripting.executeScript
  for (const file of ['/src/core.js', '/src/adapter.js']) {
    const injected = []
    browser.scripting.executeScript = async (options) => {
      const current = options.files?.[0]
      if (current) injected.push(current)
      if (current === file)
        return [{ frameId: 0, error: { message: 'fixture script failure' } }]
      return executeScript(options)
    }
    const before = calls.length
    await $('connect').onclick()
    assert.equal(
      $('status').textContent,
      `Could not load Messenger helper (${file}): fixture script failure`,
    )
    assert.deepEqual(
      injected,
      file === '/src/core.js' ? [file] : ['/src/core.js', file],
    )
    assert.equal(calls.length, before)
    assert.equal($('start').disabled, true)
    assert.equal($('connect').hidden, false)
    assert.equal($('connect').disabled, false)
  }

  browser.scripting.executeScript = async (options) => {
    if (options.files) throw Error('fixture permission failure')
    return executeScript(options)
  }
  await $('connect').onclick()
  assert.equal(
    $('status').textContent,
    'Could not load Messenger helper (/src/core.js): fixture permission failure',
  )

  // Preserve RPC errors too; a missing bridge or reply is not proof of reload.
  for (const [failure, expected] of [
    [
      async () => [{ error: 'fixture RPC error' }],
      'Messenger request failed (probe): fixture RPC error',
    ],
    [
      async () => {
        throw Error('fixture tab closed')
      },
      'Messenger request failed (probe): fixture tab closed',
    ],
    [
      async () => [],
      'Messenger request failed (probe): Browser returned no script execution result.',
    ],
    [
      async () => [{}],
      'Messenger returned no reply to probe. Retry the connection.',
    ],
    [
      async ({ func, args }) => [{ result: await func(...args) }],
      'Messenger archive helper is missing from the page. Retry the connection.',
    ],
  ]) {
    browser.scripting.executeScript = (options) =>
      options.args ? failure(options) : executeScript(options)
    await $('connect').onclick()
    assert.equal($('status').textContent, expected)
    assert.equal($('start').disabled, true)
    assert.equal($('connect').hidden, false)
  }
  browser.scripting.executeScript = executeScript
  await $('connect').onclick()
  assert.equal(
    $('status').textContent,
    'Ready. Keep Messenger open while archiving.',
  )
  assert.equal($('start').disabled, false)
  assert.equal((await db.storageUsage()).attachmentBytes, 1)

  // Show retry phases and queue position while preserving saved attachments.
  // Pausing during the next download must finish it and leave the rest queued.
  navigator.locks.request = async (_name, _options, run) => run({})
  await db.clearLocal()
  await db.discover([thread], { complete: true })
  await db.put('threads', { ...thread, status: 'reached-start' })
  await db.saveMedia({ id: 'already-saved', status: 'saved' })
  for (const id of ['a-photo', 'b-photo', 'c-photo'])
    await db.saveMedia({
      id,
      jid: thread.jid,
      expectedHash: id,
      mediaKind: 'photo',
      status: id === 'b-photo' ? 'error' : 'pending',
    })
  let mediaCalls = 0
  browser.scripting.executeScript = async (options) => {
    const [action, values] = options.args || []
    if (!['media', 'refreshMedia', 'chunk', 'release'].includes(action))
      return executeScript(options)
    let value
    if (action === 'media') {
      mediaCalls++
      assert.ok($('status').textContent.includes(values.id))
      assert.match($('status').textContent, /A chat · Photo/)
      if (values.id === 'a-photo') {
        assert.match($('status').textContent, /Attachment 1 of 3 this run/)
        if (mediaCalls === 1)
          return [
            {
              result: {
                ok: false,
                error: 'temporary request error',
                code: 'MEDIA_DOWNLOAD_FAILED',
                nativeCode: 'request-error',
              },
            },
          ]
        assert.match($('status').textContent, /attempt 2\/3/)
      } else {
        assert.equal(values.id, 'b-photo')
        assert.match($('status').textContent, /Attachment 2 of 3 this run/)
        assert.match($('status').textContent, /2\/4 saved/)
        $('start').onclick()
      }
      value = { token: values.id, size: 3, mime: 'image/jpeg' }
    } else if (action === 'refreshMedia') {
      assert.match($('status').textContent, /Refreshing download details/)
      value = values
    } else if (action === 'chunk') {
      if (values.token === 'a-photo')
        assert.match($('status').textContent, /Saving bytes: 0%/)
      value = 'AQID'
    } else value = true
    return [{ result: { ok: true, value } }]
  }
  await $('connect').onclick()
  await $('start').onclick()
  assert.equal(mediaCalls, 3)
  assert.equal((await db.get('media', 'already-saved')).status, 'saved')
  assert.equal((await db.get('media', 'a-photo')).status, 'saved')
  assert.equal(
    (await db.get('media', 'a-photo')).downloadAttempts[0].nativeCode,
    'request-error',
  )
  assert.equal((await db.get('media', 'a-photo')).nativeCode, null)
  assert.equal((await db.get('media', 'b-photo')).status, 'saved')
  assert.equal((await db.get('media', 'c-photo')).status, 'pending')
  assert.equal($('status').textContent, 'Paused. Your progress is saved.')

  // Missing full-size media stops immediately, without retry sleeps.
  await db.clearLocal()
  await db.discover([thread], { complete: true })
  await db.put('threads', { ...thread, status: 'reached-start' })
  let missingCalls = 0
  browser.scripting.executeScript = async (options) => {
    const [action] = options.args || []
    if (action !== 'media') return executeScript(options)
    missingCalls++
    return [
      {
        result: {
          ok: false,
          code: 'MEDIA_NOT_FOUND',
          nativeCode: 'media-not-found',
          error: 'media-not-found',
        },
      },
    ]
  }
  await db.saveMedia({
    id: 'missing',
    jid: thread.jid,
    mediaKind: 'photo',
    expectedHash: 'missing',
    status: 'pending',
  })
  await $('connect').onclick()
  const sleeps = t.mock.method(globalThis, 'setTimeout')
  await $('start').onclick()
  assert.equal(missingCalls, 1)
  assert.equal(sleeps.mock.calls.length, 0)
  sleeps.mock.restore()
  assert.equal((await db.get('media', 'missing')).status, 'error')

  // A resumed archive resolves server-only names without redoing completed history.
  // A name lookup failure must remain visible without preventing media downloads.
  await db.clearLocal()
  const people = ['100006568124597', '699399875'].map((id) => ({
    id,
    jid: `${id}@msgr`,
    name: id,
    encrypted: true,
    source: 'server',
  }))
  const group = { id: '789', jid: '789@g.us', name: '789', encrypted: true }
  await db.discover([...people, group], { complete: true })
  await db.put('meta', {
    key: 'names',
    value: { [people[0].id]: people[0].id },
  })
  for (const person of [...people, group])
    await db.put('threads', { ...person, status: 'reached-start' })
  await db.saveMessage({
    key: [people[0].jid, 'hello'],
    jid: people[0].jid,
    id: 'hello',
    senderId: people[0].id,
    text: 'hello',
  })
  await db.saveMedia({
    id: 'photo-after-names',
    jid: people[0].jid,
    status: 'pending',
  })
  const lookups = []
  let failSam = true
  browser.scripting.executeScript = async (options) => {
    const [action, values] = options.args || []
    if (!['contactName', 'media', 'chunk', 'release'].includes(action))
      return executeScript(options)
    let value
    if (action === 'contactName') {
      lookups.push(values.id)
      if (values.id === people[1].id && failSam)
        return [
          { result: { ok: false, error: 'temporary contact lookup failure' } },
        ]
      value = values.id === people[0].id ? 'Cynthia Amrein' : 'Sam Roelants'
    } else if (action === 'media')
      value = { token: 'photo', size: 3, mime: 'image/jpeg' }
    else value = action === 'chunk' ? 'AQID' : true
    return [{ result: { ok: true, value } }]
  }
  await $('connect').onclick()
  await $('start').onclick()
  assert.deepEqual(
    lookups,
    people.map((p) => p.id),
  )
  assert.equal((await db.get('threads', people[0].jid)).name, 'Cynthia Amrein')
  assert.match(
    (await db.get('threads', people[1].jid)).nameError,
    /temporary contact lookup failure/,
  )
  assert.equal((await db.get('media', 'photo-after-names')).status, 'saved')
  assert.match($('counts').textContent, /1 contact name unresolved/)
  assert.equal($('failureDetails').hidden, false)
  failSam = false
  await db.put('meta', { key: 'run', complete: false })
  await $('start').onclick()
  assert.deepEqual(lookups, [people[0].id, people[1].id, people[1].id])
  assert.equal(
    (await db.get('meta', 'names')).value[people[1].id],
    'Sam Roelants',
  )
  assert.equal((await db.get('threads', people[1].jid)).nameError, null)
  assert.equal($('failureDetails').hidden, true)
})
