---
"@connectum/healthcheck": patch
---

fix: the `NOT_FOUND` message of `Health.Check` repeats at most the first 128 characters of the requested service name (cut with an ellipsis; shorter names are echoed unchanged). The whole name used to be embedded, so a name of about 70,000 characters made the response larger than an HTTP/2 frame: the stream failed with a frame-size error and the next call on the same connection could be refused. Such a request now gets an ordinary `NOT_FOUND` and the connection stays usable.
