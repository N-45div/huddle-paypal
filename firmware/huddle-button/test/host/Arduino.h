// Just enough of Arduino for board_key.h to build on a computer: its String.
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

class String : public std::string {
 public:
  String() = default;
  String(const char *text) : std::string(text) {}
  String(const std::string &text) : std::string(text) {}
};
