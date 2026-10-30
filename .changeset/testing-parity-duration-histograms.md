---
"@connectum/testing": patch
---

fix: `defaultCompare` of `transportParityTest` no longer fails on the call-duration histograms (`rpc.server.call.duration`, `rpc.client.call.duration`) that a scenario reports as `metrics: await ctx.metrics.flush()`. The recorded time differs between the HTTP/2 and the in-process leg for identical behaviour, so a histogram measured in a unit of time is now compared by its observation count and attributes instead of its sum, minimum, maximum and buckets. Name, description, unit, type and attributes, and the values of every other metric (request and response sizes, counters, gauges), are still compared literally.
