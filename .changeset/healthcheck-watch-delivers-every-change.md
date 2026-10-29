---
"@connectum/healthcheck": minor
---

fix: `Health.Watch` delivers every change of the watched status, in order, as soon as it happens. It used to compare the status once per `watchInterval`, so a service set to `NOT_SERVING` and back to `SERVING` inside one interval never showed the outage to a watcher, against "send a new message whenever the service's serving status changes". `HealthcheckManager` gains `subscribe(listener)`, which `Watch` uses; it returns a function that removes the listener. A listener must not change the registry: `update`, `register`, `set`, `unregister`, `initialize` and `clear` called from inside a listener throw, so every listener sees the state of the change that notified it. `watchInterval` stays as the period of a re-check. Watchers now also see short intermediate states, for example `UNKNOWN` between a service being registered and its first `update`. `Healthcheck()` requires a `manager` that has `subscribe`, which every `HealthcheckManager` does.
