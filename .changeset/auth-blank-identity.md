---
"@connectum/auth": patch
---

fix(auth): an identity whose subject holds no character once the control characters are removed is no longer accepted by any auth interceptor, and the identity headers no longer carry such a subject. Control characters here are the C0 range except tab, and DEL, which the identity headers have always removed. A subject of spaces or tabs is not affected, and `a\x01b` stays `a\x01b`.

Changed results, each as before -> now:

- `createAuthInterceptor`: a verifier that returns such a subject, before: the handler ran with that subject when `propagateHeaders` was off, and the call failed through the header writer when it was on. Now: `Unauthenticated: Authentication failed` in both cases, and the handler does not run.
- `createJwtAuthInterceptor`: a `sub` (or the claim named by `claimsMapping.subject`) of control characters only, before: accepted with `propagateHeaders` off. Now: `Unauthenticated: JWT missing subject claim`.
- `createSessionAuthInterceptor`: a `mapSession` result with such a subject, before: accepted with `propagateHeaders` off. Now: `Unauthenticated: Session mapping failed`.
- `createInternalAuthInterceptor`: a trust source (`meshIdentityTrust`, `signedTokenTrust`, `sharedSecretTrust` or a custom one) that returns such a subject, before: accepted with `propagateHeaders` off. Now: `Unauthenticated: Untrusted internal request`.
- `createGatewayAuthInterceptor`, subject: a standard `x-auth-*` subject was already refused. A subject under a custom `headerMapping` name that holds only control characters, before: accepted. Now: `Unauthenticated: Missing subject header from gateway`, as for the standard name.
- `createGatewayAuthInterceptor`, type: a type header that is empty or holds only control characters, before: the identity got an empty type. Now: the header counts as absent and `defaultType` applies, for standard and custom names.
- `parseAuthHeaders`: a subject header of control characters only, before: returned an identity with an empty subject. Now: returns `undefined`. A type header of control characters only, before: type `""`. Now: type `"unknown"`, as for an empty type header.
- `setAuthHeaders` and `propagateAuthHeaders`: a subject or type of control characters only, before: written as an empty header. Now: throws `UnsafeHeaderValueError` for `subject` or `type` (reason `empty`, as for an empty string) and sets no header.
- `sharedSecretTrust`, `meshIdentityTrust` and `signedTokenTrust`: a fixed `subject`, `type`, allowlist `principal` or issuer key (used as the subject without `claimsMapping.subject`) of control characters only, before: the factory returned a trust source. Now: it throws a `TypeError` that names the option.
- `createClientGatewayInterceptor`: a `subject` of control characters only fails when the interceptor is created, through the header writer. `createGatewayAuthInterceptor` with `propagateHeaders` and a `defaultType` of control characters only fails the same way. Both already did before this fix; the error is unchanged.

**BREAKING** only for code that relied on a subject or type made of control characters: a verifier, mapper or trust source that returned one, a trust option set to one, or a gateway that sent one. Such an identity had no usable subject and read back from the headers as no identity. Give the identity a real subject, or reject the credential in your verifier. A gateway type header of control characters only now yields `defaultType` instead of an empty type. See the migration guide `auth-identity`.
