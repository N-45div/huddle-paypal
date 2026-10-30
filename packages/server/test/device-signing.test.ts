import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, fingerprint, mock, Store } from "@huddle/core";
import { DeviceHub, type ToDevice } from "../src/devices.ts";

/** A board as the ESP32 makes one: its raw P-256 point, and r‖s signatures. */
export function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp() {
  const store = new Store();
  const hub = new DeviceHub(store, new Engine(store, { mock }));
  const { device } = store.addDevice("Desk button");
  const connect = (key: string | null, deviceId: string | null = device.id) => {
    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: deviceId ? "Desk button" : "Virtual button", version: "test", deviceId });
    session.receive(JSON.stringify({ type: "hello", audio: false, ...(key === null ? {} : { key }) }));
    return { sent, session, signer: () => sent.findLast((message) => message.type === "signer") };
  };
  return { store, device, connect };
}

describe("a board's signing key", () => {
  it("is kept the first time the board says it, with a fingerprint to compare in Devices", () => {
    const { store, device, connect } = setUp();
    const mine = board();
    const first = connect(mine.key);
    assert.deepEqual(first.signer(), { type: "signer", ok: true, fingerprint: fingerprint(mine.key), name: "Desk button" });
    assert.equal(store.signerForDevice(device.id)?.key, mine.key);
    // Coming back with the same key is the same board.
    assert.equal(connect(mine.key).signer()?.type === "signer" && connect(mine.key).signer()?.ok, true);
    assert.equal(store.signers().length, 1);
  });

  it("is refused when the same gadget comes back with another key, so a swapped board can't pay as yours", () => {
    const { store, device, connect } = setUp();
    const mine = board();
    connect(mine.key);
    const swapped = connect(board().key).signer();
    assert.equal(swapped?.type === "signer" && swapped.ok, false);
    assert.match(swapped?.type === "signer" ? (swapped.problem ?? "") : "", /key changed since it was added/);
    assert.equal(store.signerForDevice(device.id)?.key, mine.key, "the first key stays the board's");
  });

  it("is kept by the key itself for a board in a browser, which has no device", () => {
    const { store, connect } = setUp();
    const virtual = board();
    const shown = connect(virtual.key, null).signer();
    assert.equal(shown?.type === "signer" && shown.name, "Virtual board");
    assert.equal(store.signer(virtual.key)?.deviceId, null);
  });

  it("isn't needed by a button that doesn't sign, and a key that isn't one is said so", () => {
    const { store, connect } = setUp();
    assert.equal(connect(null).signer(), undefined);
    assert.equal(store.signers().length, 0);
    const bad = connect("not-a-key");
    assert.match(bad.sent.findLast((message) => message.type === "error")?.type === "error" ? (bad.sent.findLast((message) => message.type === "error") as { message: string }).message : "", /isn't one Huddle can use/);
  });
});
