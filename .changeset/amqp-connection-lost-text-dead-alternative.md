---
"@connectum/events-amqp": patch
---

fix: `isConnectionLostError` no longer matches the text `closed unexpectedly`, which amqplib 2.2.0 never raises. A confirm failure is still classified as `AmqpConnectionError` by the structural signals (publish closing, confirm channel closed, channel swapped) and by the texts amqplib does raise (`channel closed`, `Connection closed: ...`, `Connection closed (...)`); an error that only says `closed unexpectedly` and carries no structural signal is now a nack.
