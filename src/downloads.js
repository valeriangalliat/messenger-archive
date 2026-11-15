// Subscribe before checking state: a small file may already be complete.
export function downloadComplete(downloads, id) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, item) => {
      if (settled) return
      settled = true
      downloads.onChanged.removeListener(changed)
      downloads.onErased.removeListener(erased)
      if (error) reject(error)
      else resolve(item)
    }
    const check = async () => {
      try {
        const [item] = await downloads.search({ id })
        if (!item || item.state === 'interrupted')
          finish(
            Error(
              'File download interrupted. Saved browser data is still available.',
            ),
          )
        else if (item.state === 'complete') finish(null, item)
      } catch (error) {
        finish(error)
      }
    }
    const changed = (delta) => {
      if (
        delta.id === id &&
        ['complete', 'interrupted'].includes(delta.state?.current)
      )
        void check()
    }
    const erased = (erasedId) => {
      if (erasedId === id)
        finish(
          Error(
            'File download removed. Saved browser data is still available.',
          ),
        )
    }
    try {
      downloads.onChanged.addListener(changed)
      downloads.onErased.addListener(erased)
      void check()
    } catch (error) {
      finish(error)
    }
  })
}
