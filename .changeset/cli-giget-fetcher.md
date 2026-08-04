---
"@connectum/cli": patch
---

Fetch the `init` base project with `giget` instead of `tiged`.

`tiged` depends on `tar`, and the releases it pins (`^6.1.11`) carry a critical
decompression denial-of-service advisory and a high-severity arbitrary
file-overwrite advisory. `tiged@2.12.8` is its latest release, so upgrading does not
reach a fixed `tar` — the constraint is in `tiged` itself. That matters more here
than it would elsewhere: a scaffolder exists to download and unpack a remote
archive, so the extraction path is exactly the exposed one.

`giget` is the maintained degit-style downloader from the same project family as
`citty`, which this CLI already uses, and it has **no dependencies at all**. The
change removes the critical and both high advisories from the CLI's production
dependency closure and drops nine transitive packages.

The fetcher was already injectable behind `CloneFn`, so the change is confined to
the default implementation. The only externally visible difference is the spec
format: giget needs its `gh:` provider prefix, so the base is now requested as
`gh:Connectum-Framework/examples/getting-started#<ref>`. `connectum init` was run
end to end against the real repository to confirm it.
