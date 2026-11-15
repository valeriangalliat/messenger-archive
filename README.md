# Messenger Archive

A Firefox and Chrome extension that saves encrypted Messenger conversations and attachments as a ZIP.

## Install

Load the extension directly from this project directory. No build or dependency install is needed to use it.

- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select the root `manifest.json`.
- **Chrome:** open `chrome://extensions`, enable **Developer mode**, and select this project's root directory with **Load unpacked**. Requires Chrome 121 or newer.

If Firefox already loads the project root, keep that location and click **Reload**. If you loaded a previous `dist/` build, download a ZIP of any saved archive before switching back to the root.

## Use

1. Sign in to Messenger. Enter your history PIN there if asked.
2. Click the extension from any tab. It connects to Messenger automatically.
3. Click **Start archive**, then **Download ZIP** when ready.

Keep Messenger and the archive tab open while archiving. The archive button becomes **Pause** while it runs and **Resume archive** after an interruption. Resuming continues from your saved progress and retries issues automatically. Once the run finishes, **Update archive** finds new chats, checks for new messages, and retries any remaining issues. Saved data stays in the browser between runs. Download a ZIP before removing the extension or clearing its storage.

**Download ZIP** saves everything collected so far, even if you paused or some items failed. Chats without encryption are listed but not downloaded. Message and attachment problems appear under **Issues**, with a total and pages of 50 entries. Every issue is accessible; a chat entry can summarize several message errors. The ZIP also includes issue details.

The ZIP contains one folder per chat with JSON messages, a shared `media/` folder, and JSON indexes. Messages include their original payloads. This extension uses Messenger's internal APIs, which Meta can change.

## Develop

Plain JavaScript, no runtime dependencies or build step. For development checks, use Node 22.12+ and the pnpm version in `package.json`.

Files are organized as follows:

- `manifest.json`: shared Firefox and Chrome manifest, with paths relative to the project root.
- `src/`: JavaScript.
- `assets/`: static panel HTML and CSS, plus any future images or icons.
- `tests/`: unit tests and the browser smoke test.

The manifest declares both Firefox's background script and Chrome's service worker. Each browser uses its supported entry. See [Mozilla's cross-browser manifest documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background#cross-browser_manifest_v3_background_scripts).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

After changing source files, click **Reload** on the extension in Firefox's `about:debugging` page or Chrome's `chrome://extensions` page.

Run `pnpm lint` to lint the code and `pnpm format` to apply formatting. `pnpm check` checks lint, formatting, and imports with Biome.

Optional: `pnpm test:browser` checks the extension with fake Messenger responses. Puppeteer uses a separate test browser and temporary profile. If the browser download was skipped during install, run `pnpm exec puppeteer browsers install chrome` first.
