/**
 * @connectum/auth/testing
 *
 * Test utilities for authentication and authorization.
 *
 * @module testing
 */

export { createMockAuthContext } from "./mock-context.ts";
export { createTestJwt, TEST_JWT_SECRET } from "./test-jwt.ts";
export {
    createTestJwtRS256,
    generateRsaTestKeypair,
    type RsaTestKeypair,
    startTestJwksServer,
    TEST_JWT_KID,
    type TestJwksServer,
} from "./test-jwt-rs256.ts";
export { withAuthContext } from "./with-context.ts";
