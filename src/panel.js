import { attachmentProgress } from './attachment-progress.js'
import { openArchive } from './db.js'
import { downloadComplete } from './downloads.js'
import { archiveZip } from './export.js'
import { importCheckpoint } from './import.js'
import { repairArchive, retryAttachment } from './repair.js'

const api = globalThis.browser || chrome,
  C = globalThis.MessengerArchiveCore
const $ = (id) => document.getElementById(id)
let archive,
  account,
  tabId,
  operation = null,
  paused = false,
  connected = false,
  archiveState = {},
  issuePage = 0,
  issueRender = 0,
  issueData,
  storageUpdated = 0
const issuePageSize = 50
const say = (text, error = false) => {
  $('status').textContent = text
  $('status').className = error ? 'error' : ''
}
const enabled = () => {
  const archiving = operation === 'archive'
  const busy = operation !== null
  $('start').disabled =
    !archive || !connected || (busy && !archiving) || (archiving && paused)
  $('start').textContent = archiving
    ? paused
      ? 'Pausing…'
      : 'Pause'
    : archiveState.label || 'Start archive'
  $('export').disabled = !archive || !archiveState.hasData || busy
  $('connect').disabled = busy
  for (const id of [
    'importBackup',
    'cleanup',
    'clearLocal',
    'autoCleanup',
    'retainMessages',
  ])
    $(id).disabled = !archive || busy
  $('actionHelp').textContent = archiving
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
async function executeInMessenger(script) {
  const results = await api.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    ...script,
  })
  const injection = results[0]
  if (!injection) throw Error('Browser returned no script execution result.')
  if (injection.error != null)
    throw Error(String(injection.error.message || injection.error))
  return injection.result
}
async function rpc(action, args = {}) {
  let result
  try {
    result = await executeInMessenger({
      func: (action, args, account) => {
        if (typeof globalThis.MessengerArchivePage?.call !== 'function')
          return {
            ok: false,
            code: 'DISCONNECTED',
            error:
              'Messenger archive helper is missing from the page. Retry the connection.',
          }
        return globalThis.MessengerArchivePage.call(action, args, account)
      },
      args: [action, args, account || null],
    })
  } catch (e) {
    disconnected()
    throw Object.assign(
      Error(`Messenger request failed (${action}): ${e.message || e}`),
      { code: 'DISCONNECTED' },
    )
  }
  if (!result) {
    disconnected()
    throw Object.assign(
      Error(`Messenger returned no reply to ${action}. Retry the connection.`),
      { code: 'DISCONNECTED' },
    )
  }
  if (!result.ok) {
    if (['ACCOUNT_CHANGED', 'DISCONNECTED'].includes(result.code))
      disconnected()
    throw Object.assign(Error(result.error), {
      code: result.code,
      nativeCode: result.nativeCode,
    })
  }
  return result.value
}
async function refresh(forceStorage = false) {
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
  const [inventory, lastRun, exported] = await Promise.all([
    archive.get('meta', 'inventory'),
    archive.get('meta', 'run'),
    archive.count('media', 'status', 'exported'),
  ])
  const reached = threads.filter((t) => t.status === 'reached-start').length
  const errors = threads.filter((t) => t.status === 'error').length
  const skipped = threads.filter((t) => !t.encrypted).length
  const decodeIssues = threads.reduce((n, t) => n + (t.decodeErrors || 0), 0)
  const nameIssues = threads.filter((t) => t.nameError).length
  const issues = errors + failed + unresolved + decodeIssues + nameIssues
  const counts = [
    `${threads.length} chats`,
    `${messages.toLocaleString()} messages saved`,
    `${saved + exported}/${media} attachments saved`,
    `${reached} chats saved`,
  ]
  if (!inventory?.complete) counts.push('Finding chats unfinished')
  if (skipped) counts.push(`${skipped} unencrypted chats skipped`)
  if (errors) counts.push(`${errors} chats failed`)
  if (failed) counts.push(`${failed} attachments failed`)
  if (unresolved) counts.push(`${unresolved} attachments missing`)
  if (decodeIssues) counts.push(`${decodeIssues} messages need attention`)
  if (nameIssues)
    counts.push(
      `${nameIssues} contact name${nameIssues === 1 ? '' : 's'} unresolved`,
    )
  if (exported) counts.push(`${exported} attachments in earlier ZIPs`)
  $('counts').textContent = counts.join(' · ')
  if (
    forceStorage ||
    !operation ||
    operation === 'connect' ||
    Date.now() - storageUpdated > 30000
  ) {
    const usage = await archive.storageUsage()
    const estimate = await navigator.storage?.estimate().catch(() => null)
    const size = (n) => `${(n / 1048576).toFixed(1)} MiB`
    $('storage').textContent =
      `Attachment bytes in this browser: ${size(usage.attachmentBytes)}. Exported bytes removable: ${size(usage.reclaimableBytes)}.${estimate ? ` Browser storage for this extension: ${size(estimate.usage || 0)} of ${size(estimate.quota || 0)} quota.` : ''}`
    storageUpdated = Date.now()
  }
  const checkpoint = await archive.get('meta', 'backupSummary')
  $('backup').textContent = checkpoint
    ? `Latest confirmed backup: ${checkpoint.backupId}. Keep its baseline and all ${checkpoint.dependencies} dependencies.`
    : 'No confirmed backup yet. Import an existing ZIP to use it as your baseline.'
  const unfinished =
    !inventory?.complete ||
    threads.some((t) => t.encrypted && t.status !== 'reached-start') ||
    saved + exported < media ||
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
        thread.nameError ||
        (thread.decodeErrors
          ? `${thread.decodeErrors} messages could not be fully read`
          : ''),
    ]) {
      const cell = document.createElement('td')
      cell.textContent = text
      row.append(cell)
    }
    if (thread.error || thread.decodeErrors || thread.nameError)
      row.className = 'error'
    body.append(row)
  }
  $('threads').replaceChildren(body)
  const problemThreads = threads.filter(
    (t) => t.error || t.decodeErrors || t.nameError,
  )
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
      thread.nameError,
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
async function work(fn, kind = 'local') {
  if (!archive || operation) return
  operation = kind
  paused = false
  enabled()
  try {
    await navigator.locks.request(
      `messenger-archive-${account}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw Error(
            'This account is already being archived in another extension tab.',
          )
        try {
          await fn()
        } finally {
          await refresh(true)
        }
      },
    )
  } catch (e) {
    say(e.message, true)
  } finally {
    operation = null
    enabled()
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function retry(fn, waiting = () => {}) {
  let error
  for (let attempt = 0; attempt < 3; attempt++) {
    if (paused) return null
    try {
      return await fn(attempt)
    } catch (e) {
      if (
        [
          'HISTORY_CURSOR_STUCK',
          'ACCOUNT_CHANGED',
          'DISCONNECTED',
          'MEDIA_NOT_FOUND',
        ].includes(e.code)
      )
        throw e
      error = e
    }
    if (attempt < 2) {
      const delay = 1000 * 3 ** attempt
      waiting(attempt + 2, delay, error)
      await sleep(delay)
    }
  }
  throw error
}
async function discover() {
  say('Finding chats…')
  const local = await rpc('localInventory')
  local.names = {
    ...(await archive.get('meta', 'names'))?.value,
    ...local.names,
  }
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
  const [total, saved, exported, threads] = await Promise.all([
    archive.count('media'),
    archive.count('media', 'status', 'saved'),
    archive.count('media', 'status', 'exported'),
    archive.all('threads'),
  ])
  const names = new Map(threads.map((t) => [t.jid, t.name]))
  const stats = {
    total,
    queued: total - saved - exported,
    position: 0,
    saved: saved + exported,
    failed: 0,
  }
  for await (let job of archive.rows('media')) {
    if (paused) break
    if (['saved', 'exported'].includes(job.status)) continue
    stats.position++
    const progress = attachmentProgress(stats, job, names, say, () => paused)
    let token
    try {
      const download = await retryAttachment(
        job,
        rpc,
        retry,
        (updated) => archive.saveMedia(updated),
        progress.update,
      )
      job = download.job
      const result = download.result
      if (!result) break
      token = result.token
      progress.update({
        operation: 'transfer',
        job,
        bytes: 0,
        size: result.size,
      })
      await archive.beginMedia(job)
      let size = 0
      for (let offset = 0; offset < result.size; offset += 524288) {
        const data = C.base64ToBytes(await rpc('chunk', { token, offset }))
        if (data.length !== Math.min(524288, result.size - offset))
          throw Error('Attachment chunk has an unexpected size.')
        await archive.saveChunk(job.id, offset, data)
        size += data.length
        progress.update({ bytes: size })
      }
      if (size !== result.size) throw Error('Attachment transfer incomplete.')
      await archive.saveMedia({
        ...job,
        ...result,
        token: undefined,
        status: 'saved',
        backupId: undefined,
        path: undefined,
        error: null,
        nativeCode: null,
        savedAt: Date.now(),
      })
      stats.saved++
    } catch (e) {
      stats.failed++
      await archive.saveMedia({
        ...(e.job || job),
        status: 'error',
        error: e.message,
        nativeCode: e.nativeCode || null,
      })
    } finally {
      progress.stop()
      if (token) await rpc('release', { token }).catch(() => {})
    }
    await refresh()
  }
}
async function resolveNames() {
  const threads = await archive.all('threads')
  const names = { ...(await archive.get('meta', 'names'))?.value }
  for (const thread of threads) {
    if (paused) break
    if (!thread.encrypted || thread.jid !== `${thread.id}@msgr`) continue
    if (thread.name && thread.name !== thread.id && !thread.nameError) continue
    say(`Resolving contact name: ${thread.id}`)
    try {
      const cached = names[thread.id]
      const name =
        cached && cached !== thread.id
          ? cached
          : await rpc('contactName', { id: thread.id })
      if (!name || name === thread.id)
        throw Error('Messenger returned no contact name.')
      names[thread.id] = name
      await archive.put('meta', { key: 'names', value: names })
      await archive.put('threads', { ...thread, name, nameError: null })
    } catch (error) {
      if (['ACCOUNT_CHANGED', 'DISCONNECTED'].includes(error.code)) throw error
      await archive.put('threads', {
        ...thread,
        nameError: `Contact name lookup failed: ${error.message}`,
      })
    }
  }
  await refresh()
}
async function start() {
  await refresh()
  if (archiveState.complete)
    await archive.beginUpdate([Date.now() + 60000, null])
  else await archive.put('meta', { key: 'run', complete: false })
  const inventory = await archive.get('meta', 'inventory')
  if (!paused && !inventory?.complete) await discover()
  if (!paused) await fetchHistories()
  if (!paused) await resolveNames()
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
async function download(blob, filename, started) {
  const url = URL.createObjectURL(blob)
  try {
    const id = await api.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
    })
    await started(id)
    return (await downloadComplete(api.downloads, id)).filename
  } finally {
    URL.revokeObjectURL(url)
  }
}
async function exportArchive() {
  try {
    let snapshot
    const options = {
      cleanup: !!$('autoCleanup').checked,
      retainMessages: !!$('retainMessages').checked,
    }
    const blob = await archiveZip(
      archive,
      account,
      say,
      () => paused,
      async (value) => {
        snapshot = value
        await archive.put('meta', { key: 'pendingExport', snapshot, options })
      },
    )
    const filename = `messenger-archive-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
    const path = await download(blob, filename, (downloadId) =>
      archive.put('meta', {
        key: 'pendingExport',
        snapshot,
        options,
        downloadId,
      }),
    )
    await archive.finalizeBackup(snapshot, { ...options, filename: path })
    say(`Saved archive: ${path}. Keep this ZIP and its dependencies.`)
  } catch (error) {
    if (error.name !== 'AbortError') throw error
    say(error.message)
  }
}
async function recoverDownload() {
  const pending = await archive.get('meta', 'pendingExport')
  if (pending?.downloadId == null) return
  const summary = await archive.get('meta', 'backupSummary')
  if ((summary?.backupId || null) !== pending.snapshot.parentId) return
  const [item] = await api.downloads.search({ id: pending.downloadId })
  if (item?.state === 'complete' && item.exists !== false)
    await archive.finalizeBackup(pending.snapshot, {
      ...pending.options,
      filename: item.filename,
    })
}
async function connect(preferredTab) {
  if (operation) return
  operation = 'connect'
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
    // Firefox resolves unprefixed paths relative to assets/panel.html.
    for (const file of ['/src/core.js', '/src/adapter.js']) {
      try {
        await executeInMessenger({ files: [file] })
      } catch (e) {
        throw Error(
          `Could not load Messenger helper (${file}): ${e.message || e}`,
        )
      }
    }
    const probe = await rpc('probe')
    if (probe.missing.length)
      throw Error(
        'Messenger is not ready. Restore your history in Messenger, then retry the connection.',
      )
    account = probe.account
    progress('Opening saved archive…')
    archive = await openArchive(account, progress)
    const settings = await archive.get('meta', 'settings')
    $('autoCleanup').checked = settings?.autoCleanup || false
    $('retainMessages').checked = settings?.retainMessages !== false
    await navigator.locks.request(
      `messenger-archive-${account}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await recoverDownload()
      },
    )
    await refresh()
    connected = true
    say('Ready. Keep Messenger open while archiving.')
  } catch (e) {
    $('connect').hidden = false
    $('connection').hidden = false
    say(e.message, true)
  } finally {
    clearInterval(timer)
    operation = null
    $('connectionProgress').hidden = true
    enabled()
  }
}
$('connect').onclick = () => connect(tabId)
$('openMessenger').onclick = () =>
  api.tabs.create({ url: 'https://www.messenger.com/' })
$('start').onclick = () => {
  if (operation === 'archive') {
    paused = true
    enabled()
    say('Pausing after the current request…')
    return
  }
  if (connected) return work(start, 'archive')
}
$('export').onclick = () => work(exportArchive, 'export')
$('importBackup').onchange = () =>
  work(async () => {
    const file = $('importBackup').files?.[0]
    if (!file) return
    try {
      const checkpoint = await importCheckpoint(file, account)
      await archive.importBackup(checkpoint)
      say(
        'Backup imported. Update archive finishes interrupted history scans and checks completed chats for new messages.',
      )
    } finally {
      $('importBackup').value = ''
    }
  })
$('cleanup').onclick = () =>
  work(async () => {
    await archive.cleanupExported({ messages: !$('retainMessages').checked })
    say('Removed exported local bytes. Keep the ZIPs that contain them.')
  })
$('clearLocal').onclick = () =>
  work(async () => {
    if (
      !globalThis.confirm(
        'Delete ALL local archive data, including unfinished messages, attachments, and checkpoint? ZIP files are unchanged. Import your latest ZIP or checkpoint to resume.',
      )
    )
      return
    await archive.clearLocal()
    say(
      'All local archive data deleted. Import a backup or start a new archive.',
    )
  })
for (const id of ['autoCleanup', 'retainMessages'])
  $(id).onchange = () =>
    work(() =>
      archive.put('meta', {
        key: 'settings',
        autoCleanup: !!$('autoCleanup').checked,
        retainMessages: !!$('retainMessages').checked,
      }),
    )
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
    !operation &&
    (id === tabId ||
      (!archive &&
        /^https:\/\/(?:www\.)?(?:messenger\.com\/|facebook\.com\/messages\/)/.test(
          tab.url || '',
        )))
  )
    void connect(id)
})
await connect(Number(new URL(location.href).searchParams.get('tab')))
