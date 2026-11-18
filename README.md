# Messenger Archive

A Firefox and Chrome extension for incremental ZIP backups of encrypted Messenger conversations and attachments. It runs directly from this directory without a build step or dependency install.

## Install

- **Firefox 142+:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`.
- **Chrome 121+:** open `chrome://extensions`, enable **Developer mode**, and choose this directory with **Load unpacked**.

Reload the extension after changing its files.

## Use

1. Sign in to Messenger and enter your history PIN if asked.
2. Open the extension. The toolbar opens or focuses the archive tab. To continue an existing backup, import its ZIP or `checkpoint.json` under **Backup and browser storage**. Only the current backup format is supported.
3. Click **Start archive** or **Update archive**, then **Download ZIP** when ready.

Keep Messenger and the archive tab open while collecting data. You can pause and resume; updates find new conversations and messages and retry failures. Interrupted history scans finish before a fresh scan starts for that chat. Check **Issues** for anything unresolved. Unencrypted history is skipped.

The extension downloads full-size attachments and checks each file's SHA-256 against its message metadata. When several messages share an attachment, it starts with the oldest source. If that source reports the file missing, the extension tries the next one. It retries temporary failures and refreshes download metadata.

The extension looks up missing contact names for encrypted direct chats. Names are saved in `contacts.json` and the portable checkpoint. Failed lookups appear under **Issues** and are retried on the next run.

## Keep your backups

Each regular ZIP contains new or changed messages and attachment bytes, plus a portable checkpoint. **Keep the baseline and every delta ZIP.** Import the latest ZIP or its checkpoint with the same Messenger account to resume on another laptop or after losing browser storage.

Use **Download standalone ZIP** under **Backup and browser storage** to create a new baseline from the browser's saved data. It requires the browser to still have every previously exported message and attachment.

Storage controls show usage and let you remove confirmed exported data while keeping unfinished work and the checkpoint. Automatic attachment cleanup is optional and runs only after a successful download. **Delete all local data** also removes unfinished work and the local checkpoint; downloaded ZIPs stay on disk.

## Develop

Use Node 22.12+ and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`pnpm format` applies formatting. To run the optional Chrome smoke test with fake Messenger responses, first install the test browser:

```sh
pnpm exec puppeteer browsers install chrome
pnpm test:browser
```
