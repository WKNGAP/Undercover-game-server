# Changelog

## v0.10.0 (latest)
- Rebuilt the host and player web UI with React + Vite while keeping the existing Express/Socket.IO APIs stable.
- Changed room flow to lobby-first manual start: hosts can create a room, show the QR code immediately, adjust spy/blank/max-player settings, then start when ready.
- Added Docker Compose example deployment file and Traditional Chinese README.
- Added host language selection for English and Chinese using the shared i18n dictionary.
- Added host kick controls for lobby and in-game players, including clean kicked-player session reset.
- Added early vote completion when the current leader can no longer be caught by remaining votes.
- Improved host monitor gameplay layout for 1080p screens with larger player photos, compact controls, active players in the main section, and secondary out-player display.
- Added endgame result banner, full role/word reveal on host, clear blank no-word display, and winner card highlighting.
- Enforced 20-character player name limits on client and server.
- Added test tooling and docs for connectivity, vote/endgame behavior, and the test console; current socket integration suite covers 25 scenarios.
- Added production frontend build scripts: `npm run web:dev`, `npm run build:web`, `npm run test:console`, and `npm run test:connectivity`.

## v0.9.0.0a
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
