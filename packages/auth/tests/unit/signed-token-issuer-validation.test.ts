/**
 * The per-issuer expectations of `signedTokenTrust` follow the same rules as the JWT interceptor.
 *
 * An empty `audience` or a `maxTokenAge` that is 0 or a text jose cannot read was accepted when the
 * trust source was created, and then every internal call was rejected without a hint at the cause.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { signedTokenTrust } from "../../src/internal-auth-interceptor.ts";
import type { SignedTokenIssuer } from "../../src/types.ts";

const issuer = (extra: Partial<SignedTokenIssuer>): SignedTokenIssuer => ({ jwksUri: "https://trips.internal/.well-known/jwks.json", ...extra });
const create = (extra: Partial<SignedTokenIssuer>) => signedTokenTrust({ issuers: { "trips-service": issuer(extra) } });

describe("signedTokenTrust: issuer expectations", () => {
    for (const audience of ["", ["billing", ""], 5, null]) {
        it(`refuses audience ${JSON.stringify(audience)} and names the issuer`, () => {
            assert.throws(
                () => create({ audience: audience as never }),
                (err: unknown) => err instanceof TypeError && /signedTokenTrust issuers\["trips-service"\] audience must be a non-empty string or an array of non-empty strings/.test(err.message),
            );
        });
    }

    for (const maxTokenAge of [0, -1, Number.NaN, "", "1month", "-1h", "1h ago", "0s"]) {
        it(`refuses maxTokenAge ${JSON.stringify(maxTokenAge)} and names the issuer`, () => {
            assert.throws(
                () => create({ maxTokenAge }),
                (err: unknown) => err instanceof RangeError && /signedTokenTrust issuers\["trips-service"\] maxTokenAge must/.test(err.message),
            );
        });
    }

    it("accepts usable expectations and omitted ones", () => {
        create({});
        create({ audience: "billing", maxTokenAge: "5m" });
        create({ audience: ["billing", "ledger"], maxTokenAge: 300 });
    });
});
