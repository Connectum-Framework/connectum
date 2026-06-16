// Documented exceptions for the publish-boundary gate. Every exemption from a
// check MUST have a recorded reason here — an unexplained exception is a
// coverage gap, not a pass.

// Subpaths that cannot be runtime-imported / completeness-diffed because the
// `.` entry is not a library module:
export const IMPORT_EXCEPTIONS = {
    "@connectum/cli": "executable entry — dist/index.js calls runMain() + process.exit() on import; the programmatic API is on ./commands/* and ./utils/*",
    "@connectum/protoc-gen-catalog": "buf-plugin entry — reads stdin when run; validated by the catalog codegen check, not by import",
};

/** Reason this spec is exempt from import-based checks, or null if it is not. */
export function importExceptionReason(spec) {
    return IMPORT_EXCEPTIONS[spec] ?? null;
}
