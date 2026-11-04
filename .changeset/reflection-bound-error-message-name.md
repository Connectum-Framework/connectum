---
"@connectum/reflection": patch
---

fix: an error answer no longer repeats the whole requested name. For an unknown file, symbol or type, `error_message` repeated the name from the request, and the response carried the request once more in `original_request`: about 16 MiB of response for an 8 MiB request. `error_message` now repeats at most the first 128 characters of the name, with `…` after a cut name, and never splits a surrogate pair; a name of 128 characters or fewer is repeated unchanged. `original_request` still carries the full request.
