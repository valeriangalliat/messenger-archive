const api = globalThis.browser || chrome
let opening
async function openArchiveTab(tab) {
  const panel = api.runtime.getURL('assets/panel.html')
  const [existing] = await api.tabs.query({ url: `${panel}*` })
  if (existing) {
    await api.tabs.update(existing.id, { active: true })
    await api.windows.update(existing.windowId, { focused: true })
    return
  }
  const url = new URL(panel)
  if (/^https:\/\/(www\.)?(messenger\.com|facebook\.com)\//.test(tab.url || ''))
    url.searchParams.set('tab', tab.id)
  await api.tabs.create({ url: url.href })
}
api.action.onClicked.addListener((tab) => {
  opening ||= openArchiveTab(tab).finally(() => {
    opening = null
  })
  return opening
})
