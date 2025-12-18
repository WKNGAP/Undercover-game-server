# Changelog

## v0.9.0.0a (latest)
- Added host “Resync” control to rebroadcast current game state (lobby, vote, blank-guess, game over) and resend words to players after reconnects.
- Improved player reconnect flow: stored player sessions resume automatically, rejoin always sends `your_word`, and state snapshots include totals/counts.
- Display win/lose outcome on player devices when the game ends.
- Host lobby now shows alive/total plus per-role counts (spies/blanks/civilians) consistently after resyncs.
- Cleared persisted rooms on server startup to avoid stale rooms carrying over between runs.
- Misc server robustness: `lastResult` tracking, role/word resend on resync/rejoin.
- Lobby end-of-game view now shows role plus word (e.g., 臥底:蛋糕). Player end-of-game view shows role plus win/lose (e.g., 臥底:勝利), while hiding the secret word.

## v0.5.0.0a (previous)
- Initial playable version: room creation, player join with optional avatar, role assignment, voting, blank-guess phase, and endgame flows.
- CSV question bank upload and random word pairing.
- Basic host/player UIs with Socket.IO real-time updates.
