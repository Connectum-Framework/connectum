/**
 * Test JWT utilities
 *
 * Provides deterministic JWT creation for testing.
 * NOT for production use.
 *
 * @module testing/test-jwt
 */

import * as jose from "jose";

/**
 * Deterministic test secret for HS256 JWTs.
 *
 * WARNING: This is a well-known secret for testing only.
 * NEVER use in production.
 */
export const TEST_JWT_SECRET = "connectum-test-secret-do-not-use-in-production";

/**
 * Encoded test secret for jose.
 */
const encodedSecret = new TextEncoder().encode(TEST_JWT_SECRET);

/**
 * Create a signed test JWT for integration testing.
 *
 * Uses HS256 algorithm with a deterministic test key.
 * NOT for production use.
 *
 * @param payload - JWT claims
 * @param options - Signing options
 * @returns Signed JWT string
 *
 * @example Create a test token
 * ```typescript
 * import { createTestJwt, TEST_JWT_SECRET } from '@connectum/auth/testing';
 *
 * const token = await createTestJwt({
 *   sub: 'user-123',
 *   roles: ['admin'],
 *   scope: 'read write',
 * });
 *
 * // Use with createJwtAuthInterceptor in tests
 * const auth = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
 * ```
 */
export async function createTestJwt(
    payload: Record<string, unknown>,
    options?: {
        expiresIn?: string;
        issuer?: string;
        audience?: string;
    },
): Promise<string> {
    let builder = new jose.SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt();

    if (options?.expiresIn) {
        builder = builder.setExpirationTime(options.expiresIn);
    } else {
        // Default: 1 hour expiry
        builder = builder.setExpirationTime("1h");
    }

    if (options?.issuer) {
        builder = builder.setIssuer(options.issuer);
    }

    if (options?.audience) {
        builder = builder.setAudience(options.audience);
    }

    return await builder.sign(encodedSecret);
}
