// The board's flash, as a map in memory: what board_key.h keeps its key in.
#pragma once
#include <cstring>
#include <map>
#include <string>
#include <vector>

class Preferences {
 public:
  size_t getBytesLength(const char *key) {
    auto found = held.find(key);
    return found == held.end() ? 0 : found->second.size();
  }
  size_t getBytes(const char *key, void *out, size_t length) {
    auto found = held.find(key);
    if (found == held.end() || found->second.size() > length) return 0;
    memcpy(out, found->second.data(), found->second.size());
    return found->second.size();
  }
  size_t putBytes(const char *key, const void *data, size_t length) {
    const uint8_t *bytes = static_cast<const uint8_t *>(data);
    held[key] = std::vector<uint8_t>(bytes, bytes + length);
    return length;
  }

 private:
  std::map<std::string, std::vector<uint8_t>> held;
};
