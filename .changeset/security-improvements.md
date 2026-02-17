---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/interceptors": patch
---

Security improvements and review fixes.

**core:**
- Add `SanitizableError` base class for safe error messages in responses
- Input validation improvements (code validation, spread pattern)

**auth:**
- Header value length limits (256 chars for subject/name/type)
- Claims JSON size limit in header propagation

**interceptors:**
- Error handler respects `SanitizableError` for safe client-facing messages
