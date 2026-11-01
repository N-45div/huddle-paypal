// On the board this turns the chip's own entropy source on; a computer's is always on.
#pragma once
inline void bootloader_random_enable() {}
inline void bootloader_random_disable() {}
