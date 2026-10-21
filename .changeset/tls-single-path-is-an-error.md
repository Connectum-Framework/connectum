---
"@connectum/core": patch
---

fix: `tls` with only one of `keyPath` and `certPath` is now a configuration error. Previously `readTLSCertificates` silently ignored the single path and read both `server.key` and `server.crt` from the directory (`dirPath`, `TLS_DIR_PATH` or the default directory), so the server started with a different certificate than the one the operator named. It now throws an `Error` naming the parameter that is set and the one that is missing, before any file is read, and `server.start()` rejects with it. Behaviour correction for that configuration only: set both paths, or neither to read the directory. The precedence of the other sources (both explicit paths, then `dirPath`, then `TLS_DIR_PATH`, then the default directory) and the treatment of an empty string as "not set" are unchanged.
