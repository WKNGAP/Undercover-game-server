# Undercover Party Game Server

Real-time web implementation of the *Undercover* / *谁是卧底* social deduction party game. Hosts create a lobby, invite players via QR code, tune roles before starting, and run each round completely inside a browser. The server handles word assignment, voting flow, host kicks, blank-player (“白板”) guessing, reconnections, and localization support.

Latest highlights (v0.10.0):
- React + Vite host/player UI rebuild with a denser host monitor and mobile-first player flow.
- Lobby-first game start: hosts show the QR code immediately, adjust spy/blank/max-player settings in lobby, then manually start the game.
- Host controls for kicking/removing players in lobby and in-game.
- Early vote completion when the vote leader is mathematically locked.
- Endgame host reveal with result banner, every player’s role and word, blank “No word” display, and highlighted winner cards.
- English and Chinese language setting backed by `public/i18n.json`.
- Connectivity and vote/endgame test coverage with 25 passing socket integration scenarios.

## Features

- **Express + Socket.IO backend** with persistent room snapshots so hosts can refresh without losing state.
- **React + Vite frontend** served from `dist/` in production, with `/` for host and `/join/:roomId` for players.
- **Dynamic question banks** under `data/QuestionLib` (CSV upload or manual drop-in). Each room avoids reusing words until its bank is exhausted.
- **Host dashboard** (`/`) for room creation, QR display, live lobby role settings, player kick controls, vote control, resync, language setting, and end-game management with revealed roles+words.
- **Player web app** (`/join/:roomId`) with camera upload, localized UI strings, blank-guess prompts, reconnect/resume logic, and clear win/lose display on game end.
- **Automatic image handling** (compressed on client, resized on server with `sharp`, and stored under `data/Sections`).
- **Blank-guess flow** to enforce “白板努力中”: eligible blanks get a private prompt while every screen shows the status banner; game resumes or ends automatically after the guesses resolve.
- **Early vote completion** when remaining voters cannot change the leading result.
- **Identity reveal** once a match ends so host sees every role/word and winner cards are highlighted.

## Project Structure

```
main/
├── data/
│   ├── QuestionLib/   # CSV banks (first row is question type)
│   └── Sections/      # Room folders storing player images + room dumps
├── dist/              # Built React frontend served by the Node server
├── docs/              # Connectivity and vote/endgame test docs
├── public/
│   ├── i18n.json      # UI language dictionary
│   └── test-console.html
├── src/               # React/Vite frontend source
├── tests/             # Socket integration and test console smoke tests
├── logic.js           # Role assignment helpers
├── server.js          # Express + Socket.IO server
├── start-server.bat   # Windows helper for pinned Node version
├── start-tester.bat   # Windows helper for the browser test console
└── package.json
```

## Prerequisites

- Node.js 20+ (the repo includes `start-server.bat` pointing at NVM’s Node 20.18.1)
- npm 9+
- (Optional) Python 3 / build tools only if you plan to install native deps manually on Linux

## Local Development

```bash
npm install            # install dependencies
npm run dev            # nodemon auto-restart
# or
npm start              # production-style node server.js
```

The server listens on `PORT` (defaults to `3000`). Visit `http://localhost:3000/` for the host dashboard; players join via the provided QR/link (`/join/<ROOMID>`).

For frontend development, run the Vite UI separately:

```bash
npm run web:dev
```

For a production frontend build:

```bash
npm run build:web
```

Question banks live in `data/QuestionLib`. On startup the server creates required folders, but you can also upload CSVs through the host UI. Each row after the header should be `wordA,wordB`. Rooms track `usedQuestionIds` so new rounds avoid repeating words until necessary.

Images and persistent room dumps land in `data/Sections/<ROOMID>`. On startup, old room folders are cleared to prevent stale lobbies. To keep deployments stateless but durable, mount this directory to persistent storage (see Docker notes).

## Docker Support

The included `Dockerfile` builds a production image with Node 20 on Debian slim:

```bash
# Build
docker build -t undercover-game .

# Run (map port + mount data for persistence)
docker run --name undercover \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  undercover-game
```

Environment variables (e.g., `PORT=8080`) can be passed with `-e PORT=8080`. Mounting `data/` ensures question banks, room logs, and uploaded images survive container restarts.

## Deploying without Docker

1. Install Node.js 20 on the server.
2. `npm ci`
3. `npm run build:web`
4. Copy `data/` (or mount network storage) and ensure `QuestionLib` contains at least one CSV.
5. Run `PORT=8080 node server.js` behind a reverse proxy (NGINX/Caddy) with TLS.
6. Configure process supervision (PM2, systemd, etc.) for resilience.


## Start-Server Helper

On Windows, double-click `start-server.bat`. It pins the Node binary under `%LOCALAPPDATA%\nvm\v20.18.1` and launches `server.js` from the repo directory.

## Testing

```bash
node --check server.js
npm run build:web
npm run test:console
npm run test:connectivity
```

The connectivity runner covers lobby manual start, reconnects, role privacy, host kicks, early vote completion, blank guesses, endgame outcomes, and server-side name limits. The latest local run passed 25/25 scenarios.

## Contributing / Next Steps

- Expand the i18n dictionaries (`public/i18n.json`) for additional languages.
- Add automated tests around the blank-guess state machine.
- Integrate persistent storage (SQLite/Postgres) if you need cross-process scaling.
- Wire up CI/CD to build and push Docker images on merge.

Enjoy hosting *Undercover*!
