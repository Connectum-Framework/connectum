---
"@connectum/events-kafka": patch
---

fix: `consumerOptions.allowAutoTopicCreation: true` now works for `subscribe()`. The broker answers the first request for a missing topic with an error and creates the topic a moment later; the client library treated that answer as final, so the subscription (and `bus.start()` of a consumer that starts before the first publisher) failed although the topic existed a second later. With the option on, `subscribe()` asks again for up to ten seconds. Without the option, or when the topic does not appear, the error now names the topic and the option instead of `This server does not host this topic-partition`.
