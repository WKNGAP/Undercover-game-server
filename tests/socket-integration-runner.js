const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const RESULT_FILE = path.join(RESULTS_DIR, 'socket-integration-results.json');
const MAX_PLAYER_NAME_LENGTH = 20;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function once(socket, event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeoutMs);
        const handler = (payload) => {
            cleanup();
            resolve(payload);
        };
        const cleanup = () => {
            clearTimeout(timer);
            socket.off(event, handler);
        };
        socket.on(event, handler);
    });
}

async function waitFor(check, timeoutMs = 5000, intervalMs = 25) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
        try {
            const value = await check();
            if (value) return value;
        } catch (err) {
            lastError = err;
        }
        await wait(intervalMs);
    }
    throw lastError || new Error('Timed out waiting for condition');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function startServer(port) {
    const proc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const logs = [];
    proc.stdout.on('data', chunk => logs.push(chunk.toString()));
    proc.stderr.on('data', chunk => logs.push(chunk.toString()));

    await waitFor(async () => {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/question-types`);
            return res.ok;
        } catch {
            return false;
        }
    }, 8000);

    return {
        url: `http://127.0.0.1:${port}`,
        logs,
        async stop() {
            if (proc.exitCode !== null) return;
            proc.kill();
            await new Promise(resolve => proc.once('exit', resolve));
        }
    };
}

async function createRoom(baseUrl, config = {}) {
    const res = await fetch(`${baseUrl}/api/create-room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            totalPlayers: 5,
            spyCount: 1,
            blankCount: 1,
            type: 'all',
            ...config
        })
    });
    assert(res.ok, `create-room failed with ${res.status}`);
    return res.json();
}

async function connectSocket(baseUrl) {
    const socket = io(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true
    });
    await once(socket, 'connect');
    return socket;
}

async function subscribeHost(baseUrl, roomId) {
    const host = await connectSocket(baseUrl);
    host.emit('host_subscribe', { roomId });
    await once(host, 'update_lobby');
    return host;
}

async function joinPlayer(baseUrl, roomId, name, existing = {}) {
    const socket = await connectSocket(baseUrl);
    const joinedPromise = once(socket, 'joined');
    socket.emit('join_game', {
        roomId,
        name,
        playerId: existing.playerId,
        existingImage: existing.image
    });
    const joined = await joinedPromise;
    return { socket, ...joined };
}

async function tryJoinPlayer(baseUrl, roomId, name) {
    const socket = await connectSocket(baseUrl);
    const joined = once(socket, 'joined', 1000).then(payload => ({ status: 'joined', payload })).catch(() => null);
    const error = once(socket, 'error', 1000).then(payload => ({ status: 'error', payload })).catch(() => null);
    socket.emit('join_game', { roomId, name });
    const result = await Promise.race([joined, error]);
    return { socket, result };
}

async function setupActiveGame(baseUrl, config = {}) {
    const room = await createRoom(baseUrl, config);
    const host = await subscribeHost(baseUrl, room.roomId);
    let hostLobby = null;
    host.on('update_lobby', payload => {
        hostLobby = payload;
    });
    const players = [];
    const gameStarted = [];
    for (let i = 0; i < (config.totalPlayers || 5); i += 1) {
        const player = await joinPlayer(baseUrl, room.roomId, `Player ${i + 1}`);
        player.socket.on('game_started', payload => gameStarted.push(payload));
        players.push(player);
    }
    await wait(200);
    assert(!gameStarted.length, 'game should not auto-start when lobby reaches capacity');
    host.emit('start_game', { roomId: room.roomId });
    const payload = await waitFor(() => gameStarted[0], 5000);
    await waitFor(() => gameStarted.length >= players.length, 5000);
    await waitFor(() => hostLobby && hostLobby.state === 'GAMING', 5000);
    return { roomId: room.roomId, host, players, gameStarted: payload, hostLobby };
}

function disconnect(socket) {
    socket.disconnect();
}

function closeAll(sockets) {
    sockets.filter(Boolean).forEach(socket => {
        if (socket.connected) socket.disconnect();
    });
}

async function reconnectPlayer(baseUrl, roomId, player) {
    const socket = await connectSocket(baseUrl);
    const joinedPromise = once(socket, 'joined');
    socket.emit('join_game', { roomId, name: player.name, playerId: player.playerId, existingImage: player.image });
    const joined = await joinedPromise;
    return { socket, ...joined };
}

async function runScenario(name, fn, index) {
    const port = 4100 + index;
    const startedAt = new Date().toISOString();
    const server = await startServer(port);
    const sockets = [];
    try {
        const context = {
            baseUrl: server.url,
            track(socket) {
                sockets.push(socket);
                return socket;
            }
        };
        const detail = await fn(context);
        return { name, status: 'passed', startedAt, detail };
    } catch (err) {
        return { name, status: 'failed', startedAt, error: err.stack || err.message, logs: server.logs.slice(-20) };
    } finally {
        closeAll(sockets);
        await server.stop();
    }
}

const scenarios = [
    {
        name: 'lobby waits for manual host start and then starts valid game',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, gameStarted } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            assert(gameStarted.players.length === 5, 'game_started should include five audience players');
            assert(gameStarted.counts.spies === 1, 'game should have one spy');
            assert(gameStarted.counts.blanks === 1, 'game should have one blank');
            assert(gameStarted.counts.civilians === 3, 'game should have three civilians');
            return { roomId, state: 'GAMING' };
        }
    },
    {
        name: 'player names are capped at twenty characters',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 1, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const longName = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const player = await joinPlayer(baseUrl, room.roomId, longName);
            track(player.socket);
            assert(player.name.length === MAX_PLAYER_NAME_LENGTH, `expected name length ${MAX_PLAYER_NAME_LENGTH}, got ${player.name.length}`);
            assert(player.name === longName.slice(0, MAX_PLAYER_NAME_LENGTH), 'server should store truncated name');
            return { roomId: room.roomId, name: player.name };
        }
    },
    {
        name: 'start fails with fewer than three players',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 1, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const players = [
                await joinPlayer(baseUrl, room.roomId, 'Player 1'),
                await joinPlayer(baseUrl, room.roomId, 'Player 2')
            ];
            players.forEach(p => track(p.socket));
            const errorPromise = once(host, 'host_error');
            host.emit('start_game', { roomId: room.roomId });
            const error = await errorPromise;
            assert(error.code === 'not_enough_players', `expected not_enough_players, got ${error.code}`);
            return { roomId: room.roomId, code: error.code };
        }
    },
    {
        name: 'start fails when spy count is zero',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 0, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const players = [];
            for (let i = 0; i < 3; i += 1) players.push(await joinPlayer(baseUrl, room.roomId, `Player ${i + 1}`));
            players.forEach(p => track(p.socket));
            const errorPromise = once(host, 'host_error');
            host.emit('start_game', { roomId: room.roomId });
            const error = await errorPromise;
            assert(error.code === 'invalid_spy_count', `expected invalid_spy_count, got ${error.code}`);
            return { roomId: room.roomId, code: error.code };
        }
    },
    {
        name: 'start fails when spies and blanks leave no civilian',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 2, blankCount: 1 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const players = [];
            for (let i = 0; i < 3; i += 1) players.push(await joinPlayer(baseUrl, room.roomId, `Player ${i + 1}`));
            players.forEach(p => track(p.socket));
            const errorPromise = once(host, 'host_error');
            host.emit('start_game', { roomId: room.roomId });
            const error = await errorPromise;
            assert(error.code === 'invalid_role_total', `expected invalid_role_total, got ${error.code}`);
            return { roomId: room.roomId, code: error.code };
        }
    },
    {
        name: 'start fails when role counts already meet spy win condition',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 2, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const players = [];
            for (let i = 0; i < 4; i += 1) players.push(await joinPlayer(baseUrl, room.roomId, `Player ${i + 1}`));
            players.forEach(p => track(p.socket));
            const errorPromise = once(host, 'host_error');
            host.emit('start_game', { roomId: room.roomId });
            const error = await errorPromise;
            assert(error.code === 'start_condition_met', `expected start_condition_met, got ${error.code}`);
            return { roomId: room.roomId, code: error.code };
        }
    },
    {
        name: 'optional max cap rejects extra lobby joins',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: 3, spyCount: 1, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const players = [];
            for (let i = 0; i < 3; i += 1) players.push(await joinPlayer(baseUrl, room.roomId, `Player ${i + 1}`));
            players.forEach(p => track(p.socket));
            const extra = await tryJoinPlayer(baseUrl, room.roomId, 'Extra Player');
            track(extra.socket);
            assert(extra.result?.status === 'error', 'extra player should receive room full error');
            assert(extra.result.payload === 'Room is full', `unexpected cap error: ${extra.result.payload}`);
            return { roomId: room.roomId };
        }
    },
    {
        name: 'same-player restart returns to lobby without auto-start',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const updates = [];
            const handler = payload => updates.push(payload);
            host.on('update_lobby', handler);
            const gameStartedAgain = once(players[0].socket, 'game_started', 700).then(() => true).catch(() => false);
            host.emit('restart_game', { roomId, keepPlayers: true });
            const lobby = await waitFor(() => updates.find(payload => payload.state === 'LOBBY'), 5000);
            host.off('update_lobby', handler);
            const restarted = await gameStartedAgain;
            assert(lobby.players.every(p => !p.role && !p.word && !p.isOut), 'same-player restart should clear roles, words, and out state');
            assert(!restarted, 'same-player restart should not auto-start');
            return { roomId, state: lobby.state };
        }
    },
    {
        name: 'host kicks lobby player and old playerId rejoins as a new player',
        fn: async ({ baseUrl, track }) => {
            const room = await createRoom(baseUrl, { totalPlayers: undefined, spyCount: 1, blankCount: 0 });
            const host = await subscribeHost(baseUrl, room.roomId);
            track(host);
            const player = await joinPlayer(baseUrl, room.roomId, 'Lobby Player');
            track(player.socket);
            const kickedPromise = once(player.socket, 'kicked');
            host.emit('host_kick_player', { roomId: room.roomId, playerId: player.playerId });
            await kickedPromise;
            const rejoined = await joinPlayer(baseUrl, room.roomId, 'Lobby Player', { playerId: player.playerId });
            track(rejoined.socket);
            assert(rejoined.playerId !== player.playerId, 'kicked lobby player should receive a new playerId when rejoining');
            return { roomId: room.roomId, oldId: player.playerId, newId: rejoined.playerId };
        }
    },
    {
        name: 'host kicks in-game spy and triggers civilian win',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 3, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const spy = hostLobby.players.find(p => p.role === 'Spy');
            const spyPlayer = players.find(p => p.playerId === spy.id);
            const kickedPromise = once(spyPlayer.socket, 'kicked');
            const outPromise = once(spyPlayer.socket, 'you_out');
            const gameOverPromise = once(host, 'game_over');
            host.emit('host_kick_player', { roomId, playerId: spy.id });
            await kickedPromise;
            await outPromise;
            const gameOver = await gameOverPromise;
            assert(gameOver.result === 'civil_win', `expected civil_win, got ${gameOver.result}`);
            assert(gameOver.finalRoles.every(p => Object.prototype.hasOwnProperty.call(p, 'word')), 'finalRoles should include each player word');
            return { roomId, kicked: spy.id };
        }
    },
    {
        name: 'host kicks in-game civilian and endgame check runs',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 3, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const civilian = hostLobby.players.find(p => p.role === 'Civilian');
            const civilianPlayer = players.find(p => p.playerId === civilian.id);
            const kickedPromise = once(civilianPlayer.socket, 'kicked');
            const outPromise = once(civilianPlayer.socket, 'you_out');
            const gameOverPromise = once(host, 'game_over');
            host.emit('host_kick_player', { roomId, playerId: civilian.id });
            await kickedPromise;
            await outPromise;
            const gameOver = await gameOverPromise;
            assert(gameOver.result === 'spy_win', `expected spy_win, got ${gameOver.result}`);
            return { roomId, kicked: civilian.id };
        }
    },
    {
        name: 'host kicks in-game blank and triggers blank guess',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 5, spyCount: 1, blankCount: 1 });
            track(host);
            players.forEach(p => track(p.socket));
            const blank = hostLobby.players.find(p => p.role === 'Blank');
            const blankPlayer = players.find(p => p.playerId === blank.id);
            const kickedPromise = once(blankPlayer.socket, 'kicked');
            const promptPromise = once(blankPlayer.socket, 'blank_guess_prompt');
            host.emit('host_kick_player', { roomId, playerId: blank.id });
            await kickedPromise;
            await promptPromise;
            return { roomId, kicked: blank.id };
        }
    },
    {
        name: 'early vote completes when leader cannot be caught',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 5, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const target = hostLobby.players.find(p => p.role === 'Civilian');
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const completePromise = once(host, 'voting_complete');
            players.slice(0, 3).forEach(voter => {
                voter.socket.emit('cast_vote', { roomId, voterId: voter.playerId, targetId: target.id });
            });
            const complete = await completePromise;
            assert(complete.status === 'locked_out', `expected locked_out, got ${complete.status}`);
            assert(complete.player.id === target.id, 'locked vote should eliminate target');
            return { roomId, target: target.id };
        }
    },
    {
        name: 'early vote waits while remaining votes can change winner',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 5, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const target = hostLobby.players.find(p => p.role === 'Civilian');
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const earlyComplete = once(host, 'voting_complete', 700).then(() => true).catch(() => false);
            players.slice(0, 2).forEach(voter => {
                voter.socket.emit('cast_vote', { roomId, voterId: voter.playerId, targetId: target.id });
            });
            const completed = await earlyComplete;
            assert(!completed, 'vote should not complete while remaining votes can change winner');
            return { roomId, target: target.id };
        }
    },
    {
        name: 'all-voted tie still returns to gaming',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 4, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const targets = hostLobby.players.filter(p => p.id !== players[0].playerId).slice(0, 2);
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const completePromise = once(host, 'voting_complete');
            players[0].socket.emit('cast_vote', { roomId, voterId: players[0].playerId, targetId: targets[0].id });
            players[1].socket.emit('cast_vote', { roomId, voterId: players[1].playerId, targetId: targets[0].id });
            players[2].socket.emit('cast_vote', { roomId, voterId: players[2].playerId, targetId: targets[1].id });
            players[3].socket.emit('cast_vote', { roomId, voterId: players[3].playerId, targetId: targets[1].id });
            const complete = await completePromise;
            assert(complete.status === 'tie', `expected tie, got ${complete.status}`);
            return { roomId };
        }
    },
    {
        name: 'invalid vote target is ignored',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 5, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const target = hostLobby.players.find(p => p.id !== players[0].playerId);
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const updates = [];
            host.on('vote_update', payload => updates.push(payload));
            players[0].socket.emit('cast_vote', { roomId, voterId: players[0].playerId, targetId: 'missing-player' });
            await wait(250);
            assert(updates.length === 0, 'invalid target should not emit vote_update');
            players[0].socket.emit('cast_vote', { roomId, voterId: players[0].playerId, targetId: target.id });
            await waitFor(() => updates.length === 1, 1000);
            assert(updates[0].votes.counts[target.id] === 1, 'valid vote after invalid target should count once');
            return { roomId };
        }
    },
    {
        name: 'duplicate voter is ignored',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl, { totalPlayers: 5, spyCount: 1, blankCount: 0 });
            track(host);
            players.forEach(p => track(p.socket));
            const targets = hostLobby.players.filter(p => p.id !== players[0].playerId).slice(0, 2);
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const updates = [];
            host.on('vote_update', payload => updates.push(payload));
            players[0].socket.emit('cast_vote', { roomId, voterId: players[0].playerId, targetId: targets[0].id });
            await waitFor(() => updates.length === 1, 1000);
            players[0].socket.emit('cast_vote', { roomId, voterId: players[0].playerId, targetId: targets[1].id });
            await wait(250);
            assert(updates.length === 1, 'duplicate vote should not emit another vote_update');
            assert(updates[0].votes.counts[targets[0].id] === 1, 'first vote should remain counted');
            assert(!updates[0].votes.counts[targets[1].id], 'duplicate target should not be counted');
            return { roomId };
        }
    },
    {
        name: 'player reconnect during GAMING receives current game snapshot',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const original = players[0];
            disconnect(original.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const joinedPromise = once(socket, 'joined');
            const wordPromise = once(socket, 'your_word');
            const gamePromise = once(socket, 'game_started');
            socket.emit('join_game', { roomId, name: original.name, playerId: original.playerId, existingImage: original.image });
            const joined = await joinedPromise;
            const word = await wordPromise;
            const game = await gamePromise;
            assert(joined.playerId === original.playerId, 'reconnect should preserve player identity');
            assert(typeof word.word === 'string', 'reconnect should resend player word');
            assert(game.players.length === 5, 'reconnect should resend GAMING snapshot');
            return { roomId, rejoinedPlayerId: joined.playerId };
        }
    },
    {
        name: 'player reconnect during VOTING receives vote state',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const original = players[1];
            disconnect(original.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const joinedPromise = once(socket, 'joined');
            const votePromise = once(socket, 'vote_begin');
            socket.emit('join_game', { roomId, name: original.name, playerId: original.playerId, existingImage: original.image });
            await joinedPromise;
            const vote = await votePromise;
            assert(vote.players.length === 5, 'reconnect during VOTING should send alive players');
            assert(vote.votes && Array.isArray(vote.votes.voters), 'reconnect during VOTING should send vote progress');
            return { roomId, alivePlayers: vote.players.length };
        }
    },
    {
        name: 'blank player reconnect during BLANK_GUESS receives prompt',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const roles = hostLobby.players;
            const blank = roles.find(p => p.role === 'Blank');
            assert(blank, 'scenario requires a blank player');
            const blankPlayer = players.find(p => p.playerId === blank.id);
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            const prompts = [];
            blankPlayer.socket.on('blank_guess_prompt', () => prompts.push(true));
            for (const voter of players) {
                voter.socket.emit('cast_vote', { roomId, voterId: voter.playerId, targetId: blank.id });
            }
            await waitFor(() => prompts.length > 0, 5000);
            disconnect(blankPlayer.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const joinedPromise = once(socket, 'joined');
            const promptPromise = once(socket, 'blank_guess_prompt');
            socket.emit('join_game', { roomId, name: blankPlayer.name, playerId: blankPlayer.playerId, existingImage: blankPlayer.image });
            await joinedPromise;
            await promptPromise;
            return { roomId, blankPlayerId: blank.id };
        }
    },
    {
        name: 'player reconnect during FINISHED receives game_over',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, hostLobby } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const roles = hostLobby.players;
            const blank = roles.find(p => p.role === 'Blank');
            const blankPlayer = players.find(p => p.playerId === blank.id);
            const voteBegins = players.map(p => once(p.socket, 'vote_begin'));
            host.emit('start_vote', { roomId });
            await Promise.all(voteBegins);
            for (const voter of players) {
                voter.socket.emit('cast_vote', { roomId, voterId: voter.playerId, targetId: blank.id });
            }
            await once(blankPlayer.socket, 'blank_guess_prompt');
            const gameOverPromise = once(blankPlayer.socket, 'game_over');
            blankPlayer.socket.emit('blank_guess_submit', { roomId, playerId: blank.id, guess: roles.find(p => p.role === 'Civilian').word });
            await gameOverPromise;
            const original = players[2];
            disconnect(original.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const joinedPromise = once(socket, 'joined');
            const finishedPromise = once(socket, 'game_over');
            socket.emit('join_game', { roomId, name: original.name, playerId: original.playerId, existingImage: original.image });
            await joinedPromise;
            const gameOver = await finishedPromise;
            assert(gameOver.finalRoles.length === 5, 'reconnect during FINISHED should include final roles');
            return { roomId, result: gameOver.result };
        }
    },
    {
        name: 'host disconnect during active session does not destroy player reconnect path',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            disconnect(host);
            await wait(150);
            const original = players[0];
            disconnect(original.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const roomNotFound = once(socket, 'room_not_found', 1000).then(() => true).catch(() => false);
            socket.emit('join_game', { roomId, name: original.name, playerId: original.playerId, existingImage: original.image });
            const missing = await roomNotFound;
            assert(!missing, 'room should remain available after host disconnect while players are still in-session');
            return { roomId };
        }
    },
    {
        name: 'game_started payload sent to players does not expose all roles and words',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players, gameStarted } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const leakedRoles = Array.isArray(gameStarted.roles) && gameStarted.roles.some(p => p.role || p.word);
            assert(!leakedRoles, 'player-visible game_started payload should not contain every role and word');
            return { roomId };
        }
    },
    {
        name: 'reconnect game_started payload does not expose all roles and words',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const original = players[0];
            disconnect(original.socket);
            const socket = await connectSocket(baseUrl);
            track(socket);
            const joinedPromise = once(socket, 'joined');
            const gamePromise = once(socket, 'game_started');
            socket.emit('join_game', { roomId, name: original.name, playerId: original.playerId, existingImage: original.image });
            await joinedPromise;
            const gameStarted = await gamePromise;
            const leakedRoles = Array.isArray(gameStarted.roles) && gameStarted.roles.some(p => p.role || p.word);
            assert(!leakedRoles, 'reconnect game_started payload should not contain every role and word');
            return { roomId };
        }
    },
    {
        name: 'host resync game_started payload does not expose all roles and words',
        fn: async ({ baseUrl, track }) => {
            const { roomId, host, players } = await setupActiveGame(baseUrl);
            track(host);
            players.forEach(p => track(p.socket));
            const gamePromise = once(players[0].socket, 'game_started');
            host.emit('host_resync', { roomId });
            const gameStarted = await gamePromise;
            const leakedRoles = Array.isArray(gameStarted.roles) && gameStarted.roles.some(p => p.role || p.word);
            assert(!leakedRoles, 'host_resync game_started payload should not contain every role and word');
            return { roomId };
        }
    }
];

async function main() {
    await fs.mkdir(RESULTS_DIR, { recursive: true });
    const results = [];
    for (let i = 0; i < scenarios.length; i += 1) {
        const scenario = scenarios[i];
        process.stdout.write(`Running: ${scenario.name}\n`);
        const result = await runScenario(scenario.name, scenario.fn, i);
        results.push(result);
        process.stdout.write(`${result.status.toUpperCase()}: ${scenario.name}\n`);
        if (result.error) process.stdout.write(`${result.error.split('\n')[0]}\n`);
    }
    const summary = {
        generatedAt: new Date().toISOString(),
        total: results.length,
        passed: results.filter(r => r.status === 'passed').length,
        failed: results.filter(r => r.status === 'failed').length,
        results
    };
    await fs.writeFile(RESULT_FILE, JSON.stringify(summary, null, 2), 'utf8');
    process.stdout.write(`Results written to ${RESULT_FILE}\n`);
    if (summary.failed) process.exitCode = 1;
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
