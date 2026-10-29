---
"@connectum/otel": patch
---

fix: `traced()` and `traceAll()` no longer end the span of a generator function the moment it returns. A generator function returns before any of its body has run, so its span used to have zero duration and cover nothing. The span of a sync or async generator now stays open until the generator is exhausted, throws, or is closed early (`break`, `return()`), each step of the body runs with the span as the active span (so spans it starts are its children), and a thrown error marks the span `ERROR`. The caller receives the same generator object, with its prototype and any property the function added to it: `next`, `return` and `throw` are replaced on the object itself (a frozen generator is returned as it is, and its span ends at once). A generator that is never iterated never ends its span. A thenable that is not a native `Promise` is still not awaited: its span ends when the function returns.
