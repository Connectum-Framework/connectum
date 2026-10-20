import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { createHttpHealthHandler, parseServiceFromUrl } from "../../src/httpHandler.ts";
import { ServingStatus } from "../../src/types.ts";

/**
 * Minimal mock for Http2ServerRequest
 */
function createMockRequest(url: string, host?: string) {
    return {
        url,
        headers: { host: host ?? "localhost:5000" },
    };
}

/**
 * Minimal mock for Http2ServerResponse
 */
function createMockResponse() {
    let _statusCode = 200;
    let _body = "";
    const _headers: Record<string, string> = {};

    return {
        get statusCode() {
            return _statusCode;
        },
        set statusCode(code: number) {
            _statusCode = code;
        },
        setHeader(name: string, value: string) {
            _headers[name] = value;
        },
        end(data?: string) {
            _body = data ?? "";
        },
        getBody() {
            return _body;
        },
        getHeaders() {
            return _headers;
        },
    };
}

describe("createHttpHealthHandler", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
        manager.initialize(["svc.v1.Foo"]);
    });

    it("should return true and 200 for healthy service", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);

        const body = JSON.parse(res.getBody());
        assert.strictEqual(body.status, "SERVING");
        assert.strictEqual(body.service, "overall");
    });

    it("should return 503 for unhealthy service", () => {
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        handler(req as any, res as any);

        assert.strictEqual(res.statusCode, 503);
        const body = JSON.parse(res.getBody());
        assert.strictEqual(body.status, "NOT_SERVING");
        assert.strictEqual(body.service, "overall");
    });

    // An unhandled request is left entirely to the next handler: nothing is
    // written to the response.
    it("should return false for non-health paths and write nothing", () => {
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/api/foo");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, false);
        assert.strictEqual(res.statusCode, 200, "the status code must stay at its untouched default");
        assert.strictEqual(res.getBody(), "");
        assert.deepStrictEqual(res.getHeaders(), {});
    });

    it("should handle /readyz path", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/readyz");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);
    });

    it("should handle /health path", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/health");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);
    });

    it("should handle custom health paths", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager, ["/custom-health"]);

        const req = createMockRequest("/custom-health");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);
    });

    it("should not handle paths not in custom list", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager, ["/custom-health"]);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, false);
    });

    it("should return 404 for unknown specific service", () => {
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz?service=unknown.Service");
        const res = createMockResponse();

        handler(req as any, res as any);

        assert.strictEqual(res.statusCode, 404);

        const body = JSON.parse(res.getBody());
        assert.strictEqual(body.status, "SERVICE_UNKNOWN");
    });

    // The published mapping: each serving status has exactly one name in the
    // JSON body and one HTTP code. A swapped or collapsed entry (for example
    // every status reported as "UNKNOWN", or 404 for NOT_SERVING) must fail.
    const statusTable = [
        { status: ServingStatus.UNKNOWN, name: "UNKNOWN", httpCode: 503 },
        { status: ServingStatus.SERVING, name: "SERVING", httpCode: 200 },
        { status: ServingStatus.NOT_SERVING, name: "NOT_SERVING", httpCode: 503 },
        { status: ServingStatus.SERVICE_UNKNOWN, name: "SERVICE_UNKNOWN", httpCode: 404 },
    ];

    for (const { status, name, httpCode } of statusTable) {
        it(`reports ${name} as the exact status name with HTTP ${httpCode}`, () => {
            manager.update(status, "svc.v1.Foo");
            const handler = createHttpHealthHandler(manager);

            const res = createMockResponse();
            handler(createMockRequest("/healthz?service=svc.v1.Foo") as any, res as any);

            assert.strictEqual(res.statusCode, httpCode);
            assert.deepStrictEqual(JSON.parse(res.getBody()).status, name);
        });
    }
});

describe("parseServiceFromUrl", () => {
    it("should parse service from query string", () => {
        const service = parseServiceFromUrl("/healthz?service=my.service.v1.MyService", "localhost:5000");
        assert.strictEqual(service, "my.service.v1.MyService");
    });

    it("should return undefined for no query string", () => {
        const service = parseServiceFromUrl("/healthz", "localhost:5000");
        assert.strictEqual(service, undefined);
    });

    // The documented contract: the result is undefined when the URL is absent
    // or malformed, never an exception and never a placeholder string.
    for (const { url, desc } of [
        { url: undefined, desc: "undefined URL" },
        { url: "", desc: "empty URL" },
        { url: "http://", desc: "malformed absolute URL" },
    ]) {
        it(`should return undefined for ${desc}`, () => {
            assert.strictEqual(parseServiceFromUrl(url, "localhost:5000"), undefined);
        });
    }

    it("should return undefined when no service param", () => {
        const service = parseServiceFromUrl("/healthz?other=value", "localhost:5000");
        assert.strictEqual(service, undefined);
    });

    // The host only resolves a relative URL: the answer must not depend on
    // which (or whether a) Host header the client sent.
    for (const host of [undefined, "localhost:5000", "example.com", "[::1]:5000"]) {
        it(`should read the service parameter with host ${host === undefined ? "missing" : host}`, () => {
            assert.strictEqual(parseServiceFromUrl("/healthz?service=test.Svc", host), "test.Svc");
        });
    }

    // An empty or syntactically invalid host used to make the base URL
    // unparseable, so the service parameter was silently dropped and the
    // handler reported overall health instead of the named service.
    for (const host of ["", "bad host"]) {
        it(`should read the service parameter with host "${host}"`, () => {
            assert.strictEqual(parseServiceFromUrl("/healthz?service=test.Svc", host), "test.Svc");
        });
    }

    it("should read the service parameter when no host argument is passed", () => {
        assert.strictEqual(parseServiceFromUrl("/healthz?service=test.Svc"), "test.Svc");
    });

    it("should return the empty string for an empty service value", () => {
        assert.strictEqual(parseServiceFromUrl("/healthz?service="), "");
    });
});

