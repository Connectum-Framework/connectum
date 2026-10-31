/**
 * The creation-time check of an option and the request path give the same verdict.
 *
 * Each option below is checked when the interceptor is created, and the same value is used later by
 * the code that writes it. If the two disagree, a configuration is accepted that then fails every
 * request (or is refused although it would work). The oracle for an identity text or the roles is
 * the header writer itself (`setAuthHeaders`), for a header name and for the client secret it is the
 * platform operation the request path performs (`Headers`), compared at the boundary of every limit:
 * exactly at it and one over, with characters that the writer expands (non-Latin text in the roles
 * JSON becomes six characters per character, an astral character twelve) or encodes.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { setAuthHeaders } from "../../src/headers.ts";
import { sharedSecretTrust } from "../../src/internal-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";

const base: AuthContext = { subject: "s", type: "t", roles: [], scopes: [], claims: {} };

/** Whether the header writer accepts the identity. */
function writerAccepts(patch: Partial<AuthContext>): boolean {
    try {
        setAuthHeaders(new Headers(), { ...base, ...patch });
        return true;
    } catch {
        return false;
    }
}

/** Whether creating an interceptor with the option succeeds. */
function creationAccepts(create: () => unknown): boolean {
    try {
        create();
        return true;
    } catch {
        return false;
    }
}

const gatewayWithType = (defaultType: string) => () =>
    createGatewayAuthInterceptor({ headerMapping: { subject: "x-user-id" }, trustSource: { header: "x-gw", expectedValues: ["s"] }, defaultType, propagateHeaders: true });
const clientWith = (options: { subject?: string; roles?: string[]; secret?: string }) => () => createClientGatewayInterceptor({ secret: "s", subject: "svc", ...options });

const TEXTS: Array<[string, string]> = [
    ["empty", ""],
    ["one character", "a"],
    ["128 Latin characters", "a".repeat(128)],
    ["129 Latin characters", "a".repeat(129)],
    ["128 Cyrillic characters", "Я".repeat(128)],
    ["129 Cyrillic characters", "Я".repeat(129)],
    ["64 astral characters (128 units)", "\u{1F600}".repeat(64)],
    ["65 astral characters (130 units)", "\u{1F600}".repeat(65)],
    ["512 Latin characters", "a".repeat(512)],
    ["513 Latin characters", "a".repeat(513)],
    ["a lone high surrogate", "a\uD800"],
    ["a lone low surrogate", "\uDC00"],
    ["a line break", "a\nb"],
    ["NUL", "a\0b"],
    ["a leading space", " a"],
    ["a trailing tab", "a\t"],
    ["only a space", " "],
    ["a Latin-1 text", "café"],
];

describe("identity texts: creation and writer agree", () => {
    for (const [label, text] of TEXTS) {
        it(`defaultType ${label}`, () => {
            assert.strictEqual(creationAccepts(gatewayWithType(text)), writerAccepts({ type: text }));
        });
        it(`client subject ${label}`, () => {
            assert.strictEqual(creationAccepts(clientWith({ subject: text })), writerAccepts({ subject: text }));
        });
    }
});

describe("roles: creation and writer agree at the escaped limit", () => {
    // The roles JSON is ["<text>"], 4 characters around the text; the writer expands every character
    // above U+00FF to six, so the limit of 8192 falls at 1364 Cyrillic characters, 682 astral ones
    // (twelve each) and 8188 Latin ones.
    const LISTS: Array<[string, string[]]> = [
        ["1364 Cyrillic characters", ["Я".repeat(1364)]],
        ["1365 Cyrillic characters", ["Я".repeat(1365)]],
        ["682 astral characters", ["\u{1F600}".repeat(682)]],
        ["683 astral characters", ["\u{1F600}".repeat(683)]],
        ["8188 Latin characters", ["a".repeat(8188)]],
        ["8189 Latin characters", ["a".repeat(8189)]],
        ["8188 Latin-1 characters", ["é".repeat(8188)]],
        ["8189 Latin-1 characters", ["é".repeat(8189)]],
        ["a lone surrogate", ["a\uD800"]],
        ["an empty list", []],
        ["many short roles", Array.from({ length: 2000 }, () => "r")],
        ["too many short roles", Array.from({ length: 2731 }, () => "r")],
        ["a sparse list", [, "a"] as unknown as string[]], // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
        ["a list with a number", ["a", 1] as unknown as string[]],
    ];
    for (const [label, roles] of LISTS) {
        it(label, () => {
            assert.strictEqual(creationAccepts(clientWith({ roles })), writerAccepts({ roles }));
        });
    }

    it("roles changed after creation are still checked on each call", async () => {
        const roles = ["a"];
        const interceptor = createClientGatewayInterceptor({ secret: "s", subject: "svc", roles });
        roles.push("Я".repeat(1365));
        await assert.rejects(() => interceptor((async () => ({ message: {} })) as never)(createMockRequest({ service: "t.v1.S", method: "M" })));
    });
});

describe("client secret: creation and the request path agree", () => {
    const SECRETS = ["s", "a b", "s ", " s", "s\t", "\ts", "Ж", "é", "a\nb", "a\rb", "a\0b", "", "a".repeat(10_000)];
    for (const secret of SECRETS) {
        it(`secret ${JSON.stringify(secret).slice(0, 30)}`, async () => {
            const accepted = creationAccepts(clientWith({ secret }));
            // What the request path does with it: set it on the request and read it back as the server will.
            const headers = new Headers();
            let delivered = false;
            try {
                headers.set("x-gateway-secret", secret);
                delivered = secret !== "" && headers.get("x-gateway-secret") === secret;
            } catch {
                delivered = false;
            }
            assert.strictEqual(accepted, delivered);
            if (accepted) {
                const req = createMockRequest({ service: "t.v1.S", method: "M" });
                await createClientGatewayInterceptor({ secret, subject: "svc" })((async () => ({ message: {} })) as never)(req);
                assert.strictEqual(req.header.get("x-gateway-secret"), secret);
            }
        });
    }
});

describe("header names: creation and Headers agree", () => {
    const NAMES = ["x-a", "X_A.1", "a", "", "a b", "a:b", "a\nb", "ü", "a,b", "(a)", "a/b", "a".repeat(300), "~!#$%&'*+-.^_`|"];
    for (const name of NAMES) {
        it(`header ${JSON.stringify(name).slice(0, 30)}`, () => {
            let platform = true;
            try {
                new Headers().has(name);
                platform = name !== "";
            } catch {
                platform = false;
            }
            assert.strictEqual(creationAccepts(() => sharedSecretTrust({ secret: "s", header: name })), platform);
        });
    }
});
