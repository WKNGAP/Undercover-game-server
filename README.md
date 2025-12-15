# Undercover Party Game Server

Real-time web implementation of the *Undercover* / *谁是卧底* social deduction party game. Hosts create a room, invite players via QR code, and run each round completely inside a browser. The server handles word assignment, voting flow, blank-player (“白板”) guessing, reconnections, and localization support.

## Features

- **Express + Socket.IO backend** with persistent room snapshots so hosts can refresh without losing state.
- **Dynamic question banks** under `data/QuestionLib` (CSV upload or manual drop-in). Each room avoids reusing words until its bank is exhausted.
- **Host dashboard** (`/`) for room creation, QR display, live lobby view, vote control, and end-game management.
- **Player web app** (`/join/:roomId`) with camera upload, localized UI strings, blank-guess prompts, and resume logic via cookies/localStorage.
- **Automatic image handling** (compressed on client, resized on server with `sharp`, and stored under `data/Sections`).
- **Blank-guess flow** to enforce “白板努力中”: eligible blanks get a private prompt while every screen shows the status banner; game resumes or ends automatically after the guesses resolve.
- **Identity reveal** once a match ends so both lobby and players see who was Spy/Blank/Civilian.

## Project Structure

```
main/
├── data/
│   ├── QuestionLib/   # CSV banks (first row is question type)
│   └── Sections/      # Room folders storing player images + room dumps
├── public/
│   ├── index.html     # Host lobby
│   └── player.html    # Player client
├── logic.js           # Role assignment helpers
├── server.js          # Express + Socket.IO server
├── start-server.bat   # Windows helper for pinned Node version
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

Question banks live in `data/QuestionLib`. On startup the server creates required folders, but you can also upload CSVs through the host UI. Each row after the header should be `wordA,wordB`. Rooms track `usedQuestionIds` so new rounds avoid repeating words until necessary.

Images and persistent room dumps land in `data/Sections/<ROOMID>`. To keep deployments stateless, mount this directory to durable storage (see Docker notes).

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
2. `npm ci --production`
3. Copy `data/` (or mount network storage) and ensure `QuestionLib` contains at least one CSV.
4. Run `PORT=8080 node server.js` behind a reverse proxy (NGINX/Caddy) with TLS.
5. Configure process supervision (PM2, systemd, etc.) for resilience.


## Start-Server Helper

On Windows, double-click `start-server.bat`. It pins the Node binary under `%LOCALAPPDATA%\nvm\v20.18.1` and launches `server.js` from the repo directory.

## Contributing / Next Steps

- Expand the i18n dictionaries (`public/i18n.json`) for additional languages.
- Add automated tests around the blank-guess state machine.
- Integrate persistent storage (SQLite/Postgres) if you need cross-process scaling.
- Wire up CI/CD to build and push Docker images on merge.

Enjoy hosting *Undercover*!
