# Messenger Archive

> Firefox and Chrome extension to back up end-to-end encrypted
> Messenger chats and attachments to ZIP files.

I made this because Messenger's own encrypted export left out chats and
attachments without saying what failed. This extension resumes interrupted
backups, retries failed downloads, and verifies full-size attachments.

## Installation

Download or clone this repo. There's no build step.

### Firefox

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on**, and select `manifest.json`. Repeat after restarting Firefox.

### Chrome

Open `chrome://extensions`, enable **Developer mode**, and select this
repo's directory with **Load unpacked**.

## Usage

1. Sign in to [Facebook Messages] and enter your history PIN if asked.
2. Click the extension icon, choose **Start archive**, and keep both tabs open.
3. Check **Issues** for anything that failed, then click **Download ZIP**.

[Facebook Messages]: https://www.facebook.com/messages/

The ZIP contains readable copies of your encrypted chats and attachments.

Use **Update archive** to back up changes. **Keep the first ZIP and
every update.** To resume in another browser, sign in to the same
Messenger account and import the latest ZIP under **Backup and browser
storage**.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Run the Chrome smoke test with simulated Messenger data.

```sh
pnpm exec puppeteer browsers install chrome
pnpm test:browser
```
