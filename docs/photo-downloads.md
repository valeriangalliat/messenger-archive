# Photo downloads

With **Download full photos** unchecked, photos first request
`dyiDownloadMediaV2` with `mediaOption: 1` (`PreviewsOnly`). Checking the option
requests `0` (`FullSize`) directly. Videos and other files also use full size.

In the inspected Messenger implementation, `EncryptedBackupsDYIMediaDownload.downloadDYIMedia`
decodes the media entry and calls `WAIsPreviewSupported.checkPreviewSupport`.
It checks both `PjpegPreviewSupport` and `DownloadablePreviewSupport`. If both
are `NO`, it calls `enqueueDownloadFullSize`; otherwise, it calls
`enqueueDownloadPreview`.

These are two different forms of preview:

- A progressive JPEG preview contains part of the original JPEG data.
- A downloadable thumbnail is a separate attachment described by the media entry.

Messenger makes this choice inside its native downloader. The extension records
`requestedRepresentation: "preview"` and hashes the returned bytes. If
they match the original photo's hash, it records `representation: "full"`;
otherwise, it records `representation: "preview"`.
The representation identifies the saved bytes; it does not prove that a separate thumbnail
was absent from every Messenger storage location.

A `media-not-found` result ends the current source and representation immediately.
There are no backoff sleeps and no three identical requests for that result.
The archive tries other known preview sources before requesting a full photo.
If every advertised preview source returns this result, it automatically tries
full size, starting with attempt 1 and no delay. A missing full photo is not
repeated either. A later manual resume or update can try missing files again.

The adapter reports whether the media entry advertises a thumbnail or progressive
preview. If neither is advertised, the native preview policy has already selected
full size; another explicit full-size request would be redundant. Malformed or
unknown metadata cannot authorize full-photo fallback.

Timeouts, expired URLs, runtime errors, integrity failures, and unknown errors
retain their existing retry and metadata-refresh behavior. If any preview source
ends with one of these errors, automatic full-photo escalation is withheld.
Exhausting retries alone is not evidence that a preview is missing.

The metadata describes preview capability, not current server availability.
`media-not-found` reports the fetch result; it does not promise permanent absence
from every Messenger storage location. This policy uses explicit not-found results
for known preview sources to recover a full photo without requiring a setting
change. It does not reinterpret arbitrary download failures as missing previews.

The archive records native error codes and requested representations for each
attempt. A successful explicit fallback has `representation: "full"`,
`requestedRepresentation: "preview"`, and
`fallbackReason: "preview-media-not-found"`; its bytes must match the original
photo's SHA-256. The fallback reason also travels in portable checkpoints.

Exports normalize the older `native-preview` and `full-fallback` labels to
`preview` and `full`, including attempt history and earlier checkpoint references.
This does not rewrite browser storage, change file bytes, or restart an active run.

Existing saved attachments retain their bytes. Updating the policy does not
redownload them or require deleting the archive.
