# Connectivity Test Plan

Target repo: `main-clone`, remote `https://github.com/WKNGAP/Undercover-game-server.git`.

## Scope

Exercise the real Express + Socket.IO server with multiple simulated clients. The focus is connection, disconnect, and reconnect behavior during a live game session and while changing game phase.

## Environment

- Start `server.js` as a child process on disposable localhost ports.
- Use `socket.io-client` to simulate one host and five players.
- Create rooms through `POST /api/create-room`.
- Drive game transitions through the same socket events used by the browser UI.
- Save results to `test-results/socket-integration-results.json`.

## Scenarios

1. Lobby fill and auto-start
   - Create a five-player room.
   - Connect host and five players.
   - Verify all players join and the game enters `GAMING` automatically.

2. Player reconnect during `GAMING`
   - Disconnect one player after game start.
   - Reconnect with the original `playerId`.
   - Verify identity, word, and current game snapshot are restored.

3. Player reconnect during `VOTING`
   - Start voting from the host.
   - Disconnect and reconnect a player.
   - Verify the player receives current vote state and alive-player list.

4. Player reconnect during `BLANK_GUESS`
   - Vote out the blank player to trigger blank-guess phase.
   - Disconnect and reconnect that blank player.
   - Verify the eligible blank receives `blank_guess_prompt`.

5. Player reconnect during `FINISHED`
   - Finish a game through a successful blank guess.
   - Disconnect and reconnect a player.
   - Verify the player receives `game_over` and final roles.

6. Host disconnect during active session
   - Disconnect the host while players remain connected in `GAMING`.
   - Attempt player reconnect.
   - Expected: room remains available for active players.

7. Player payload confidentiality
   - Inspect player-visible `game_started` payload.
   - Expected: players do not receive every player's role and word.

8. Reconnect payload confidentiality
   - Reconnect a player during `GAMING`.
   - Inspect the recovery `game_started` payload.
   - Expected: recovery payload does not include every player's role and word.

9. Host resync payload confidentiality
   - Trigger `host_resync` during `GAMING`.
   - Inspect the player-visible `game_started` payload emitted by resync.
   - Expected: resync payload does not include every player's role and word.

## Pass Criteria

All scenarios should pass. Failures are treated as candidate bugs and documented in `docs/CONNECTIVITY_TEST_REPORT.md`.
