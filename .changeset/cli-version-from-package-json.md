---
"@connectum/cli": patch
---

Read the CLI version from `package.json` so `connectum --version` always reports the real published release. It previously printed a hand-maintained string (`0.2.0-alpha.2`) that had drifted from the actual package version.
