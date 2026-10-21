import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { toHex, type Hex } from "viem";

import { cb58Decode, conversionWarpMessage, packConversionData, predicateKeys } from "../scripts/validator-manager.ts";

/**
 * The Fuji L1's conversion (P-Chain tx buRFjCjjieoJKmVztWFaYm8rNaN67FqLBiUDcsEHkeWiERGLu) and the
 * signed message that initialized its ValidatorManager (C-Chain tx 0xfdeb7e52…4d39).
 */
const CONVERSION = {
  subnetID: toHex(cb58Decode("UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3")),
  validatorManagerBlockchainID: toHex(cb58Decode("yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp")),
  validatorManagerAddress: "0xDF5D0Fd21440267A966e8AcD8B579a2d8B0ECCb0" as Hex,
  initialValidators: [
    {
      nodeID: "0x3c4465218f7befd266deb8ddc68da693f7eb5fba" as Hex,
      blsPublicKey:
        "0x826f3c1400f381b6e0ed8a6ee82c29eef59e448f4dad45532090e54d3f1970d8380e03e71d5bc4bd707517c281525fb5" as Hex,
      weight: 100n,
    },
  ],
};
const P_CHAIN_CONVERSION_ID = "6HuMb3c2DHADeztXsqRp3eLGyeCrRBk8HSuJpi9KswgorRtK9";
const SIGNED: Hex =
  "0x00000000000500000000000000000000000000000000000000000000000000000000000000000000003400000000000100000000000000260000000000000c03cbcef9f891a8095110cba35ee24890181aef18f8032017a1170290c2392a0000000000000009011260402080008483b790959ba8c6032b0f28b2e577820359c48ad6e7be1d2b27c69038d8412b7d3d4ea9e4eff02e9aa0c62039f5ba47cfd40e472527b36d6f08e10103b76151259b34750bf2f8869a5a9b085a4c6f8f0206dda682f7ef4a05cbd919b36e2c57ba9c";

const sha256 = (bytes: Hex): Hex => toHex(createHash("sha256").update(Buffer.from(bytes.slice(2), "hex")).digest());

describe("validator manager", () => {
  it("decodes cb58 IDs and refuses a bad checksum", () => {
    assert.equal(CONVERSION.validatorManagerBlockchainID, "0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5");
    assert.throws(() => cb58Decode("yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWq"), /checksum/);
  });

  it("packs the conversion data to the conversion ID the P-Chain recorded", () => {
    assert.equal(sha256(packConversionData(CONVERSION)), toHex(cb58Decode(P_CHAIN_CONVERSION_ID)));
  });

  it("builds the unsigned Warp message the Primary Network signed", () => {
    const unsigned = conversionWarpMessage(5, toHex(cb58Decode(P_CHAIN_CONVERSION_ID)));
    assert.ok(SIGNED.startsWith(unsigned), "the signed message does not begin with the unsigned one");
  });

  it("encodes the predicate as the C-Chain accepted it", () => {
    const keys = predicateKeys(SIGNED);
    assert.equal(keys.length, 7);
    assert.equal(keys[6], "0xa682f7ef4a05cbd919b36e2c57ba9cff00000000000000000000000000000000");
  });
});
