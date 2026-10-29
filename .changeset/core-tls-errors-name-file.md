---
"@connectum/core": patch
---

fix: a TLS key or certificate that cannot be read or parsed now fails with an error that names the file and where its path came from (`tls.keyPath`, `tls.certPath`, `tls.dirPath`, `TLS_DIR_PATH` or the default directory), instead of OpenSSL's bare text. A key that does not match the certificate names both files. The original error is kept as `cause`, and `code` and `path` of a read failure are kept on the new error.
