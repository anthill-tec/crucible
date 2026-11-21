# arduino-cli compile failures

Real `arduino-cli compile` output (arduino-cli 1.5.1), captured 2026-10-21 in terminal order and kept
byte for byte except: the ANSI colour codes are stripped (as `arduino-crucible.py` strips them before ingest), the
sketch directory reads `/sketch` and the home directory `/home/user`.

| File | Board | What fails |
|---|---|---|
| `avr-uno-warnings-all.txt` | `arduino:avr:uno`, `--warnings all` | two undeclared names (one with a `note:` suggestion), an unused variable, an assignment used as a truth value |
| `renesas-uno-minima-default.txt` | `arduino:renesas_uno:minima` (the client's default board), default warnings | the same sketch: the two errors only |
| `avr-uno-missing-header.txt` | `arduino:avr:uno` | a missing header (`fatal error:`, `compilation terminated.`) |
| `avr-uno-undefined-reference.txt` | `arduino:avr:uno` | a link failure (`undefined reference to`, `collect2: error: ld returned 1 exit status`) |
| `esp32-undefined-reference.txt` | `esp32:esp32:esp32` (xtensa gcc 14) | a link failure in the newer linker's shape (`file:line:(section+off): undefined reference`, plus object-only lines) |
| `platform-not-installed.txt` | `nosuch:core:board` | no compiler ran: the platform is not installed |

The client sends stdout then stderr, so on the wire arduino-cli's `Used platform` table (stdout) comes
before the diagnostics (stderr); these files keep the terminal's order.
