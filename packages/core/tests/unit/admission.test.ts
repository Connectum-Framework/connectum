/**
 * The createServer() readMaxBytes range must be exactly Connect's: a narrower
 * range would reject limits Connect supports, a wider one would let a value
 * through construction only to fail later at route build. Connect keeps its
 * maximum private, so this pins our copy against Connect's own check.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { validateReadWriteMaxBytes } from "@connectrpc/connect/protocol";
import { MAX_READ_MAX_BYTES, validateAdmissionOptions } from "../../src/admission.ts";

describe("validateAdmissionOptions", () => {
    it("uses Connect's maximum: Connect accepts it and rejects one more", () => {
        assert.doesNotThrow(() => validateReadWriteMaxBytes(MAX_READ_MAX_BYTES, undefined, undefined));
        assert.throws(() => validateReadWriteMaxBytes(MAX_READ_MAX_BYTES + 1, undefined, undefined));
        assert.doesNotThrow(() => validateAdmissionOptions({ readMaxBytes: MAX_READ_MAX_BYTES }));
        assert.throws(() => validateAdmissionOptions({ readMaxBytes: MAX_READ_MAX_BYTES + 1 }), RangeError);
    });

    it("accepts unset options", () => {
        assert.doesNotThrow(() => validateAdmissionOptions({}));
    });
});
