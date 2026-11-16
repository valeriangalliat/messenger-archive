import {
  attachmentSource,
  attachmentSources,
  sourceKey,
} from './attachments.js'
// Re-decode selected local records and collect alternate attachment metadata.
export async function repairArchive(archive, rpc, progress, paused) {
  const ids = new Set(),
    groups = new Map()
  for await (const job of archive.rows('media'))
    if (job.status === 'error') ids.add(job.id)
  let scanned = 0
  for await (const message of archive.rows('messages')) {
    if (paused()) return ids
    if (++scanned % 2000 === 0)
      progress(
        `Checking saved records for issues and alternate attachments… ${scanned.toLocaleString()}`,
      )
    if (!message.error && !message.attachments?.some((id) => ids.has(id)))
      continue
    if (!groups.has(message.jid)) groups.set(message.jid, [])
    groups.get(message.jid).push(message.raw)
  }
  for (const [jid, raw] of groups)
    for (let offset = 0; offset < raw.length; offset += 100) {
      if (paused()) return ids
      progress(`Re-decoding saved records from ${jid}…`)
      const page = await rpc('redecode', {
        jid,
        raw: raw.slice(offset, offset + 100),
      })
      await archive.repairPage(jid, page)
      for (const job of page.attachments) ids.add(job.id)
    }
  return ids
}

export async function retryAttachment(
  initial,
  rpc,
  retry,
  checkpoint = async () => {},
  progress = () => {},
) {
  const candidates = attachmentSources(initial)
  const sources = new Map(candidates.map((s) => [sourceKey(s), s]))
  let job = { ...initial },
    lastError
  const select = (source) => {
    if (
      source.id !== initial.id ||
      source.expectedHash !== initial.expectedHash
    )
      throw Error(
        'Attachment source has a different identifier or expected hash.',
      )
    sources.set(sourceKey(source), attachmentSource(source))
    job = {
      ...job,
      ...source,
      sources: [...sources.values()].filter(
        (s) => sourceKey(s) !== sourceKey(source),
      ),
    }
  }
  const record = async (operation, error) => {
    const entry = {
      at: Date.now(),
      operation,
      jid: job.jid,
      messageId: job.messageId,
      timestamp: job.timestamp,
      error: error ? String(error.message || error) : null,
      code: error?.code || null,
      nativeCode: error?.nativeCode || null,
      representation:
        job.mediaKind === 'photo' && job.photoMode !== 'full'
          ? 'native-preview'
          : 'full',
      previewAdvertised: error?.previewAdvertised ?? null,
    }
    job = {
      ...job,
      downloadAttempts: [...(job.downloadAttempts || []), entry].slice(-50),
    }
    await checkpoint(job)
  }
  const fatal = (error) =>
    ['ACCOUNT_CHANGED', 'DISCONNECTED'].includes(error.code)
  const missingPreviews = []
  let uncertainPreview = false
  async function trySource(candidate, index, mode, fallback = false) {
    select(candidate)
    job = { ...job, photoMode: mode }
    const report = (operation, attempt, details = {}) =>
      progress({
        operation,
        attempt,
        source: index + 1,
        sources: candidates.length,
        job,
        fallback,
        ...details,
      })
    // Each source and representation has its own transient retry budget.
    const result = await retry(
      async (attempt) => {
        if (attempt === 1) {
          report('refreshMedia', attempt + 1)
          try {
            select(await rpc('refreshMedia', job))
            await record('refreshMedia')
          } catch (error) {
            await record('refreshMedia', error)
            if (fatal(error)) throw error
          }
        }
        let result
        report('media', attempt + 1)
        try {
          result = await rpc('media', job)
        } catch (error) {
          await record('media', error)
          throw error
        }
        try {
          await record('media')
        } catch (error) {
          if (result?.token)
            await rpc('release', { token: result.token }).catch(() => {})
          throw error
        }
        return result
      },
      (attempt, delay, error) =>
        report('waiting', attempt, {
          delay,
          error: String(error.message || error),
        }),
    )
    return {
      job,
      result:
        fallback && result
          ? {
              ...result,
              representation: 'full-fallback',
              requestedRepresentation: 'native-preview',
              fallbackReason: 'preview-media-not-found',
            }
          : result,
    }
  }
  for (const [index, candidate] of candidates.entries()) {
    try {
      return await trySource(candidate, index, initial.photoMode)
    } catch (error) {
      lastError = error
      if (
        error.code === 'MEDIA_NOT_FOUND' &&
        error.previewAdvertised === true &&
        job.mediaKind === 'photo' &&
        initial.photoMode !== 'full'
      )
        missingPreviews.push({ source: attachmentSource(job), index })
      else if (
        error.code !== 'MEDIA_NOT_FOUND' ||
        error.previewAdvertised !== false
      )
        uncertainPreview = true
      if (fatal(error)) break
    }
  }
  // Exhaust the smaller sources first. An unknown failure leaves uncertainty;
  // only explicit not-found results for advertised previews allow escalation.
  if (!uncertainPreview)
    for (const { source, index } of missingPreviews)
      try {
        return await trySource(source, index, 'full', true)
      } catch (error) {
        lastError = error
        if (fatal(error)) break
      }
  throw Object.assign(lastError || Error('No attachment sources available.'), {
    job,
  })
}
