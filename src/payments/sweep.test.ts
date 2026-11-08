/**
 * Fund sweeping: RLP encoding, EIP-1559 transaction building, signature
 * assembly. The MPC sign call itself is tested only in shape (it needs a
 * real NEAR account with gas), but the math around it is fully offline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rlpEncode, bigintToBytes, txHash, signedTxBytes, mpcSigToVRS, type UnsignedTx, type MpcSignResult } from "./sweep.js";

describe("RLP encoding", () => {
  it("encodes a single byte < 0x80 as itself", () => {
    assert.deepEqual(rlpEncode(Buffer.from([0x42])), Buffer.from([0x42]));
  });

  it("encodes a short string with a length prefix", () => {
    const input = Buffer.from("dog");
    const encoded = rlpEncode(input);
    assert.equal(encoded[0], 0x80 + 3);
    assert.deepEqual(encoded.subarray(1), input);
  });

  it("encodes an empty string as 0x80", () => {
    assert.deepEqual(rlpEncode(Buffer.alloc(0)), Buffer.from([0x80]));
  });

  it("encodes a short list", () => {
    const encoded = rlpEncode([Buffer.from("cat"), Buffer.from("dog")]);
    // list header (0xc0 + total length), then each item
    assert.equal(encoded[0], 0xc0 + 8); // 4 + 4
  });

  it("encodes nested lists", () => {
    const encoded = rlpEncode([Buffer.alloc(0), [Buffer.alloc(0)]]);
    assert.ok(encoded.length > 2);
  });
});

describe("bigintToBytes", () => {
  it("zero is empty", () => {
    assert.deepEqual(bigintToBytes(0n), Buffer.alloc(0));
  });

  it("small values are minimal", () => {
    assert.deepEqual(bigintToBytes(1n), Buffer.from([1]));
    assert.deepEqual(bigintToBytes(127n), Buffer.from([0x7f]));
    assert.deepEqual(bigintToBytes(128n), Buffer.from([0x80]));
    assert.deepEqual(bigintToBytes(256n), Buffer.from([0x01, 0x00]));
  });

  it("handles large chain-id values", () => {
    const bytes = bigintToBytes(84532n); // Base Sepolia
    assert.equal(BigInt("0x" + bytes.toString("hex")), 84532n);
  });
});

describe("EIP-1559 transaction hashing", () => {
  const tx: UnsignedTx = {
    chainId: 84532n,
    nonce: 0n,
    maxPriorityFeePerGas: 1_500_000_000n,  // 1.5 gwei
    maxFeePerGas: 3_000_000_000n,           // 3 gwei
    gasLimit: 21000n,
    to: "0x" + "ab".repeat(20),
    value: 10000000000000n,                 // 0.00001 ETH
    data: Buffer.alloc(0),
    accessList: [],
  };

  it("produces a 32-byte hash", () => {
    const h = txHash(tx);
    assert.equal(h.length, 32);
  });

  it("is deterministic", () => {
    assert.deepEqual(txHash(tx), txHash(tx));
  });

  it("changes when any field changes", () => {
    const h1 = txHash(tx);
    const h2 = txHash({ ...tx, nonce: 1n });
    assert.notDeepEqual(h1, h2);
  });
});

describe("signed transaction assembly", () => {
  const tx: UnsignedTx = {
    chainId: 84532n,
    nonce: 0n,
    maxPriorityFeePerGas: 1_500_000_000n,
    maxFeePerGas: 3_000_000_000n,
    gasLimit: 21000n,
    to: "0x" + "ab".repeat(20),
    value: 10000000000000n,
    data: Buffer.alloc(0),
    accessList: [],
  };

  it("starts with 0x02 (EIP-1559 type)", () => {
    const r = Buffer.alloc(32, 0xaa);
    const s = Buffer.alloc(32, 0xbb);
    const signed = signedTxBytes(tx, 0, r, s);
    assert.equal(signed[0], 0x02, "EIP-1559 type byte");
  });

  it("is longer than unsigned (it has v,r,s)", () => {
    const r = Buffer.alloc(32, 0xaa);
    const s = Buffer.alloc(32, 0x33);
    const signed = signedTxBytes(tx, 1, r, s);
    assert.ok(signed.length > 50, "a signed tx has substance");
  });
});

describe("MPC signature conversion", () => {
  it("extracts r from the affine point (skipping the 02/03 prefix)", () => {
    const mockSig: MpcSignResult = {
      big_r: { affine_point: "02" + "aa".repeat(32) },
      s: { scalar: "bb".repeat(32) },
      recovery_id: 0,
    };
    const { v, r, s } = mpcSigToVRS(mockSig);
    assert.equal(v, 0);
    assert.equal(r.length, 32);
    assert.deepEqual(r, Buffer.alloc(32, 0xaa));
    assert.equal(s.length, 32);
    assert.deepEqual(s, Buffer.alloc(32, 0xbb));
  });

  it("passes through recovery_id as v", () => {
    const mockSig: MpcSignResult = {
      big_r: { affine_point: "03" + "cc".repeat(32) },
      s: { scalar: "dd".repeat(32) },
      recovery_id: 1,
    };
    const { v } = mpcSigToVRS(mockSig);
    assert.equal(v, 1);
  });
});
