---
"@connectum/auth": patch
---

fix: the gateway trust header is matched against CIDR blocks with a strict IPv4 parser. Before, `Number()` and `parseInt()` read an empty octet as `0`, accepted hexadecimal and exponent forms, and ignored trailing text in the prefix, so a header value such as `10.0..1` or `0x0a.0.0.1`, or a block such as `10.0.0.0/8abc`, was treated as a well-formed address or block. Now an address is exactly four decimal octets of 0-255 without leading zeros, and a block is such an address plus `/` and a 1-2 digit prefix of 0-32. Anything else matches only its exact text, so a malformed block can never widen trust (a shared secret in `expectedValues` may itself contain `/`). A deployment that relied on one of the lenient forms must send the canonical dotted-decimal address.
