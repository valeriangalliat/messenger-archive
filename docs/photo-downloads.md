# Full-size attachments

All media requests use `dyiDownloadMediaV2` with `mediaOption: 0` (`FullSize`).
The extension rejects empty results and bytes whose SHA-256 does not match the
original attachment hash in the message metadata. File signatures determine the
saved extension when Messenger's MIME label is wrong.

When several messages share an attachment hash, the downloader tries the oldest
known message first. A `media-not-found` response moves to the next source
without repeating the same request. Other errors retain the normal retry budget
and metadata refresh. Each source keeps its own author, chat and message
identifiers.
