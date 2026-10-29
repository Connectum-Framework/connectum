---
"@connectum/core": patch
---

fix: a TLS key or certificate that cannot be read, or that the server refuses, now fails with an error that names the file and where its path came from (`tls.keyPath`, `tls.certPath`, `tls.dirPath`, `TLS_DIR_PATH` or the default directory), instead of OpenSSL's bare text. A key that does not match the certificate names both files. The files are handed to the server as before, so every configuration it accepted still starts; the key and certificate are parsed on their own only after the server has refused them. The error the server threw is kept as `cause` (for a read failure, the file system error, with its `code` and `path` kept on the new error).
