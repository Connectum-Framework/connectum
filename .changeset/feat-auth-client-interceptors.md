---
"@connectum/auth": minor
---

feat(auth): add client-side auth interceptors (bearer, gateway)

Added two client interceptor factories:
- `createClientBearerInterceptor()` — sets Authorization header with static or async token
- `createClientGatewayInterceptor()` — sets gateway secret and auth context headers for service-to-service communication
