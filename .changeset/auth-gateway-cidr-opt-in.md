---
"@connectum/auth": minor
---

fix: `createGatewayAuthInterceptor` throws when `trustSource.expectedValues` contains an IPv4 CIDR block (such as `10.0.0.0/8`) unless `trustSource.allowCallerControlledCidr: true` is set. A block is matched against the value of the trust header, and a caller that reaches the service directly chooses that value, so `10.0.0.0/8` or `0.0.0.0/0` admitted anyone who sent a matching address as if the request had come through the gateway. Shared secrets are unchanged, including secrets that contain a `/` without being a well-formed block. A deployment whose trusted upstream overwrites that header on every request and that no client can reach directly sets the option; trust based on the connection's peer address belongs in the mTLS and mesh-identity trust helpers.
