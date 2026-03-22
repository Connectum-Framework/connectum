---
"@connectum/events": patch
---

Fix composeMiddleware to support retry middleware

The handler branch (dispatch terminal case) was outside the try/catch
block, so handler errors did not reset the dispatch index. This caused
retry middleware to hit the "next() called multiple times" guard on
subsequent attempts instead of actually retrying.

Moved handler into try/catch and added await for proper error propagation.
