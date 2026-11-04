---
"@connectum/healthcheck": minor
---

fix: `Healthcheck()` validates `watchInterval` when it is called. The option must be an integer from 1 to 2147483647 (milliseconds); a number outside that set (`0`, a fraction, `NaN`, a negative number, `Infinity`, a larger value) throws `RangeError`, and a value that is not a number (a string, `null`) throws `TypeError`, both naming `watchInterval`. Before, `0`, `NaN`, negative and oversized values made every `Health.Watch` call poll about once per millisecond (roughly 900 reads a second per watcher, plus a Node timer warning), and a string or `null` made every `Watch` end with an internal error while `Check` and `Healthcheck()` still worked. Omitting the option still means 500.
