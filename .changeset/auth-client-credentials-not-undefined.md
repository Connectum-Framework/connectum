---
"@connectum/auth": minor
---

fix(auth): `createClientBearerInterceptor` and `createClientGatewayInterceptor` no longer send the text `undefined` or `null` as a credential. A static `token` that is not a non-empty string throws a `TypeError` when the interceptor is created, and a token factory that resolves to `undefined`, `null`, an empty string or any non-string fails that call on the client with `Unauthenticated` and a message that names the interceptor, before a request is sent. Before, the server received `Authorization: Bearer undefined` or `Bearer null` and rejected it as an invalid credential, far from the missing configuration. `createClientGatewayInterceptor` throws a `TypeError` at creation for a `secret` or `subject` that is not a non-empty string (an unset environment variable), where it used to send `x-gateway-secret: undefined`.

**BREAKING** for code that passed an unset value on purpose and relied on the server rejecting the call: fix the configuration, or omit the interceptor for unauthenticated calls. See the migration guide `auth-authorization-validation`.
