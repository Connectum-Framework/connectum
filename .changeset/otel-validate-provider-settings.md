---
"@connectum/otel": minor
---

fix: `initProvider({ settings })` rejects a signal or an exporter it does not know. `settings: { traces: "bogus" }` used to fall into the console branch without a message, so spans went to standard output while the intended exporter never ran. It now throws `TypeError` naming the key, the value and the accepted values (`console`, `otlp/http`, `otlp/http-protobuf`, `otlp/grpc`, `none`) before anything is created; the same for a misspelled key such as `trace`. The bare `otlp` that the environment variables accept is not a `settings` value: use `otlp/http-protobuf`. Fix the value in your code.