describe("createHttpHealthHandler — Host header independence", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
        manager.initialize(["svc.v1.Foo"]);
    });

    // svc.v1.Foo is still UNKNOWN, so overall health is 503, but the request
    // names an unknown service. A dropped parameter would surface as the
    // overall answer (503, "overall") instead of 404 with the requested name.
    for (const host of ["", "bad host"]) {
        it(`should report the named service with Host "${host}"`, () => {
            const handler = createHttpHealthHandler(manager);
            const res = createMockResponse();

            handler(createMockRequest("/healthz?service=unknown.Svc", host) as any, res as any);

            assert.strictEqual(res.statusCode, 404);
            const body = JSON.parse(res.getBody());
            assert.strictEqual(body.status, "SERVICE_UNKNOWN");
            assert.strictEqual(body.service, "unknown.Svc");
        });
    }
});

describe("createHttpHealthHandler — additional scenarios", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
        manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
    });

    it("should return 200 with body containing service name for known SERVING service", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz?service=svc.v1.Foo");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);

        const body = JSON.parse(res.getBody());
        assert.strictEqual(body.status, "SERVING");
        assert.strictEqual(body.service, "svc.v1.Foo");
    });

    it("should return 503 for known NOT_SERVING service", () => {
        manager.update(ServingStatus.NOT_SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz?service=svc.v1.Foo");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 503);

        const body = JSON.parse(res.getBody());
        assert.strictEqual(body.status, "NOT_SERVING");
        assert.strictEqual(body.service, "svc.v1.Foo");
    });

    it("should include timestamp field as ISO string in response", () => {
        manager.update(ServingStatus.SERVING);
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        const before = Date.now();
        handler(req as any, res as any);
        const after = Date.now();

        const body = JSON.parse(res.getBody());
        assert.strictEqual(typeof body.timestamp, "string");

        // The published form is "2026-02-12T10:30:00.000Z": a UTC instant with
        // milliseconds. Date.parse alone also accepts non-ISO strings.
        assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        // The instant is the moment of the request, not a constant or an epoch.
        const instant = Date.parse(body.timestamp);
        assert.ok(instant >= before && instant <= after, `timestamp ${body.timestamp} must lie within the request window [${before}, ${after}]`);
    });

    it("should set Content-Type header to application/json", () => {
        manager.update(ServingStatus.SERVING);
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        handler(req as any, res as any);

        // The body is JSON, whose registered media type is application/json
        // (RFC 8259). Parameters such as charset are allowed, a different type
        // or a missing header is not.
        const headers = res.getHeaders();
        const contentType = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
        assert.ok(contentType, "Content-Type header should be set");
        assert.strictEqual(headers[contentType]?.split(";")[0]?.trim().toLowerCase(), "application/json");
    });

    it("should not match paths with trailing slashes (exact match only)", () => {
        manager.update(ServingStatus.SERVING);
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz/");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);
        assert.strictEqual(handled, false, "Path with trailing slash should not match");
    });

    it("should not match a path that differs only in case", () => {
        const handler = createHttpHealthHandler(manager);

        assert.strictEqual(handler(createMockRequest("/Healthz") as any, createMockResponse() as any), false);
    });

    it("should ignore the query string and the method when matching the path", () => {
        manager.update(ServingStatus.SERVING);
        const handler = createHttpHealthHandler(manager);
        const res = createMockResponse();

        const handled = handler({ ...createMockRequest("/healthz?x=1"), method: "POST" } as any, res as any);

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 200);
    });

    it("should report the overall state for an empty service value", () => {
        manager.update(ServingStatus.SERVING);
        const handler = createHttpHealthHandler(manager);
        const res = createMockResponse();

        handler(createMockRequest("/healthz?service=") as any, res as any);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(JSON.parse(res.getBody()).status, "SERVING");
    });
});
