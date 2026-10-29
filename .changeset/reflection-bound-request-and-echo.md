---
"@connectum/reflection": minor
---

fix: a reflection request is bounded, and an error answer no longer repeats the whole requested name. The reflection services (`v1` and `v1alpha`) read at most 64 KiB per request message and end a larger one with `resource_exhausted`; before, a request was read up to the server-wide `readMaxBytes` (about 4 GiB by default) and answered with a response of twice its size, because the name was repeated in both `error_message` and `original_request`. `error_message` now repeats at most the first 128 characters of the name, with `…` after a cut name, and never splits a surrogate pair; `original_request` still carries the full request, as the protocol requires. Real names are far below both limits, so requests from grpcurl, `buf curl` and other reflection clients are unaffected. The 64 KiB limit applies instead of a smaller server-wide `readMaxBytes`.
