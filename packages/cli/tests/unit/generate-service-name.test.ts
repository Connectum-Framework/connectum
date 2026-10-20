/**
 * `connectum generate service <name>`: which names are accepted and what a refused name leaves behind.
 *
 * A name is turned into a proto package, a proto service, a TypeScript binding and two file
 * paths. A name that the derivation would change silently, that cannot be written, or that maps
 * onto another service's proto has to be refused before the first file or directory is created,
 * so every refusal below is checked against a recursive listing of the directory (files AND
 * directories) taken before and after.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { executeGenerateService } from "../../src/commands/generate-service.ts";

/** Gitignored scratch area of the repository: nothing here is written outside it. */
const scratchRoot = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));

/** Every entry under `root` (directories end with `/`), sorted, so an empty leftover directory shows up. */
function listing(root: string, relative = ""): string[] {
    const entries: string[] = [];
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            entries.push(`${path}/`, ...listing(root, path));
        } else {
            entries.push(path);
        }
    }
    return entries.sort();
}

describe("generate service: the service name", () => {
    let root: string;
    let dir: string;

    before(() => {
        mkdirSync(scratchRoot, { recursive: true });
        root = mkdtempSync(join(scratchRoot, "gensvc-name-"));
    });
    after(() => {
        rmSync(root, { recursive: true, force: true });
    });
    beforeEach(() => {
        dir = mkdtempSync(join(root, "run-"));
        mock.method(console, "log", () => undefined);
    });
    afterEach(() => {
        mock.restoreAll();
    });

    /** Expects a refusal whose message names the name and matches the rule, with the directory untouched. */
    async function assertRefused(name: string, rule: RegExp): Promise<void> {
        const before = listing(dir);
        await assert.rejects(
            () => executeGenerateService({ name, cwd: dir }),
            (error: unknown) => {
                assert.ok(error instanceof Error, String(error));
                assert.ok(error.message.includes(`"${name}"`), `the message must name the name: ${error.message}`);
                assert.match(error.message, rule);
                return true;
            },
        );
        assert.deepEqual(listing(dir), before, `refused "${name}" must not touch the directory`);
    }

    describe("characters outside ASCII letters, digits, '-' and '_'", () => {
        const rule = /only ASCII letters, digits, "-" and "_" are allowed/;

        for (const name of ["../x", "a/b", "a\\b", "A/../..", "x/", "/abs"]) {
            it(`refuses the path-like name ${JSON.stringify(name)} and writes nothing`, async () => {
                await assertRefused(name, rule);
            });
        }

        for (const name of ["..", ".", "billing.v2", "a.b"]) {
            it(`refuses the dotted name ${JSON.stringify(name)} and writes nothing`, async () => {
                await assertRefused(name, rule);
            });
        }

        for (const name of ["Привет", "Привет-billing", "billing-платежи", "café"]) {
            it(`refuses the non-ASCII name ${JSON.stringify(name)} and writes nothing`, async () => {
                await assertRefused(name, rule);
            });
        }

        for (const name of ["Order Service", "order\tservice"]) {
            it(`refuses the name with inner whitespace ${JSON.stringify(name)} and writes nothing`, async () => {
                await assertRefused(name, rule);
            });
        }

        it("names the offending characters", async () => {
            await assert.rejects(
                () => executeGenerateService({ name: "a/b.c", cwd: dir }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.ok(error.message.includes('"/"') && error.message.includes('"."'), error.message);
                    return true;
                },
            );
        });
    });

    describe("the first character", () => {
        for (const name of ["123-orders", "0a", "_billing", "-billing"]) {
            it(`refuses ${JSON.stringify(name)}: a name must start with a letter`, async () => {
                // The argument parser takes a leading "-" for an option, so that case is
                // exercised through the function, which is where the rule lives.
                await assertRefused(name, /must start with a letter/);
            });
        }
    });

    describe("the length", () => {
        it("refuses 215 characters with the limit in the message and creates no directory", async () => {
            await assertRefused("a".repeat(215), /longer than 214 characters/);
        });

        it("accepts 214 characters", async () => {
            const name = "a".repeat(214);
            await executeGenerateService({ name, cwd: dir });
            assert.ok(existsSync(join(dir, `proto/${name}/v1/${name}.proto`)));
            assert.ok(existsSync(join(dir, `src/services/${name}Service.ts`)));
        });
    });

    it("reports every broken rule in one message", async () => {
        await assert.rejects(
            () => executeGenerateService({ name: "1/a", cwd: dir }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /must start with a letter/);
                assert.match(error.message, /only ASCII letters, digits, "-" and "_" are allowed/);
                return true;
            },
        );
        assert.deepEqual(listing(dir), []);
    });

    describe("accepted names", () => {
        const cases: Array<[name: string, protoPath: string, modulePath: string]> = [
            ["billing", "proto/billing/v1/billing.proto", "src/services/billingService.ts"],
            ["Billing", "proto/billing/v1/billing.proto", "src/services/billingService.ts"],
            ["billing-v2", "proto/billingv2/v1/billingv2.proto", "src/services/billingV2Service.ts"],
            ["order_service", "proto/orderservice/v1/orderservice.proto", "src/services/orderServiceService.ts"],
            ["x1y", "proto/x1y/v1/x1y.proto", "src/services/x1yService.ts"],
        ];
        for (const [name, protoPath, modulePath] of cases) {
            it(`scaffolds ${JSON.stringify(name)} into ${protoPath} and ${modulePath}`, async () => {
                await executeGenerateService({ name, cwd: dir });
                assert.deepEqual(
                    listing(dir).filter((entry) => !entry.endsWith("/")),
                    [protoPath, modulePath].sort(),
                );
            });
        }

        it("ignores whitespace around the name", async () => {
            await executeGenerateService({ name: "  billing  ", cwd: dir });
            assert.ok(existsSync(join(dir, "src/services/billingService.ts")));
        });

        it("refuses a blank name with the message that a name is required, and writes nothing", async () => {
            await assert.rejects(() => executeGenerateService({ name: "   ", cwd: dir }), /service name is required/);
            assert.deepEqual(listing(dir), []);
        });
    });
});

