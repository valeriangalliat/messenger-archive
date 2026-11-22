import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('../src/background.js', import.meta.url),
  'utf8',
)
const panel = 'chrome-extension://archive/assets/panel.html'

function fixture() {
  const tabs = [],
    calls = []
  let click
  vm.runInNewContext(source, {
    URL,
    browser: {
      runtime: { getURL: () => panel },
      action: {
        onClicked: {
          addListener: (fn) => {
            click = fn
          },
        },
      },
      tabs: {
        query: async ({ url }) =>
          tabs.filter((t) => t.url.startsWith(url.slice(0, -1))),
        create: async ({ url }) => {
          const tab = { id: 42, windowId: 7, url }
          tabs.push(tab)
          calls.push(['create', url])
          return tab
        },
        update: async (id, options) =>
          calls.push(['activate', id, options.active]),
      },
      windows: {
        update: async (id, options) =>
          calls.push(['focus', id, options.focused]),
      },
    },
  })
  return { tabs, calls, click: (tab = {}) => click(tab) }
}

test('toolbar creates one archive tab and later focuses it without changing its Messenger connection', async () => {
  const f = fixture()
  await f.click({ id: 11, url: 'https://www.facebook.com/messages/t/123' })
  assert.equal(f.tabs[0].url, `${panel}?tab=11`)
  await f.click({ id: 12, url: 'https://www.facebook.com/messages/' })
  assert.deepEqual(f.calls, [
    ['create', `${panel}?tab=11`],
    ['activate', 42, true],
    ['focus', 7, true],
  ])
  assert.equal(f.tabs.length, 1)
})

test('simultaneous toolbar clicks create one tab, and closing it permits a fresh tab', async () => {
  const f = fixture()
  await Promise.all([
    f.click({ id: 11, url: 'https://www.facebook.com/' }),
    f.click(),
  ])
  assert.equal(f.tabs.length, 1)
  assert.equal(f.tabs[0].url, panel)
  f.tabs.length = 0
  await f.click()
  assert.equal(f.tabs.length, 1)
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 2)
})
