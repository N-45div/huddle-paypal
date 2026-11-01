import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprint, keyText, parseSignable, signableText, signedBy } from "../../core/src/countersign.ts";
import { base64url, boardKeyOf, fingerprintOf, makeKeyPair } from "../src/board-key.ts";

/** The browser's WebCrypto (Node has the same one), checked by what Huddle and the shop check signatures with. */
describe("the virtual board's key", () => {
  it("says its key the way the button does, with the fingerprint Huddle shows", async () => {
    const board = await boardKeyOf(await makeKeyPair(), true);
    assert.equal(keyText(board.key), board.key, "the raw point, base64url, written the one way");
    assert.equal(board.fingerprint, fingerprint(board.key));
    assert.match(board.fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  });

  it("signs exactly the text it's shown, so Huddle and the shop take it, and nothing else", async () => {
    const board = await boardKeyOf(await makeKeyPair(), true);
    const text = signableText({ v: 1, kind: "buy", id: "pay_00112233445566778899aabb", shop: { id: "localhost:7700", name: "Bean & Leaf" }, cart: "cart_1", items: [{ name: "Café latte", qty: 2, price: "4.50" }], total: "9.00", currency: "USD", expires: "2026-11-01T10:15:00Z" });
    parseSignable(text);
    const signature = await board.sign(text);
    assert.match(signature, /^[A-Za-z0-9_-]{86}$/, "r‖s, 64 bytes");
    assert.equal(signedBy(text, signature, board.key), true);
    assert.equal(signedBy(text.replace("9.00", "0.90"), signature, board.key), false);
    const other = await boardKeyOf(await makeKeyPair(), true);
    assert.equal(signedBy(text, signature, other.key), false);
  });

  it("can't be read out of the browser, only asked to sign", async () => {
    const pair = await makeKeyPair();
    assert.equal(pair.privateKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("jwk", pair.privateKey));
  });

  it("writes bytes and fingerprints the way the button's firmware does", () => {
    assert.equal(base64url(new Uint8Array([0xfb, 0xff, 0xfe])), "-__-");
    assert.equal(base64url(new Uint8Array([1, 2])), "AQI");
    assert.equal(fingerprintOf(new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x7a, 0x8b, 0xff])), "1A2B 3C4D 5E6F 7A8B");
  });
});
