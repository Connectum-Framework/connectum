---
"@connectum/core": patch
---

fix: re-export `EffectiveTransport` and `TransportValidationMode` as values from the package root

These are ADR-001 const-object enums — they carry both a runtime value and a type. They were re-exported from the barrel with `export type { … }`, which erased the runtime const: consumers got `undefined` (e.g. `TransportValidationMode.ERROR`, `EffectiveTransport.TLS_H2_ONLY`) while the generated `.d.ts` still advertised them as usable values, so calls type-checked and then crashed (or compared always-false against `resolveEffectiveTransport()`). They are now re-exported as values, carrying both the const and the type.
