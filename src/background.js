const api = globalThis.browser || chrome
api.action.onClicked.addListener((tab) => {
  const url = new URL(api.runtime.getURL('assets/panel.html'))
  if (/^https:\/\/(www\.)?(messenger\.com|facebook\.com)\//.test(tab.url || ''))
    url.searchParams.set('tab', tab.id)
  api.tabs.create({ url: url.href })
})
