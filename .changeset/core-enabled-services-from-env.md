---
"@connectum/core": minor
---

feat: `enabledServicesFromEnv(value)` configures `enabledServices` from an environment variable in one line: `createServer({ services, enabledServices: enabledServicesFromEnv(process.env.CONNECTUM_SERVICES) })`. A variable that is unset, empty, whitespace or only commas gives `undefined`, so the server mounts every supplied service as it does when the option is omitted; a comma-separated value gives the named `typeName`s, trimmed. To mount none of the supplied services, pass `enabledServices: []` directly.

Why: `parseServicesEnv(undefined)` returns `[]`, and `[]` mounts none of the supplied services, so `enabledServices: parseServicesEnv(process.env.CONNECTUM_SERVICES)` started a process with no business services whenever the variable was unset, and every caller had to add a ternary around it. `parseServicesEnv` is unchanged (it is released API, and `[]` there is what its consumers read), and its documentation now says so. `CreateServerOptions.enabledServices` also accepts an explicit `undefined`, which a project with `exactOptionalPropertyTypes` needs to pass the helper's result as it is; passing a list or omitting the option behaves as before.
