---
"@connectum/core": patch
---

fix: `ConnectumEnvSchema`, `parseEnvConfig()` and `safeParseEnvConfig()` reject a fractional `PORT` (for example `80.5`) with an issue on `PORT` that states an integer is expected; before, such a value passed validation. The range is unchanged: `1` and `65535` are accepted, `0` and `65536` are rejected. Starting a server on a fractional port was already refused (`ERR_SOCKET_BAD_PORT` for the `port` option, an error naming `PORT` for the variable); tests now pin that.
