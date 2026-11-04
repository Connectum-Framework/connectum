---
"@connectum/healthcheck": minor
---

fix: `HealthcheckManager.update()`, `register()` and `set()` refuse a status that is not one of the four `ServingStatus` values (0 to 3), and a component or service name that is not a string. A wrong type throws `TypeError`, a number outside the enum (a fraction, `NaN`, `99`) throws `RangeError`, and the registry is left as it was. Before, such a value was stored: `set("db", "SERVING")` made every later `Health.List` and the `Health.Check` of that component fail with an internal serialization error that leaked the serializer text, and `99` went onto the wire as an unknown status. Valid calls behave as before.
