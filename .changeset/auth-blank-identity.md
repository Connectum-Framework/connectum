---
"@connectum/auth": patch
---

fix: a `subject` or `type` that is empty only after the control characters are removed (for example a single U+0001) is now treated as empty: `setAuthHeaders` throws the same `UnsafeHeaderValueError` as for an empty value and sets no header, and `parseAuthHeaders` reports no identity for such a subject instead of one with `subject: ""`. Such a value used to be written as an empty header and read back as an identity without a subject, which no caller could authenticate; an identity with an empty subject was never valid. An issuer whose verifier can return a subject of control characters, or any caller that treated a context with `subject: ""` as authenticated, must change.
