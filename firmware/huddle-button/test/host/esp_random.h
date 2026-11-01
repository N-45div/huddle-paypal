// The board's random bytes, from the computer's.
#pragma once
#include <sys/random.h>
#include <cstddef>

inline void esp_fill_random(void *out, size_t length) {
  unsigned char *bytes = static_cast<unsigned char *>(out);
  while (length > 0) {
    ssize_t got = getrandom(bytes, length, 0);
    if (got <= 0) continue;
    bytes += got;
    length -= static_cast<size_t>(got);
  }
}
