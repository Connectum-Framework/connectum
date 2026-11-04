---
"@connectum/events-nats": patch
---

fix: a subscription whose request for messages reaches a server that no longer has the consumer resumes at once. When the handler of a message was still running while the JetStream stream was deleted and created again, the client's next request for messages got "no responders" instead of "consumer deleted"; the adapter ignored that answer and the subscription stayed silent until the client noticed missed heartbeats, 30 to 45 seconds later. The adapter now asks the server whether the consumer exists and, when the consumer or its stream is gone, recovers exactly as for "consumer deleted". An answer that only reflects a server that is busy or restarting leaves the subscription alone.
