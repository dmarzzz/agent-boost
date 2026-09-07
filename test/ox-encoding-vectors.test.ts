import assert from "node:assert/strict";
import test from "node:test";

import * as Address from "ox/Address";
import * as Secp256k1 from "ox/Secp256k1";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as UserOperation from "ox/erc4337/UserOperation";

/* The network guard deserializes a raw transaction, recovers its sender, and
   hashes UserOperations to prove that what reached the network is what was
   approved. All of that is ox, so an ox upgrade that changed an encoding or a
   signature format would quietly move the guard's ground truth while every
   behavioural test still passed. These vectors pin the bytes themselves. */

const PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const SIGNER = "0xfcad0b19bb29d4674531d6f115237e16afce377c";
const SERIALIZED =
  "0x02f87583aa36a707843b9aca008506fc23ac0082520894222222222222222222222222222222222222222287038d7ea4c6800080c080a0ba626f24e1033a2637d2a6579dd600b80bef944e6e501912426b43c38f3d956ba04760c78540fd02f389b139f5a733874c4b7629e0f3a01bccfa389e8e5bfb31a7";
const TX_HASH =
  "0x1cb942ee27b25b6143c3d1ec4ba5642c54f279999cc3ce8e36f39ee01ce778e6";
const USER_OP_HASH =
  "0x5a80fd9504c77cf44602961add565ed5c7886be256c8dd10851a25f8bdaae883";

const envelope = () =>
  TxEnvelopeEip1559.from({
    chainId: 11_155_111,
    nonce: 7n,
    to: "0x2222222222222222222222222222222222222222",
    value: 1_000_000_000_000_000n,
    gas: 21_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

test("ox derives the same signer address from a fixed private key", () => {
  const signer = Address.fromPublicKey(
    Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY }),
  ).toLowerCase();
  assert.equal(signer, SIGNER);
});

test("ox serializes and hashes a signed EIP-1559 transaction to fixed bytes", () => {
  const unsigned = envelope();
  const signature = Secp256k1.sign({
    payload: TxEnvelopeEip1559.getSignPayload(unsigned),
    privateKey: PRIVATE_KEY,
  });
  const signed = TxEnvelopeEip1559.from(unsigned, { signature });
  assert.equal(TxEnvelopeEip1559.serialize(signed), SERIALIZED);
  assert.equal(TxEnvelopeEip1559.hash(signed), TX_HASH);
});

test("the guard's recovery path returns the signer from serialized bytes", () => {
  // This is the check network-guard.mjs performs on every observed broadcast.
  const back = TxEnvelopeEip1559.deserialize(SERIALIZED);
  const recovered = Secp256k1.recoverAddress({
    payload: TxEnvelopeEip1559.getSignPayload(back),
    signature: { r: back.r!, s: back.s!, yParity: back.yParity! },
  }).toLowerCase();
  assert.equal(recovered, SIGNER, "a recovered sender must match the signer");
});

test("ox hashes a UserOperation to fixed bytes for the pinned EntryPoint", () => {
  const hash = UserOperation.hash(
    UserOperation.fromRpc({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0xdeadbeef",
      callGasLimit: "0x5208",
      verificationGasLimit: "0x5208",
      preVerificationGas: "0x5208",
      maxFeePerGas: "0x6fc23ac00",
      maxPriorityFeePerGas: "0x3b9aca00",
      signature: "0x",
    }),
    {
      chainId: 11_155_111,
      entryPointAddress: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      entryPointVersion: "0.8",
    },
  );
  assert.equal(hash, USER_OP_HASH);
});
