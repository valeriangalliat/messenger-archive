// One timer per attachment, including retries and byte transfer.
export function attachmentProgress(stats, job, names, say, paused) {
  const started = Date.now()
  let state = { operation: 'media', attempt: 1, source: 1, sources: 1, job },
    retryAt = 0
  const render = () => {
    if (paused()) return
    const current = state.job,
      elapsed = Math.floor((Date.now() - started) / 1000),
      name = names.get(current.jid) || current.jid,
      kind = current.mediaKind === 'photo' ? 'Photo' : 'Attachment',
      stage =
        state.operation === 'waiting'
          ? `Retry in ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))}s`
          : state.operation === 'refreshMedia'
            ? 'Refreshing download details'
            : state.operation === 'transfer'
              ? `Saving bytes: ${Math.floor((100 * state.bytes) / state.size)}%`
              : 'Downloading',
      source =
        state.sources > 1 ? ` · source ${state.source}/${state.sources}` : ''
    say(
      `Attachment ${stats.position.toLocaleString()} of ${stats.queued.toLocaleString()} this run · ${stats.saved.toLocaleString()}/${stats.total.toLocaleString()} saved · ${stats.failed.toLocaleString()} failed this run\n` +
        `${name} · ${kind} · ${stage} · attempt ${state.attempt}/3${source} · ${elapsed}s on this attachment\n` +
        `Attachment ID: ${current.id}${current.filename ? ` · ${current.filename}` : ''}` +
        (state.operation === 'waiting' ? `\nLast error: ${state.error}` : ''),
    )
  }
  render()
  const timer = setInterval(render, 1000)
  return {
    update(details) {
      state = { ...state, ...details }
      if (details.operation === 'waiting') retryAt = Date.now() + details.delay
      render()
    },
    stop: () => clearInterval(timer),
  }
}
