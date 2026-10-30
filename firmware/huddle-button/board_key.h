// The button's signing key: a P-256 key the board makes for itself the first time it starts, kept in its
// own flash (Preferences), and used for one thing: signing the exact text of a payment you've held the button
// for. Huddle is only ever given the public half, in hello; the private half never leaves the board.
//
// Kept as plain bytes in Preferences. Anyone with the board in hand and a USB cable can read flash that isn't
// encrypted, so for real money turn on the ESP32-S3's flash and NVS encryption, or keep the key in a secure
// element (an ATECC608 costs about $1). See the firmware README.
#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include <bootloader_random.h>
#include <esp_random.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <mbedtls/sha256.h>

namespace boardkey {

uint8_t secret[32];   // the private scalar
uint8_t point[65];    // the public point, uncompressed (0x04, x, y): what Huddle and shops hold
bool ready = false;
String keyText;       // the public point, base64url: sent in hello
String fingerprint;   // the first 8 bytes of SHA-256(point), in hex fours: shown here and in Devices

int randomBytes(void *, unsigned char *out, size_t length) {
  esp_fill_random(out, length);
  return 0;
}

String base64url(const uint8_t *data, size_t length) {
  static const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  String out;
  out.reserve((length * 4 + 2) / 3);
  for (size_t i = 0; i < length; i += 3) {
    uint32_t chunk = (uint32_t)data[i] << 16 | (i + 1 < length ? (uint32_t)data[i + 1] << 8 : 0) | (i + 2 < length ? data[i + 2] : 0);
    out += alphabet[(chunk >> 18) & 63];
    out += alphabet[(chunk >> 12) & 63];
    if (i + 1 < length) out += alphabet[(chunk >> 6) & 63];
    if (i + 2 < length) out += alphabet[chunk & 63];
  }
  return out;
}

void describe() {
  keyText = base64url(point, sizeof point);
  uint8_t hash[32];
  mbedtls_sha256(point, sizeof point, hash, 0);
  char text[20];
  snprintf(text, sizeof text, "%02X%02X %02X%02X %02X%02X %02X%02X", hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]);
  fingerprint = text;
}

/**
 * The board's key from flash, made the first time. Call it early in setup, before I2S starts: making a key
 * turns on the chip's own entropy source (its SAR ADC), which mustn't run beside I2S, so the key is truly
 * random even with Wi-Fi off. Returns true when the key was made just now.
 */
bool load(Preferences &prefs) {
  if (prefs.getBytesLength("sk") == sizeof secret && prefs.getBytesLength("pk") == sizeof point) {
    prefs.getBytes("sk", secret, sizeof secret);
    prefs.getBytes("pk", point, sizeof point);
    ready = point[0] == 0x04;
    if (ready) {
      describe();
      return false;
    }
  }
  mbedtls_ecp_keypair pair;
  mbedtls_ecp_group group;
  mbedtls_mpi d;
  mbedtls_ecp_point q;
  mbedtls_ecp_keypair_init(&pair);
  mbedtls_ecp_group_init(&group);
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&q);
  bootloader_random_enable();
  int failed = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, &pair, randomBytes, nullptr);
  bootloader_random_disable();
  size_t written = 0;
  if (!failed) failed = mbedtls_ecp_export(&pair, &group, &d, &q);
  if (!failed) failed = mbedtls_mpi_write_binary(&d, secret, sizeof secret);
  if (!failed) failed = mbedtls_ecp_point_write_binary(&group, &q, MBEDTLS_ECP_PF_UNCOMPRESSED, &written, point, sizeof point);
  mbedtls_ecp_point_free(&q);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&group);
  mbedtls_ecp_keypair_free(&pair);
  ready = !failed && written == sizeof point;
  if (ready) {
    prefs.putBytes("sk", secret, sizeof secret);
    prefs.putBytes("pk", point, sizeof point);
    describe();
  }
  return ready;
}

/**
 * The board's signature of exactly this text: ECDSA P-256 over the SHA-256 of its UTF-8 bytes, r and s side by
 * side (64 bytes), base64url, which is what Huddle and the shop check. Deterministic (RFC 6979) where mbedTLS has
 * it, so no random number is needed to sign. Empty when it can't.
 */
String sign(const String &text) {
  if (!ready) return "";
  uint8_t hash[32];
  if (mbedtls_sha256(reinterpret_cast<const unsigned char *>(text.c_str()), text.length(), hash, 0)) return "";
  mbedtls_ecp_group group;
  mbedtls_mpi d, r, s;
  mbedtls_ecp_group_init(&group);
  mbedtls_mpi_init(&d);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int failed = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1);
  if (!failed) failed = mbedtls_mpi_read_binary(&d, secret, sizeof secret);
#if defined(MBEDTLS_ECDSA_DETERMINISTIC)
  if (!failed) failed = mbedtls_ecdsa_sign_det_ext(&group, &r, &s, &d, hash, sizeof hash, MBEDTLS_MD_SHA256, randomBytes, nullptr);
#else
  if (!failed) failed = mbedtls_ecdsa_sign(&group, &r, &s, &d, hash, sizeof hash, randomBytes, nullptr);
#endif
  uint8_t signature[64];
  if (!failed) failed = mbedtls_mpi_write_binary(&r, signature, 32);
  if (!failed) failed = mbedtls_mpi_write_binary(&s, signature + 32, 32);
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&group);
  return failed ? "" : base64url(signature, sizeof signature);
}

/**
 * Whether the board can sign and check its own signature: it signs a fixed text and verifies it with its public
 * point, as Huddle will. Run once at start-up; a board that fails it doesn't offer to sign.
 */
bool selfCheck() {
  if (!ready) return false;
  const String text = "huddle self-check";
  String signed64 = sign(text);
  if (signed64.length() != 86) return false;
  // Back from base64url to r and s.
  uint8_t signature[64];
  size_t got = 0;
  uint32_t buffer = 0;
  int bits = 0;
  for (size_t i = 0; i < signed64.length() && got < sizeof signature; i++) {
    char c = signed64.c_str()[i];
    int value = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '-' ? 62 : c == '_' ? 63 : -1;
    if (value < 0) return false;
    buffer = buffer << 6 | (uint32_t)value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      signature[got++] = (uint8_t)(buffer >> bits);
    }
  }
  if (got != sizeof signature) return false;
  uint8_t hash[32];
  if (mbedtls_sha256(reinterpret_cast<const unsigned char *>(text.c_str()), text.length(), hash, 0)) return false;
  mbedtls_ecp_group group;
  mbedtls_ecp_point q;
  mbedtls_mpi r, s;
  mbedtls_ecp_group_init(&group);
  mbedtls_ecp_point_init(&q);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int failed = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1);
  if (!failed) failed = mbedtls_ecp_point_read_binary(&group, &q, point, sizeof point);
  if (!failed) failed = mbedtls_mpi_read_binary(&r, signature, 32);
  if (!failed) failed = mbedtls_mpi_read_binary(&s, signature + 32, 32);
  if (!failed) failed = mbedtls_ecdsa_verify(&group, hash, sizeof hash, &q, &r, &s);
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_ecp_point_free(&q);
  mbedtls_ecp_group_free(&group);
  return !failed;
}

}  // namespace boardkey
