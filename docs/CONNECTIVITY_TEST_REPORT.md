# Connectivity Test Report

Initial run date: 2026-05-21 Australia/Adelaide  
Final run date: 2026-05-21 Australia/Adelaide  
Target repo: `main-clone` (`WKNGAP/Undercover-game-server`, `origin/main`)  
Command: `npm run test:connectivity`  
Result file: `test-results/socket-integration-results.json`

## Summary

The initial run executed 7 scenarios against the real `server.js` process with simulated Socket.IO clients.

- Passed: 5
- Failed: 2

After fixes, the suite was expanded to 9 scenarios and all passed.

- Passed: 9
- Failed: 0

Passing coverage:

- Lobby multi-user join and auto-start.
- Player reconnect during `GAMING`.
- Player reconnect during `VOTING`.
- Blank player reconnect during `BLANK_GUESS`.
- Player reconnect during `FINISHED`.
- Host disconnect during active session.
- Player payload confidentiality for initial game start, reconnect recovery, and host resync.

## Bugs Found

### 1. Host disconnect deletes an active room while players are still connected

Severity: High

Reproduction:

1. Create a room with five players.
2. Connect a host with `host_subscribe`.
3. Join all players and let the game auto-start.
4. Disconnect the host socket.
5. Disconnect and reconnect one player with the same `playerId`.

Expected:

- Active room remains available while players are still in-session.
- Reconnecting player receives the current game snapshot.

Actual:

- Server removes the room immediately after the last host viewer disconnects.
- Player reconnect receives `room_not_found`.
- Test log shows `Room removed: 0C341B` immediately after game start and host disconnect.

Likely cause:

- `server.js` removes the room whenever the last host viewer disconnects, regardless of room phase or connected players.
- Relevant code: `server.js` `disconnect` handler calls `removeRoom(roomId)` when `HOST_VIEWS` becomes empty.

Impact:

- A host refresh, network drop, browser crash, or navigation can destroy an active game.
- Players cannot recover their session after the host disconnects.

Fix:

- `server.js` now only removes a room on last host disconnect when the room is empty.
- Active rooms with joined players remain available for player reconnect.

### 2. Player-visible `game_started` payload exposes every player's role and word

Severity: High

Reproduction:

1. Create a room and join all players.
2. Observe the `game_started` payload received by a player socket.

Expected:

- Player payload contains public player data and the receiving player's own word only.
- Full roles and words are only sent to host/admin views.

Actual:

- `game_started` is broadcast to the whole room with `roles: scrubPlayersForHost(room.players)`.
- That payload includes every player's `role` and `word`.

Likely cause:

- `server.js` broadcasts one combined host/player payload:
  - `players: scrubPlayersForAudience(room.players)`
  - `roles: scrubPlayersForHost(room.players)`
- Relevant code: `server.js` `startGame()` emits `game_started` to `io.to(roomId)`.

Impact:

- Any player client can inspect the socket payload and see all roles and words.
- This breaks the core hidden-role game mechanic.

Fix:

- `server.js` no longer includes `roles` in player-visible `game_started` payloads.
- The fix covers initial game start, host resync during `GAMING`, and player reconnect during `GAMING`.

## Final Verification

Final command:

```powershell
npm run test:connectivity
```

Final result:

- Total: 9
- Passed: 9
- Failed: 0
- Result file: `test-results/socket-integration-results.json`

## Notes

- The test harness intentionally uses the public socket/API surface instead of importing server internals.
- Installing `socket.io-client` also surfaced existing `npm audit` output: 9 vulnerabilities reported by npm. That was not part of the connectivity failure set and was not investigated in this run.
