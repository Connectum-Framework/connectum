---
"@connectum/events": patch
---

fix: `EventBus.start()` now rejects with the error that made it fail even when the rollback's `adapter.disconnect()` also throws. The rollback error used to replace the original, so a refused connection was reported as the secondary disconnect failure. The rollback failure itself is dropped, as a failed unsubscribe during the same rollback already was.
