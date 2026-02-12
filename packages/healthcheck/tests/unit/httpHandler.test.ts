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
    });

    it("should return false for non-health paths", () => {
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/api/foo");
        const res = createMockResponse();

        const handled = handler(req as any, res as any);

        assert.strictEqual(handled, false);
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

    it("should use Map-based status names instead of enum reverse mapping", () => {
        manager.update(ServingStatus.SERVING, "svc.v1.Foo");
        const handler = createHttpHealthHandler(manager);

        const req = createMockRequest("/healthz");
        const res = createMockResponse();

        handler(req as any, res as any);

        const body = JSON.parse(res.getBody());
        // Should be a proper string, not a number or undefined
        assert.strictEqual(typeof body.status, "string");
        assert.ok(["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"].includes(body.status));
    });
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

    it("should return undefined for undefined URL", () => {
        const service = parseServiceFromUrl(undefined, "localhost:5000");
        assert.strictEqual(service, undefined);
    });

    it("should return undefined when no service param", () => {
        const service = parseServiceFromUrl("/healthz?other=value", "localhost:5000");
        assert.strictEqual(service, undefined);
    });

    it("should handle missing host", () => {
        const service = parseServiceFromUrl("/healthz?service=test.Svc", undefined);
        assert.strictEqual(service, "test.Svc");
    });
});