describe("generate service: a name that maps onto another service's proto", () => {
    let root: string;
    let dir: string;

    before(() => {
        mkdirSync(scratchRoot, { recursive: true });
        root = mkdtempSync(join(scratchRoot, "gensvc-collision-"));
    });
    after(() => {
        rmSync(root, { recursive: true, force: true });
    });
    beforeEach(() => {
        dir = mkdtempSync(join(root, "run-"));
        mock.method(console, "log", () => undefined);
    });
    afterEach(() => {
        mock.restoreAll();
    });

    it("refuses 'a-b' after 'ab': the kept proto declares AbService, the new module would import ABService", async () => {
        await executeGenerateService({ name: "ab", cwd: dir });
        const before = listing(dir);

        await assert.rejects(
            () => executeGenerateService({ name: "a-b", cwd: dir }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.ok(error.message.includes("proto/ab/v1/ab.proto"), error.message);
                assert.ok(error.message.includes("ABService"), error.message);
                assert.ok(error.message.includes('"a-b"'), error.message);
                return true;
            },
        );

        assert.deepEqual(listing(dir), before);
        assert.equal(existsSync(join(dir, "src/services/aBService.ts")), false);
    });

    it("with --with-events also requires the event-handler service in the kept proto", async () => {
        await executeGenerateService({ name: "ab", cwd: dir });
        // The kept proto declares AbService only. With the module gone, the module that
        // --with-events needs would import AbEventHandlers, which that proto does not declare.
        rmSync(join(dir, "src/services/abService.ts"));
        const before = listing(dir);

        await assert.rejects(() => executeGenerateService({ name: "ab", withEvents: true, cwd: dir }), /AbEventHandlers/);

        assert.deepEqual(listing(dir), before);
    });

    it("treats a repeated run of the same name as a no-op", async () => {
        await executeGenerateService({ name: "ab", cwd: dir });
        const before = listing(dir);
        await executeGenerateService({ name: "ab", cwd: dir });
        assert.deepEqual(listing(dir), before);
    });

    it("treats the same name in another letter case as a no-op", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        const before = listing(dir);
        await executeGenerateService({ name: "Billing", cwd: dir });
        assert.deepEqual(listing(dir), before);
    });

    it("writes the module again when only the module was deleted", async () => {
        await executeGenerateService({ name: "ab", cwd: dir });
        const proto = readFileSync(join(dir, "proto/ab/v1/ab.proto"), "utf8");
        rmSync(join(dir, "src/services/abService.ts"));

        await executeGenerateService({ name: "ab", cwd: dir });

        assert.ok(existsSync(join(dir, "src/services/abService.ts")));
        assert.equal(readFileSync(join(dir, "proto/ab/v1/ab.proto"), "utf8"), proto);
    });

    it("lets --force overwrite the proto and write the module for the new name", async () => {
        await executeGenerateService({ name: "ab", cwd: dir });

        await executeGenerateService({ name: "a-b", force: true, cwd: dir });

        assert.match(readFileSync(join(dir, "proto/ab/v1/ab.proto"), "utf8"), /^service ABService \{$/m);
        assert.match(readFileSync(join(dir, "src/services/aBService.ts"), "utf8"), /import \{ ABService \}/);
    });

    it("leaves a hand-written proto alone when it still declares the service", async () => {
        mkdirSync(join(dir, "proto/billing/v1"), { recursive: true });
        writeFileSync(join(dir, "proto/billing/v1/billing.proto"), 'syntax = "proto3";\npackage billing.v1;\nservice   BillingService  {\n}\n');

        await executeGenerateService({ name: "billing", cwd: dir });

        assert.ok(existsSync(join(dir, "src/services/billingService.ts")));
    });
});
