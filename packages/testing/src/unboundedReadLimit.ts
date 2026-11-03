/**
 * The per-message read limit the test servers of this package run with when
 * the caller sets none: the transport's own cap, 4294967295 bytes.
 *
 * It changes nothing about how a test server behaves, because that is the
 * limit Connect applies to an unset `readMaxBytes`. It is passed explicitly
 * because `createServer()` writes a warning for a server whose limit is unset,
 * and a test server has no untrusted caller to protect from: the warning would
 * repeat for every server a suite creates, and these helpers give the user no
 * option to set a limit and silence it.
 *
 * @internal
 */
export const TRANSPORT_READ_LIMIT = 0xffff_ffff;
