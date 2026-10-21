# arduino-cli compile failures

Real `arduino-cli compile` output (arduino-cli 1.5.1), captured 2026-10-21 and kept byte for byte
except: the ANSI colour codes are stripped (as `arduino-crucible.py` strips them before ingest), the
sketch directory reads `/sketch` and the home directory `/home/user`.

| File | Board | What fails |
|---|---|---|
| `avr-uno-warnings-all.txt` | `arduino:avr:uno`, `--warnings all` | two undeclared names (one with a `note:` suggestion), an unused variable, an assignment used as a truth value |
| `renesas-uno-minima-default.txt` | `arduino:renesas_uno:minima` (the client's default board), default warnings | the same sketch: the two errors only |
| `avr-uno-missing-header.txt` | `arduino:avr:uno` | a missing header (`fatal error:`, `compilation terminated.`) |
| `avr-uno-undefined-reference.txt` | `arduino:avr:uno` | a link failure (`undefined reference to`, `collect2: error: ld returned 1 exit status`) |
