import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import 'fake-indexeddb/auto'
import '../src/core.js'
import { openArchive } from '../src/db.js'

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
      async executeScript({ args }) {
        if (!args) return []
        const [action, values] = args
        calls.push([action, values])
        let value
        switch (action) {
          case 'probe':
            value = { account, missing: [] }
            break
          case 'localInventory':
            value = { threads: [thread], names: {} }
            break
          case 'listPage':
            value = { threads: [thread], cursor: '0', hasMore: false }
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

  // Recover an update interrupted halfway through resetting old checkpoints.
  await db.put('meta', { key: 'update', pending: true, cursor: [1000, null] })
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
  assert.equal((await db.get('meta', 'update')).pending, false)
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
    await db.put('media', {
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
})
