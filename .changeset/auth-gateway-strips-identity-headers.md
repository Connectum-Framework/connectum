---
"@connectum/auth": patch
---

fix: `createGatewayAuthInterceptor` now deletes every standard `x-auth-*` identity header (`x-auth-subject`, `x-auth-type`, `x-auth-name`, `x-auth-roles`, `x-auth-scopes`, `x-auth-claims`, `x-auth-encoding`) after it has read its own input, on admitted requests and on `skipMethods`, as the JWT, generic and session interceptors already did. Before, with `propagateHeaders: true` a client-supplied `x-auth-roles`, `x-auth-scopes`, `x-auth-name` or `x-auth-claims` survived whenever the verified identity had no such field, and a downstream service that trusts those headers saw the forged value. A handler or `propagateHeaders` list that relied on a client-supplied standard `x-auth-*` header passing through the gateway interceptor no longer receives it; the verified identity is still written back with `propagateHeaders: true`, and a gateway that maps `x-auth-*` names in `headerMapping` still reads them.
