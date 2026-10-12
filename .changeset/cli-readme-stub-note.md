---
"@connectum/cli": patch
---

fix: the README that `connectum init` writes now says that a service added with `connectum generate service <name>` is a stub whose handler throws `Unimplemented` until it is replaced with real logic; before, a first call to the generated service failed with no hint in the project.
