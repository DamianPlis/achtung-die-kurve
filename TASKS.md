# Current update

- [x] Implement all original powers with shared server state and cross-device tests.
- [x] Support 50 players and size the arena by player count.
- [x] Remove movement pulses with immediate local prediction and smooth authoritative reconciliation.
- [x] Verify the build, tests, multiple browser clients, and projector rendering.
- [x] Repair all reproduced review defects and add permanent regressions for reconnects, rule edits, snapshots, rendering, and 50 independent player connections.

Hardware follow-up: check the updated movement on the MacBook and school Wi-Fi after local verification.

Verification: 79 tests pass; TypeScript and production build pass. Validation includes all fourteen power choices, 50 players plus a spectator, 256 living Hydra heads, large compressed snapshots, slow readers, and cross-origin shared-backend browser checks. Prediction tests cover synthetic 15 ms and 30 ms round-trip delay with jitter. See [the validation report](docs/validation.md) for evidence and limits.

