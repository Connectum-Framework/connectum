---
"@connectum/cli": minor
---

feat: `connectum generate service` checks the project before it writes anything. A directory without a `package.json` is refused (`Error: connectum generate service: no package.json in "...". Run the command in the root of a Connectum project`), and so is `--with-events` in a project whose `package.json` lists `@connectum/events` in none of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. Before, the files were written into any directory, and the event handler of a project without the events module failed `tsc` with `TS2307` and `TS7006`. Both refusals are one line, exit code 1, and leave the directory untouched. Run the command from the project root; to use `--with-events`, add `@connectum/events` and an adapter first, or scaffold the project with `connectum init --events <adapter>`.
