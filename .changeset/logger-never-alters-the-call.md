---
"@connectum/interceptors": patch
---

fix: the logger interceptor can no longer change the outcome of a call, and it now logs failures and stream ends correctly

- A log sink that throws no longer turns a successful response into `Internal` or replaces the real error of a failed call. The first sink failure is reported once on the console; later ones are dropped.
- A failed call is logged as `RPC <path> failed with <Code>` (the Connect code name, `Unknown` for a plain error); the original error reaches the caller unchanged.
- For a streamed response the `completed in N ms` line is written when the stream ends (fully read, failed midway, or abandoned by the reader), so the duration covers the stream. Before, it was written when the stream was created, ahead of the first message.
- A streamed message that cannot be converted to JSON is logged as a marker instead of ending the stream with an error.

What is printed for a call by default is unchanged apart from the new failure line and the position of the completion line of streams.
