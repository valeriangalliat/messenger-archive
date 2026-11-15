import { openArchive } from './db.js'
import { downloadComplete } from './downloads.js'
import { archiveZip } from './export.js'
import { repairArchive, retryAttachment } from './repair.js'

const api = globalThis.browser || chrome,
  C = globalThis.MessengerArchiveCore
const $ = (id) => document.getElementById(id)
let archive,
  account,
  tabId,
  running = false,
  paused = false,
  connecting = false,
  connected = false,
  exporting = false,
  archiveState = {},
  issuePage = 0,
  issueRender = 0,
  issueData
const issuePageSize = 50
const say = (text, error = false) => {
  $('status').textContent = text
  $('status').className = error ? 'error' : ''
}
const enabled = () => {
  $('start').disabled =
    !archive || connecting || !connected || exporting || (running && paused)
  $('start').textContent =
    running && !exporting
      ? paused
        ? 'Pausing…'
        : 'Pause'
      : archiveState.label || 'Start archive'
  $('export').disabled =
    !archive || !archiveState.hasData || running || connecting
  $('connect').disabled = running || connecting
  $('actionHelp').textContent =
    running && !exporting
      ? 'Keep Messenger and this tab open. Pause saves your place.'
      : archiveState.help ||
        'Keep Messenger and this tab open. Your progress is saved automatically.'
}
function disconnected() {
  connected = false
  paused = true
  $('connect').hidden = false
  $('connection').hidden = false
}
async function rpc(action, args = {}) {
  let results
  try {
    results = await api.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (action, args, account) =>
        globalThis.MessengerArchivePage?.call(action, args, account),
      args: [action, args, account || null],
    })
  } catch {
    disconnected()
    throw Object.assign(
      Error(
        'Messenger disconnected. Open Messenger, then retry the connection.',
      ),
      { code: 'DISCONNECTED' },
    )
  }
  const result = results[0]?.result
  if (!result) {
    disconnected()
    throw Object.assign(
      Error('Messenger reloaded. Retry the connection to resume.'),
      { code: 'DISCONNECTED' },
    )
  }
  if (!result.ok) {
    if (result.code === 'ACCOUNT_CHANGED') disconnected()
    throw Object.assign(Error(result.error), { code: result.code })
  }
  return result.value
}
async function refresh() {
  if (!archive) return
  const [threads, messages, media, saved, failed, unresolved] =
    await Promise.all([
      archive.all('threads'),
      archive.count('messages'),
      archive.count('media'),
      archive.count('media', 'status', 'saved'),
      archive.count('media', 'status', 'error'),
      archive.count('mediaIssues'),
    ])
  const [inventory, lastRun] = await Promise.all([
    archive.get('meta', 'inventory'),
    archive.get('meta', 'run'),
  ])
  const reached = threads.filter((t) => t.status === 'reached-start').length
  const errors = threads.filter((t) => t.status === 'error').length
  const skipped = threads.filter((t) => !t.encrypted).length
  const decodeIssues = threads.reduce((n, t) => n + (t.decodeErrors || 0), 0)
  const issues = errors + failed + unresolved + decodeIssues
  const counts = [
    `${threads.length} chats`,
    `${messages.toLocaleString()} messages saved`,
    `${saved}/${media} attachments saved`,
    `${reached} chats saved`,
  ]
  if (!inventory?.complete) counts.push('Finding chats unfinished')
  if (skipped) counts.push(`${skipped} unencrypted chats skipped`)
  if (errors) counts.push(`${errors} chats failed`)
  if (failed) counts.push(`${failed} attachments failed`)
  if (unresolved) counts.push(`${unresolved} attachments missing`)
  if (decodeIssues) counts.push(`${decodeIssues} messages need attention`)
  $('counts').textContent = counts.join(' · ')
  const unfinished =
    !inventory?.complete ||
    threads.some((t) => t.encrypted && t.status !== 'reached-start') ||
    saved < media ||
    issues > 0
  const complete = lastRun?.complete || !unfinished
  archiveState = {
    hasData: threads.length > 0 || messages > 0 || media > 0,
    complete,
    label:
      !inventory && !threads.length
        ? 'Start archive'
        : !complete
          ? 'Resume archive'
          : 'Update archive',
    help:
      !inventory && !threads.length
        ? 'Find chats and save their messages and attachments. Your progress is saved automatically.'
        : !complete
          ? 'Continue from your saved progress and retry issues automatically. Download ZIP saves what you have so far.'
          : 'Update archive finds new chats and messages and retries issues. Download ZIP saves a copy to your computer.',
  }
  enabled()
  const body = document.createDocumentFragment()
  for (const thread of threads.sort((a, b) => a.name.localeCompare(b.name))) {
    const row = document.createElement('tr')
    for (const text of [
      thread.name,
      {
        unencrypted: 'Unencrypted — skipped',
        pending: 'Waiting',
        'reached-start': 'Saved',
        error: 'Failed',
      }[thread.status] || thread.status,
      thread.oldest != null && Number.isFinite(thread.oldest)
        ? new Date(thread.oldest).toLocaleString()
        : '—',
      thread.error ||
        (thread.decodeErrors
          ? `${thread.decodeErrors} messages could not be fully read`
          : ''),
    ]) {
      const cell = document.createElement('td')
      cell.textContent = text
      row.append(cell)
    }
    if (thread.error || thread.decodeErrors) row.className = 'error'
    body.append(row)
  }
  $('threads').replaceChildren(body)
  const problemThreads = threads.filter((t) => t.error || t.decodeErrors)
  const total =
    problemThreads.length + failed + unresolved + Number(!!inventory?.error)
  issueData = { threads, problemThreads, inventory, failed, unresolved, total }
  issuePage = Math.min(
    issuePage,
    Math.max(0, Math.ceil(total / issuePageSize) - 1),
  )
  $('issueSummary').textContent = `Issues (${total.toLocaleString()} entries)`
  $('failureDetails').hidden = !total
  if ($('failureDetails').open) await renderIssues()
}
async function* issueEntries(data) {
  for (const thread of data.problemThreads)
    yield `${thread.name}: ${[
      thread.error,
      thread.decodeErrors
        ? `${thread.decodeErrors} messages could not be fully read.`
        : '',
    ]
      .filter(Boolean)
      .join(' ')}`
  if (data.inventory?.error) yield `Finding chats: ${data.inventory.error}`
  const names = new Map(data.threads.map((t) => [t.jid, t.name]))
  if (data.failed)
    for await (const job of archive.rows('media'))
      if (job.status === 'error')
        yield `${names.get(job.jid) || job.jid}: Attachment download failed (message ${job.messageId || 'unknown'}, attachment ${job.id}). ${job.error || ''}`
  if (data.unresolved)
    for await (const issue of archive.rows('mediaIssues'))
      yield `${names.get(issue.jid) || issue.jid}: An attachment could not be found (message ${issue.messageId}).`
}
async function renderIssues() {
  const data = issueData,
    render = ++issueRender
  if (!data || !$('failureDetails').open) return
  const from = issuePage * issuePageSize
  const failures = document.createDocumentFragment()
  let index = 0
  for await (const text of issueEntries(data)) {
    if (render !== issueRender) return
    if (index++ < from) continue
    const p = document.createElement('p')
    p.textContent = text
    failures.append(p)
    if (index >= from + issuePageSize) break
  }
  if (render !== issueRender) return
  $('failures').replaceChildren(failures)
  $('issueRange').textContent =
    `${data.total ? from + 1 : 0}–${Math.min(from + issuePageSize, data.total)} of ${data.total.toLocaleString()} entries`
  $('issuePages').hidden = data.total <= issuePageSize
  $('previousIssues').disabled = issuePage === 0
  $('nextIssues').disabled = from + issuePageSize >= data.total
}
async function work(fn) {
  if (!archive || running || connecting) return
  const run = async (lock) => {
    if (!lock)
      throw Error(
        'This account is already being archived in another extension tab.',
      )
    running = true
    paused = false
    enabled()
    try {
      await fn()
    } finally {
      running = false
      enabled()
      await refresh()
    }
  }
  try {
    await navigator.locks.request(
      `messenger-archive-${account}`,
      { ifAvailable: true },
      run,
    )
  } catch (e) {
    say(e.message, true)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function retry(fn) {
  let error
  for (let attempt = 0; attempt < 3; attempt++) {
    if (paused) return null
    try {
      return await fn(attempt)
    } catch (e) {
      if (
        ['HISTORY_CURSOR_STUCK', 'ACCOUNT_CHANGED', 'DISCONNECTED'].includes(
          e.code,
        )
      )
        throw e
      error = e
    }
    if (attempt < 2) await sleep(1000 * 3 ** attempt)
  }
  throw error
}
async function discover() {
  say('Finding chats…')
  const local = await rpc('localInventory')
  await archive.put('meta', { key: 'names', value: local.names })
  await archive.discover(local.threads)
  let state = await archive.get('meta', 'inventory')
  if (!state)
    state = { cursor: '9223372036854775807', complete: false, pages: 0 }
  await archive.put('meta', { ...state, key: 'inventory', error: null })
  while (!state.complete && !paused) {
    say(`Finding chats… page ${state.pages + 1}`)
    try {
      const page = await retry(() => rpc('listPage', { cursor: state.cursor }))
      if (!page) break
      const next = C.inventoryCursor(state.cursor, page.cursor, page.hasMore)
      state = {
        cursor: next || state.cursor,
        complete: next === null,
        pages: state.pages + 1,
      }
      for (const t of page.threads) t.name = local.names[t.id] || t.name
      await archive.discover(page.threads, state)
      await refresh()
      if (!state.complete) await sleep(300)
    } catch (e) {
      await archive.put('meta', {
        ...state,
        key: 'inventory',
        error: e.message,
      })
      throw e
    }
  }
}
async function fetchHistories() {
  const threads = await archive.all('threads')
  for (const initial of threads.filter(
    (t) => t.encrypted && t.status !== 'reached-start',
  )) {
    let thread = await archive.get('threads', initial.jid)
    while (thread.status !== 'reached-start' && !paused) {
      say(`Saving history: ${thread.name} · ${thread.pages || 0} pages saved`)
      try {
        const page = await retry((attempt) =>
          rpc('history', {
            jid: thread.jid,
            cursor: thread.cursor,
            batchSize: Math.max(20, Math.floor(100 / 2 ** attempt)),
          }),
        )
        if (!page) break
        await archive.commitPage(thread, page)
        thread = await archive.get('threads', thread.jid)
        await refresh()
        if (page.next) await sleep(200)
      } catch (e) {
        await archive.put('threads', {
          ...thread,
          status: 'error',
          error: e.message,
        })
        await refresh()
        break // Leave its cursor intact, continue other conversations.
      }
    }
    if (paused) break
  }
}
async function fetchMedia() {
  for await (let job of archive.rows('media')) {
    if (paused) break
    if (job.status === 'saved') continue
    say(`Downloading attachment from ${job.jid}…`)
    let token
    try {
      const download = await retryAttachment(job, rpc, retry, (updated) =>
        archive.put('media', updated),
      )
      job = download.job
      const result = download.result
      if (!result) break
      token = result.token
      await archive.beginMedia(job)
      let size = 0
      for (let offset = 0; offset < result.size; offset += 524288) {
        const data = C.base64ToBytes(await rpc('chunk', { token, offset }))
        if (data.length !== Math.min(524288, result.size - offset))
          throw Error('Attachment chunk has an unexpected size.')
        await archive.saveChunk(job.id, offset, data)
        size += data.length
      }
      if (size !== result.size) throw Error('Attachment transfer incomplete.')
      await archive.put('media', {
        ...job,
        ...result,
        token: undefined,
        status: 'saved',
        error: null,
        savedAt: Date.now(),
      })
    } catch (e) {
      await archive.put('media', {
        ...(e.job || job),
        status: 'error',
        error: e.message,
      })
    } finally {
      if (token) await rpc('release', { token }).catch(() => {})
    }
    await refresh()
  }
}
async function resetHistories(cursor) {
  const threads = await archive.all('threads')
  for (const thread of threads.filter((t) => t.encrypted)) {
    await archive.put('threads', {
      ...thread,
      status: 'pending',
      cursor,
      pages: 0,
      error: null,
    })
  }
}
async function start() {
  await refresh()
  let update = await archive.get('meta', 'update')
  if (archiveState.complete || update?.pending) {
    // Persist the reset intent so closing the panel halfway through is safe.
    if (!update?.pending) {
      update = {
        key: 'update',
        pending: true,
        cursor: [Date.now() + 60000, null],
      }
      await archive.put('meta', update)
    }
    await archive.put('meta', { key: 'run', complete: false })
    await archive.put('meta', {
      key: 'inventory',
      cursor: '9223372036854775807',
      complete: false,
      pages: 0,
    })
    await resetHistories(update.cursor)
    await archive.put('meta', { ...update, pending: false })
  } else await archive.put('meta', { key: 'run', complete: false })
  const inventory = await archive.get('meta', 'inventory')
  if (!paused && !inventory?.complete) await discover()
  if (!paused) await fetchHistories()
  if (
    !paused &&
    (issueData.failed ||
      issueData.unresolved ||
      issueData.problemThreads.some((t) => t.decodeErrors))
  ) {
    say('Retrying issues in saved messages…')
    await repairArchive(archive, rpc, say, () => paused)
  }
  if (!paused) await fetchMedia()
  if (!paused) await archive.put('meta', { key: 'run', complete: true })
  await refresh()
  say(
    paused
      ? 'Paused. Your progress is saved.'
      : $('failureDetails').hidden
        ? 'Archive finished. Click Download ZIP to save it.'
        : 'Archive finished with issues. See Issues, or download the saved data.',
  )
}
async function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  try {
    const id = await api.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
    })
    return (await downloadComplete(api.downloads, id)).filename
  } finally {
    URL.revokeObjectURL(url)
  }
}
async function exportArchive() {
  try {
    const blob = await archiveZip(archive, account, say, () => paused)
    const filename = `messenger-archive-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
    const path = await download(blob, filename)
    say(`Saved archive: ${path}`)
  } catch (error) {
    if (error.name !== 'AbortError') throw error
    say(error.message)
  }
}
async function connect(preferredTab) {
  if (running || connecting) return
  connecting = true
  connected = false
  if (archive) archive.db.close()
  archive = null
  account = null
  archiveState = {}
  issueData = null
  issuePage = 0
  issueRender++
  $('counts').textContent = ''
  $('threads').replaceChildren()
  $('failureDetails').hidden = true
  enabled()
  $('connectionProgress').hidden = false
  $('connect').hidden = true
  $('openMessenger').hidden = true
  let stage = 'Connecting to Messenger…'
  const started = Date.now()
  const progress = (text) => {
    stage = text
    say(text)
  }
  progress(stage)
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000)
    say(
      `${stage} ${seconds}s${seconds >= 10 ? '. If Messenger asks for your history PIN, enter it there.' : ''}`,
    )
  }, 1000)
  try {
    const tabs = await api.tabs.query({
      url: [
        'https://www.messenger.com/*',
        'https://messenger.com/*',
        'https://www.facebook.com/messages/*',
      ],
    })
    const selected =
      tabs.find((t) => t.id === preferredTab) ||
      tabs.find((t) => t.active) ||
      tabs[0]
    $('connection').hidden = true
    tabId = selected?.id
    if (!tabId) {
      $('openMessenger').hidden = false
      $('connection').hidden = false
      say('Open Messenger and sign in to begin.')
      return
    }
    await api.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['src/core.js', 'src/adapter.js'],
    })
    const probe = await rpc('probe')
    if (probe.missing.length)
      throw Error(
        'Messenger is not ready. Restore your history in Messenger, then retry the connection.',
      )
    account = probe.account
    progress('Opening saved archive…')
    archive = await openArchive(account, progress)
    await refresh()
    connected = true
    say('Ready. Keep Messenger open while archiving.')
  } catch (e) {
    $('connect').hidden = false
    $('connection').hidden = false
    say(e.message, true)
  } finally {
    clearInterval(timer)
    connecting = false
    $('connectionProgress').hidden = true
    enabled()
  }
}
$('connect').onclick = () => connect(tabId)
$('openMessenger').onclick = () =>
  api.tabs.create({ url: 'https://www.messenger.com/' })
$('start').onclick = () => {
  if (running && !exporting) {
    paused = true
    enabled()
    say('Pausing after the current request…')
    return
  }
  if (connected) return work(start)
}
$('export').onclick = () =>
  work(async () => {
    exporting = true
    enabled()
    try {
      await exportArchive()
    } finally {
      exporting = false
    }
  })
$('failureDetails').ontoggle = () =>
  renderIssues().catch((e) => say(e.message, true))
for (const [id, step] of [
  ['previousIssues', -1],
  ['nextIssues', 1],
])
  $(id).onclick = () => {
    issuePage = Math.max(
      0,
      Math.min(
        issuePage + step,
        Math.ceil((issueData?.total || 0) / issuePageSize) - 1,
      ),
    )
    return renderIssues().catch((e) => say(e.message, true))
  }
api.tabs.onUpdated.addListener((id, change, tab) => {
  if (
    change.status === 'complete' &&
    !running &&
    !connecting &&
    (id === tabId ||
      (!archive &&
        /^https:\/\/(?:www\.)?(?:messenger\.com\/|facebook\.com\/messages\/)/.test(
          tab.url || '',
        )))
  )
    void connect(id)
})
await connect(Number(new URL(location.href).searchParams.get('tab')))
