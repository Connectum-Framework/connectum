---
"@connectum/events": patch
---

fix: two `EventBus.stop()` calls made while `start()` is still running now share one shutdown. Both used to wait for the start and then each began its own shutdown, so the adapter was disconnected twice. The error of `publish()` during a shutdown now reads `EventBus is stopping: it accepts no new events while it drains. Wait for stop() to finish, then call start() again to publish.`; `EventBus not started. Call start() first.` is kept for a bus that was never started or has finished stopping. Code that matches the old text for the stopping case must match the new one.
