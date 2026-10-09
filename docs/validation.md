# Multiplayer correctness review and fixes

Review started from commit `5accfd6`. The initial review reproduced fifteen defects despite the existing 39 tests passing. The repair pass also found departed-trail color loss, accumulating dead Hydra clones, failed recovery after an active seat expired, stale power-rule rejection handling, and special player identifiers breaking forced rules. All twenty reproduced defects now have fixes and regression coverage.

## Corrected behavior

| Area | Failure corrected | Regression coverage |
| --- | --- | --- |
| Ready screen | Touch hosts could not begin countdown, including projector mode | Actual App callbacks and browser countdown |
| Hydra | Slow siblings collided before separating | All three speed settings |
| Snapshot delivery | Healthy late spectators closed while a large initial snapshot compressed | Real compressed WebSockets; snapshot send deadline |
| Fast collisions | Boosted heads passed through each other between ticks | Swept head collision, immunity, teleport discontinuities |
| Duplicate tabs | Replaced tabs repeatedly evicted each other | Explicit replacement close stops retry; manual reconnect remains available |
| Reconnect validation | Invalid replacement roster evicted a working socket | Rejected replacement leaves the original connection and roster intact |
| Spectator transition | Previous seats became uncontrolled connected players | Lobby and active-round transitions |
| Expired rules | Removed seats left invalid forced-power entries | Grace expiry cleans both rule and selected-power maps |
| Rapid power edits | A later request lost an earlier pending selection | Intermediate replies and rejected-rule rollback |
| Player colors | Adding an earlier slot duplicated a retained player's color | Reserve retained colors before insertion |
| Roster rejection | Rejected local selections remained enabled and persisted | Correlated replies, overlapping requests, authoritative rollback |
| Deathmatch | No eligible finalist left the match stuck | Finishes as a draw; one remaining finalist wins |
| Slow readers | Lobby broadcasts bypassed output bounds | All outbound paths share a one-megabyte incremental budget |
| Multi-touch | Releasing one finger released another held finger | Independent pointer identity, cancellation, capture loss, projector cleanup |
| Saved controls | Invalid key data crashed rendering | Malformed values, duplicate keys/IDs, unsupported powers, recovery |
| Trail rendering | Removed-player trails changed color on resize or late join | Retained current-round colors, snapshot metadata, round reset |
| Hydra history | Dead clones accumulated beyond the living-head limit | Legitimately earned charges and repeated 50-player Hydra activation |
| Expired-seat reconnect | A rejected autojoin displayed a stale connected game | Recoverable room selection after seat expiry |
| Older rule rejection | An earlier rejected request discarded a newer pending preset | Correlated rule replies retain newer drafts and roll back the final rejection |
| Special player IDs | Supported IDs such as `__proto__` lost or inherited forced rules | Own-property lookup and safe dictionary assignment |

Hydra segments are also merged per head instead of per owner. Internal head identifiers are omitted from the wire format. Snapshots include pending trails without consuming the next live update.

## Validation

The complete integrated suite passes **79/79 tests**, with no failures or skipped tests. TypeScript, the production build, the configured-backend build, and whitespace checks pass. The installed dependency audit reports zero vulnerabilities; no dependencies were changed. The standard commands are:

```sh
npm test
npm run build
```

The permanent suite exercises the actual App callbacks and Canvas drawing code with controlled browser hooks, the authoritative simulation, and real local HTTP/WebSocket connections. These checks complement browser interactions; they do not emulate physical keyboard rollover or a mobile operating system.

The review's local diagnostic scripts and raw results remain in the ignored `.audit/` folder. They include seeded 50-player games, a 256-head simulation, compressed late joins, a paused TCP receiver, and a 30-second real-time run with 50 separate player connections plus a spectator.

| Final check | Observed result |
| --- | --- |
| Real-time local multiplayer | 50 players plus one spectator, 30 seconds, all 51 sockets open, zero errors, 656 frames per client |
| Simulation rate in that run | 59.46 ticks/second; event-loop p99 24.69 ms; process RSS 218.8 MB |
| Seeded speed/gap matrix | 9 matches, 27 rounds, 33,590 ticks, 1,332 power activations; all three speeds and three named gap sizes |
| Maximum living Hydra heads | 256 heads, 600 ticks; mean 0.374 ms/tick, p95 0.821 ms, maximum 3.573 ms |
| Trail coalescing | 51,200 segments / 3.99 MB raw JSON in the maximum-head sample; previous sample had 139,556 / 10.87 MB |
| Repeated Hydra with earned charges | 287 activations in a 50-player round; retained heads reduced from 832 to 63 in the same reproduction |
| Large late joins | Five compressed spectators remain open; approximately 87–91 ms initial snapshot delivery locally |
| Real paused TCP receiver | Incremental output bounded; connection closes near 1 MB instead of staying open above 7 MB |
| Browser controls | Host countdown, Hydra, Shoot Holes, Dark Knight blackout, pause, and alternate-origin spectator verified |

These are local observations from 9 October 2026. Server and simulated clients share one computer; decoded JSON size is not compressed wire traffic. Timing and memory figures do not establish hosted capacity or browser drawing performance.

## Hosting boundary

The Vercel container now builds its frontend against the Render game server by default. `VITE_GAME_SERVER_URL` can select another HTTP(S) backend at build time; unset retains same-origin local/LAN play. Origin validation rejects credentials, paths, queries, fragments, and non-HTTP schemes. A local frontend on a separate origin is checked against the configured backend.

Keep the authoritative backend on one instance. Rooms are held in process memory; restarting that backend ends its games. Multiple authoritative backend instances require explicit room routing and shared state. The repository cannot verify or change the providers' dashboard configuration.

The original public URLs were checked before these repairs, including all fourteen power choices. Source changes and a local commit do not deploy those changes. No production load test, provider restart/scaling experiment, physical multi-touch/keyboard test, school-network test, or exhaustive browser/OS permutation was performed.

Deploy the updated backend and frontend together so the new correlated rule/roster responses and trail-color snapshot metadata are available to the updated client. The Vercel Docker build argument must actually be used by the deployment; a generic frontend build needs `VITE_GAME_SERVER_URL` set explicitly.

This is evidence-based confidence in the supported scenarios tested. Finite tests cannot establish that every possible input, timing, network, hardware, and provider event is bug-free.
