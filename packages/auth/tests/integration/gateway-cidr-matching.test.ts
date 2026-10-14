/**
 * Gateway trust header: CIDR matching against the CIDR definition (RFC 4632)
 * and dotted-decimal IPv4 notation (RFC 791).
 *
 * Every row states what a correct matcher answers for that address and block;
 * none of it is derived from the implementation. The block is given as an
 * `expectedValues` entry and the address as the trust-header value, and the
 * observable result is whether the request is admitted.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.v1.TestService", method: "TestMethod" } as const;

/** Whether a request carrying `headerValue` passes a gateway that trusts `expectedValues`. */
async function admits(expectedValues: string[], headerValue: string): Promise<boolean> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: { subject: "x-user-id" },
        trustSource: { header: "x-forwarded-for", expectedValues },
    });
    const headers = new Headers();
    headers.set("x-forwarded-for", headerValue);
    headers.set("x-user-id", "user");
    const next = mock.fn(async () => ({ message: {} }));
    try {
        await interceptor(next as never)(createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers }));
    } catch {
        return false;
    }
    return next.mock.calls.length === 1;
}

describe("gateway trust: CIDR membership (RFC 4632)", () => {
    const inside: Array<[block: string, address: string]> = [
        ["10.0.0.0/8", "10.0.0.0"],
        ["10.0.0.0/8", "10.255.255.255"],
        ["192.168.1.0/24", "192.168.1.255"],
        ["172.16.0.0/12", "172.31.255.255"],
        ["1.2.3.4/32", "1.2.3.4"],
        ["1.2.3.4/31", "1.2.3.5"],
        ["0.0.0.0/0", "203.0.113.9"],
        ["128.0.0.0/1", "255.255.255.255"],
    ];
    for (const [block, address] of inside) {
        it(`${address} is inside ${block}`, async () => {
            assert.strictEqual(await admits([block], address), true);
        });
    }

    const outside: Array<[block: string, address: string]> = [
        ["10.0.0.0/8", "11.0.0.0"],
        ["192.168.1.0/24", "192.168.2.1"],
        ["172.16.0.0/12", "172.32.0.0"],
        ["1.2.3.4/32", "1.2.3.5"],
        ["1.2.3.4/31", "1.2.3.6"],
        ["128.0.0.0/1", "127.255.255.255"],
    ];
    for (const [block, address] of outside) {
        it(`${address} is outside ${block}`, async () => {
            assert.strictEqual(await admits([block], address), false);
        });
    }
});

describe("gateway trust: a header value that is not a dotted-decimal IPv4 address is never inside a block", () => {
    const malformed: Array<[label: string, address: string]> = [
        ["an empty octet", "10.0..1"],
        ["a hexadecimal octet", "0x0a.0.0.1"],
        ["an exponent octet", "10.0.0.1e0"],
        ["a signed octet", "+10.0.0.1"],
        ["an octet above 255", "10.0.0.256"],
        ["a leading-zero octet", "010.0.0.1"],
        ["three octets", "10.0.1"],
        ["five octets", "10.0.0.0.1"],
        ["trailing junk after the last octet", "10.0.0.1abc"],
        ["an embedded prefix", "10.0.0.1/8"],
    ];
    for (const [label, address] of malformed) {
        it(`rejects ${label} (${address}) for 10.0.0.0/8`, async () => {
            assert.strictEqual(await admits(["10.0.0.0/8"], address), false);
        });
    }
});

describe("gateway trust: a malformed block widens nothing", () => {
    const malformed: Array<[label: string, block: string]> = [
        ["a prefix with trailing junk", "10.0.0.0/8abc"],
        ["a prefix above 32", "10.0.0.0/33"],
        ["a non-numeric prefix", "10.0.0.0/abc"],
        ["a negative prefix", "10.0.0.0/-1"],
        ["an empty prefix", "10.0.0.0/"],
        ["a prefix with a space", "10.0.0.0/ 8"],
        ["a second slash", "10.0.0.0/8/8"],
        ["a missing network", "/8"],
        ["an empty network octet", "10..0.0/8"],
        ["three network octets", "10.0.0/8"],
    ];
    // Two probes per block. 10.0.0.1 sits inside the block a lenient parser would read out of
    // the text (/8abc as /8, /-1 as everything); 10.0.0.0 is the network address itself, the one
    // input that would still match when an out-of-range prefix such as /33 is not rejected.
    for (const [label, block] of malformed) {
        for (const address of ["10.0.0.1", "10.0.0.0"]) {
            it(`${block} (${label}) admits ${address}`, async () => {
                assert.strictEqual(await admits([block], address), false);
            });
        }
    }

    it("still admits the exact text of a shared secret that contains a slash", async () => {
        assert.strictEqual(await admits(["abc/def=="], "abc/def=="), true);
        assert.strictEqual(await admits(["abc/def=="], "abc/def=x"), false);
    });
});
