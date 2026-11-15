# Messenger Archive

A Firefox and Chrome extension for incremental ZIP backups of encrypted Messenger conversations and attachments. Plain JavaScript; no build step.

## Install

- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`.
- **Chrome 121+:** open `chrome://extensions`, enable **Developer mode**, and choose this directory with **Load unpacked**.

Reload the extension after changing its files.

## Use

1. Sign in to Messenger and enter your history PIN if asked.
2. Open the extension. The toolbar opens or focuses the archive tab. To continue an existing backup, import its ZIP or `checkpoint.json` under **Backup and browser storage**. Only the current backup format is supported.
3. Click **Start archive** or **Update archive**, then **Download ZIP** when ready.

Keep Messenger and the archive tab open while collecting data. You can pause and resume; updates find new conversations and messages and retry failures. Interrupted history scans finish before a fresh scan starts for that chat. Check **Issues** for anything unresolved. Unencrypted history is skipped.

Photos use native previews by default, with full photos available in settings. Videos remain full playable files.

## Keep your backups

Each ZIP contains new or changed messages and attachment bytes, plus a portable checkpoint. **Keep the baseline and every delta ZIP.** Import the latest ZIP or its checkpoint with the same Messenger account to resume on another laptop or after losing browser storage. The full archive still requires the earlier ZIPs; browsing and merging tools are not included.

Storage controls show usage and let you remove confirmed exported data while keeping unfinished work and the checkpoint. Automatic attachment cleanup is optional and runs only after a successful download. **Delete all local data** also removes unfinished work and the local checkpoint; downloaded ZIPs stay on disk.

## Develop

Use Node 22.12+ and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`pnpm format` applies formatting. `pnpm test:browser` runs the extension with fake Messenger responses in an isolated browser profile.
