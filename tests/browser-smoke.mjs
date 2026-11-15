import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { readZip } from './zip-reader.js'

const root = await mkdtemp(join(tmpdir(), 'messenger-archive-test-'))
const downloadsPath = join(root, 'downloads')
await mkdir(downloadsPath)
const profile = join(root, 'profile')
await mkdir(join(profile, 'Default'), { recursive: true })
await writeFile(
  join(profile, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloadsPath, prompt_for_download: false },
  }),
)
let browser
try {
  browser = await puppeteer.launch({
    enableExtensions: true,
    userDataDir: profile,
  })
  const id = await browser.installExtension(
    fileURLToPath(new URL('../', import.meta.url)),
  )
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === 'service_worker' &&
      target.url().endsWith('/src/background.js'),
  )
  const worker = await workerTarget.worker()
  assert.equal(
    await worker.evaluate(() => chrome.action.onClicked.hasListeners()),
    true,
  )
  console.log('Testing toolbar action and connection…')
  const fakePage = async (url) => {
    const page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (request) =>
      request
        .respond({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Messenger fixture</title>',
        })
        .catch(console.error),
    )
    await page.goto(url)
    return page
  }
  const messenger = await fakePage('https://www.messenger.com/')
  await messenger.evaluate(async () => {
    const bytes = new TextEncoder().encode('fixture attachment')
    window.__calls = []
    window.__failDiscovery = false
    function row() {
      // biome-ignore lint/complexity/noArguments: The parser inspects Messenger's arguments alias.
      var e = arguments
      throw Error('DB write called')
      // biome-ignore lint/correctness/noUnreachable: Inspect this source without allowing database writes.
      return t.db.table(331).put({ threadId: e[0], threadType: e[4] })
    }
    function query() {
      // biome-ignore lint/complexity/noArguments: The parser inspects Messenger's arguments alias.
      var e = arguments
      throw Error('DB write called')
      // biome-ignore lint/correctness/noUnreachable: Inspect this source without allowing database writes.
      return t.db
        .table(332)
        .put({ hasNextPage: e[2], nextPageCursor: e[3], resultCount: e[4] })
    }
    const make = (id, timestamp, threadId) => ({
      toplevelProtobuf: {
        messageId: id,
        threadId,
        timestampMs: timestamp,
        payload: new Uint8Array([1]),
      },
      supplementalProtobufs: new Map(),
      tags: [],
    })
    const tables = {
      threads: [
        { threadKey: '123', threadType: '15', threadName: 'Alice' },
        { threadKey: '789', threadType: '1', threadName: 'Unencrypted chat' },
      ],
      contacts: [
        { id: '123', name: 'Alice' },
        { id: '456', name: 'Another chat' },
      ],
      mi_act_mapping_table: [],
      messenger_fts_threads: [],
    }
    let requestId = 500
    window.__ready = crypto.subtle.digest('SHA-256', bytes).then((hash) => {
      const digest = btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      const modules = {
        CurrentUser: { getAccountID: () => '999' },
        LSDatabaseSingleton: {
          LSDatabaseSingleton: Promise.resolve({ tables }),
        },
        ReQL: { fromTableAscending: (x) => x, toArrayAsync: async (x) => x },
        I64: { to_string: String, of_string: String },
        MAWJids: {
          toUserJid: (x) => `${x}@msgr`,
          convertIntJidToChatJid: (x, g) => x + (g ? '@g.us' : '@msgr'),
        },
        LSMessagingThreadTypeUtil: {
          isGroup: (x) => x === '16',
          isArmadilloSecure: (x) => x === '15' || x === '16',
        },
        LSPlatformDeviceId: { deviceId: 'fixture' },
        LSVersion: 'fixture',
        LSPlatformRequestId: { generate: () => ++requestId },
        LSPlatformGraphQLLightspeedRequest: async (
          _device,
          id,
          payload,
          type,
        ) => {
          if (window.__failDiscovery) throw Error('fixture discovery failure')
          window.__calls.push([
            'list',
            JSON.parse(payload).tasks.map((t) => t.label),
            type,
          ])
          const p = JSON.parse(JSON.parse(payload).tasks[0].payload),
            first = p.timestamp > 50
          const guard = (step) => [
            1,
            [4, 0, 1, [5, 'taskExists', [19, String(id)]]],
            [23, [2, 0], [1, step]],
          ]
          return {
            payload: JSON.stringify({
              step: [
                1,
                guard([
                  5,
                  'row',
                  [19, first ? '123' : '456'],
                  [19, '0'],
                  [19, '0'],
                  [19, '0'],
                  [19, '15'],
                ]),
                guard([
                  5,
                  'query',
                  '',
                  [19, '0'],
                  first,
                  [19, first ? '50' : '0'],
                  [19, '1'],
                  '',
                ]),
                guard([4, 1, 1, [7, 'processFetchedFtsThreads', true]]),
                guard([5, 'removeTask', [19, String(id)], [9]]),
              ],
            }),
            dependencies: [],
          }
        },
        LSDynamicDependencies: {
          downloadRelayDependencies: async () => {},
          cachedModules: { row, query },
        },
        MpsOverBridge: {
          mps: () => ({
            loadMessages: async (args) => {
              window.__calls.push(['history', args.config])
              if (window.__holdHistory)
                await new Promise((resolve) => {
                  window.__releaseHistory = () => {
                    window.__holdHistory = false
                    resolve()
                  }
                })
              const first = args.from[0] > 100
              return {
                success: true,
                value: {
                  messages: [
                    make(
                      `${args.threadId}-${first ? 'new' : 'old'}`,
                      first ? 50 : 10,
                      args.threadId,
                    ),
                  ],
                  cursorInfo: {
                    hasNext: first && args.threadId === '123@msgr',
                    endCursor: [first ? 50 : 10, 'cursor'],
                  },
                },
              }
            },
          }),
        },
        MAWJobDefinitions: { mpsMessageToEncryptedBackupsMessage: (x) => x },
        MAWMsgType: { MSG_TYPE: {} },
        MAWHandleEchoProtobufsRestoreApi: {
          decodeDecryptedMessageProtobuf: (...args) => {
            const id = args[0].toplevelProtobuf.messageId
            if (id === '123@msgr-new')
              args[6].set(id, [
                {
                  mediaMetadata: {
                    plaintextHash: digest,
                    mediaEntryData: new Uint8Array([1]),
                    filename: 'test.txt',
                  },
                },
              ])
            return {
              metadata: { senderId: '123' },
              externalId: id,
              msgType: 'Text',
              decodedPayload: { text: `hello ${id}` },
              reactionData: [],
              editMsgData: [],
            }
          },
        },
        MAWBridge: {
          getBridge: () => ({
            sendAndReceive: async (...args) => {
              window.__calls.push(['media', args[0], args[1]])
              return {
                success: true,
                value: {
                  validatedResult: {
                    validatedPlaintext: bytes,
                    mimeType: 'text/plain',
                  },
                },
              }
            },
          }),
        },
      }
      modules.requireDeferred = (name) => ({
        load: () =>
          new Promise((resolve) => {
            window.__releaseModule = () => {
              window.__holdModule = false
              resolve(modules[name])
            }
          }),
      })
      window.__holdModule = true
      window.require = (name) => {
        if (!(name in modules) || (name === 'MAWBridge' && window.__holdModule))
          throw Error(`Missing ${name}`)
        return modules[name]
      }
    })
    return window.__ready
  })
  // Exercise the toolbar action from an unrelated tab.
  const unrelated = await browser.newPage()
  const extension = (await browser.extensions()).get(id)
  const opened = browser.waitForTarget(
    (target) => target.url() === `chrome-extension://${id}/assets/panel.html`,
  )
  await unrelated.triggerExtensionAction(extension)
  const panel = await (await opened).page()
  await panel.waitForFunction(
    `document.getElementById('connectionProgress')?.hidden === false && /[1-9][0-9]*s/.test(document.getElementById('status').textContent)`,
  )
  assert.equal(
    await panel.evaluate(`document.getElementById('start').disabled`),
    true,
  )
  assert.equal(
    await panel.evaluate(`document.getElementById('connect').disabled`),
    true,
  )
  await messenger.evaluate('window.__releaseModule()')
  await panel.waitForFunction(
    `document.getElementById('start')?.disabled === false`,
  )
  assert.match(
    await panel.evaluate(`document.getElementById('status').textContent`),
    /Ready/,
  )
  assert.equal(
    await panel.evaluate(`document.querySelector('select') === null`),
    true,
  )
  assert.equal(
    await panel.evaluate(`document.getElementById('connect').hidden`),
    true,
  )
  assert.equal(
    await panel.evaluate(
      `document.getElementById('connectionProgress').hidden`,
    ),
    true,
  )
  assert.equal(
    await panel.$eval('#start', (button) => button.textContent),
    'Start archive',
  )
  assert.equal(await panel.$eval('#export', (button) => button.disabled), true)
  await unrelated.bringToFront()
  await unrelated.triggerExtensionAction(extension)
  await panel.waitForFunction(
    async () => (await chrome.tabs.getCurrent()).active,
  )
  assert.equal(
    await worker.evaluate(
      async (url) => (await chrome.tabs.query({ url: `${url}*` })).length,
      panel.url(),
    ),
    1,
  )
  assert.equal(
    await panel.evaluate(
      `document.querySelector('#discover, #recheck, #repair, #pause')`,
    ),
    null,
  )
  console.log('Testing retrieval, repair, and reload…')
  await messenger.evaluate('window.__failDiscovery = true')
  await panel.evaluate(`document.getElementById('start').onclick()`)
  assert.match(
    await panel.evaluate(`document.getElementById('status').textContent`),
    /fixture discovery failure/,
  )
  assert.equal((await messenger.evaluate('window.__calls')).length, 0)
  await messenger.evaluate('window.__failDiscovery = false')
  await messenger.evaluate('window.__holdHistory = true')
  await panel.click('#start')
  await messenger.waitForFunction('window.__releaseHistory != null', {
    polling: 100,
  })
  assert.equal(
    await panel.$eval('#start', (button) => button.textContent),
    'Pause',
  )
  await panel.click('#start')
  assert.equal(
    await panel.$eval('#start', (button) => button.textContent),
    'Pausing…',
  )
  assert.equal(await panel.$eval('#start', (button) => button.disabled), true)
  await messenger.evaluate('window.__releaseHistory()')
  await panel.waitForFunction(
    `document.getElementById('start').textContent === 'Resume archive' && !document.getElementById('start').disabled`,
  )
  let status = await panel.$eval('#counts', (el) => el.textContent)
  assert.match(status, /3 chats/)
  assert.doesNotMatch(status, /unfinished|verified|coverage/)
  assert.equal(await panel.$eval('#export', (button) => button.disabled), false)
  // A reload must preserve the paused history cursor.
  await panel.reload()
  await panel.waitForFunction(
    `document.getElementById('start').textContent === 'Resume archive' && !document.getElementById('start').disabled`,
  )
  await panel.evaluate(`document.getElementById('start').onclick()`)
  status = await panel.evaluate(`document.getElementById('counts').textContent`)
  assert.match(status, /3 messages saved/)
  assert.match(status, /2 chats saved/)
  assert.match(status, /1\/1 attachments saved/)
  assert.equal(
    await panel.$eval('#start', (button) => button.textContent),
    'Update archive',
  )
  const calls = await messenger.evaluate('window.__calls')
  assert.deepEqual(
    calls.filter((c) => c[0] === 'list').map((c) => c.slice(1)),
    [
      [['760'], 3],
      [['760'], 3],
    ],
  )
  assert.ok(
    calls
      .filter((c) => c[0] === 'history')
      .every((c) => c[1].persistToReverb === 'no-persist'),
  )
  // A failed source and a stale decode issue can be repaired from local raw records.
  await panel.evaluate(`(async()=>{
    const {openArchive}=await import('../src/db.js');const db=await openArchive('999');
    const record=await db.get('messages',['123@msgr','123@msgr-new']);
    await db.saveMessage({...record,error:'fixture stale decode issue'});
    const thread=await db.get('threads','123@msgr');await db.put('threads',{...thread,decodeErrors:1});
    const [job]=await db.all('media');await db.saveMedia({...job,status:'error',error:'hash-mismatch',mediaEntry:MessengerArchiveCore.pack(new Uint8Array([9]))});
    await db.put('meta',{key:'run',complete:false});
    db.db.close();
  })()`)
  await panel.reload()
  await panel.waitForFunction(
    `document.getElementById('start').textContent === 'Resume archive' && !document.getElementById('start').disabled`,
  )
  const beforeRepair = await messenger.evaluate('window.__calls.length')
  await panel.evaluate(`document.getElementById('start').onclick()`)
  const repairCalls = (await messenger.evaluate('window.__calls')).slice(
    beforeRepair,
  )
  assert.deepEqual(repairCalls, [['media', 'backend', 'dyiDownloadMediaV2']])
  const repaired = await panel.evaluate(
    `(async()=>{const {openArchive}=await import('../src/db.js');const db=await openArchive('999');const t=await db.get('threads','123@msgr'),[m]=await db.all('media');db.db.close();return {issues:t.decodeErrors,status:t.status,pages:t.pages,media:m.status};})()`,
  )
  assert.deepEqual(repaired, {
    issues: 0,
    status: 'reached-start',
    pages: 2,
    media: 'saved',
  })
  const beforeRecheck = await messenger.evaluate('window.__calls.length')
  await messenger.evaluate(() => {
    window.__holdHistory = true
    window.__releaseHistory = null
  })
  await panel.click('#start')
  await messenger.waitForFunction('window.__releaseHistory != null', {
    polling: 100,
  })
  await panel.click('#start')
  await messenger.evaluate('window.__releaseHistory()')
  await panel.waitForFunction(
    `document.getElementById('start').textContent === 'Resume archive' && !document.getElementById('start').disabled`,
  )
  await panel.reload()
  await panel.waitForFunction(
    `document.getElementById('start').textContent === 'Resume archive' && !document.getElementById('start').disabled`,
  )
  await panel.evaluate(`document.getElementById('start').onclick()`)
  const recheckCalls = (await messenger.evaluate('window.__calls')).slice(
    beforeRecheck,
  )
  assert.equal(recheckCalls.filter((c) => c[0] === 'list').length, 2)
  assert.equal(recheckCalls.filter((c) => c[0] === 'history').length, 3)
  assert.equal(recheckCalls.filter((c) => c[0] === 'media').length, 0)
  assert.match(
    await panel.evaluate(`document.getElementById('counts').textContent`),
    /3 messages saved/,
  )
  assert.match(
    await panel.evaluate(`document.getElementById('counts').textContent`),
    /1\/1 attachments saved/,
  )
  // Reload the panel; its messages and media must remain in IndexedDB.
  await panel.reload()
  await panel.waitForFunction(
    `document.getElementById('start')?.disabled === false`,
  )
  assert.match(
    await panel.evaluate(`document.getElementById('counts').textContent`),
    /3 messages saved/,
  )
  console.log('Testing ZIP download…')
  const beforeExportCalls = await messenger.evaluate('window.__calls.length')
  await panel.evaluate(`document.getElementById('export').onclick()`)
  const exportStatus = await panel.evaluate(
    `document.getElementById('status').textContent`,
  )
  assert.match(exportStatus, /Saved archive:/)
  const downloads = await readdir(downloadsPath)
  assert.equal(downloads.length, 1)
  assert.match(downloads[0], /^messenger-archive-[^/]+\.zip$/)
  const files = await readZip(
      await readFile(join(downloadsPath, downloads[0])),
    ),
    manifest = JSON.parse(files['manifest.json'])
  assert.equal(manifest.messages, 3)
  assert.equal(manifest.exportComplete, true)
  assert.equal(manifest.attachmentsSaved, 1)
  const index = JSON.parse(files['threads.json'])
  assert.equal(index.length, 3)
  assert.equal(
    Object.keys(files).filter((p) => p.startsWith('media/')).length,
    1,
  )
  assert.equal(
    Object.entries(files)
      .find(([p]) => p.startsWith('media/'))[1]
      .toString(),
    'fixture attachment',
  )
  assert.equal(
    index.reduce(
      (n, t) =>
        n +
        files[`${t.directory}/messages.ndjson`]
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean).length,
      0,
    ),
    3,
  )
  assert.equal(
    await messenger.evaluate('window.__calls.length'),
    beforeExportCalls,
  )
  console.log('Testing every issue is accessible across pages…')
  await panel.evaluate(async () => {
    const { openArchive } = await import('../src/db.js')
    const db = await openArchive('999')
    const thread = await db.get('threads', '123@msgr')
    await db.put('threads', {
      ...thread,
      error: 'history issue',
      decodeErrors: 2,
    })
    const inventory = await db.get('meta', 'inventory')
    await db.put('meta', {
      ...inventory,
      error: 'inventory issue',
      complete: false,
    })
    for (let i = 0; i < 63; i++) {
      const id = `pagination-error-${String(i).padStart(3, '0')}`
      await db.saveMedia({
        id,
        jid: thread.jid,
        messageId: id,
        status: 'error',
        error: 'failed',
      })
    }
    for (let i = 0; i < 64; i++) {
      const messageId = `pagination-missing-${String(i).padStart(3, '0')}`
      await db.put('mediaIssues', {
        key: [thread.jid, messageId],
        jid: thread.jid,
        messageId,
      })
    }
    db.db.close()
  })
  await panel.reload()
  await panel.waitForFunction(`!document.getElementById('start').disabled`)
  assert.equal(
    await panel.$eval('#issueSummary', (el) => el.textContent),
    'Issues (129 entries)',
  )
  await panel.click('#issueSummary')
  await panel.waitForFunction(
    `document.getElementById('issueRange').textContent === '1–50 of 129 entries'`,
  )
  assert.equal(
    await panel.$$eval('#failures p', (entries) => entries.length),
    50,
  )
  assert.equal(await panel.$eval('#previousIssues', (el) => el.disabled), true)
  const issueTexts = await panel.$$eval('#failures p', (entries) =>
    entries.map((el) => el.textContent),
  )
  assert.match(
    issueTexts[0],
    /history issue.*2 messages could not be fully read/,
  )
  await panel.click('#nextIssues')
  await panel.waitForFunction(
    `document.getElementById('issueRange').textContent === '51–100 of 129 entries'`,
  )
  issueTexts.push(
    ...(await panel.$$eval('#failures p', (entries) =>
      entries.map((el) => el.textContent),
    )),
  )
  await panel.click('#nextIssues')
  await panel.waitForFunction(
    `document.getElementById('issueRange').textContent === '101–129 of 129 entries'`,
  )
  assert.equal(
    await panel.$$eval('#failures p', (entries) => entries.length),
    29,
  )
  issueTexts.push(
    ...(await panel.$$eval('#failures p', (entries) =>
      entries.map((el) => el.textContent),
    )),
  )
  assert.equal(new Set(issueTexts).size, 129)
  assert.ok(issueTexts.some((text) => text.includes('pagination-error-062')))
  assert.ok(issueTexts.some((text) => text.includes('pagination-missing-063')))
  assert.equal(await panel.$eval('#nextIssues', (el) => el.disabled), true)
  await panel.click('#previousIssues')
  await panel.waitForFunction(
    `document.getElementById('issueRange').textContent === '51–100 of 129 entries'`,
  )
  // Multiple tabs still connect automatically; retry follows a closed source tab.
  assert.match(
    await panel.evaluate(`document.getElementById('threads').textContent`),
    /Unencrypted — skipped/,
  )
  const second = await fakePage('https://www.facebook.com/messages/')
  await panel.evaluate(`document.getElementById('connect').onclick()`)
  assert.equal(
    await panel.evaluate(`document.querySelector('select') === null`),
    true,
  )
  assert.match(
    await panel.evaluate(`document.getElementById('counts').textContent`),
    /3 messages saved/,
  )
  await messenger.close()
  await panel.evaluate(`document.getElementById('connect').onclick()`)
  assert.equal(
    await panel.evaluate(`document.getElementById('connect').hidden`),
    false,
  )
  assert.equal(
    await panel.evaluate(`document.getElementById('start').disabled`),
    true,
  )
  await second.close()
  await panel.reload()
  await panel.waitForFunction(
    `document.getElementById('openMessenger')?.hidden === false`,
  )
  assert.equal(
    await panel.evaluate(`document.querySelector('select') === null`),
    true,
  )
  assert.equal(
    await panel.evaluate(`document.getElementById('start').disabled`),
    true,
  )
  console.log(
    'PASS: automatic connection, connection recovery, one archive control, pause/resume and updates across reloads, automatic repairs, all 129 issue entries across pages, ZIP download, attachment integrity, and local-only export.',
  )
} finally {
  try {
    await browser?.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
