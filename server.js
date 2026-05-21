// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { assignRoles } = require('./logic');

const HOST_VIEWS = new Map(); // roomId -> Set(socketId)
const WAITING_PLAYERS = new Map(); // socketId -> player snapshot for next room
const MAX_PLAYER_NAME_LENGTH = 20;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_ROOT = path.join(__dirname, 'data');
const QUESTION_LIB_DIR = path.join(DATA_ROOT, 'QuestionLib');
const SECTIONS_DIR = path.join(DATA_ROOT, 'Sections');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(__dirname, 'dist');

// Ensure required folders exist
[DATA_ROOT, QUESTION_LIB_DIR, SECTIONS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function clearPersistedRooms() {
    try {
        const entries = fs.readdirSync(SECTIONS_DIR, { withFileTypes: true });
        entries.forEach((entry) => {
            fs.rmSync(path.join(SECTIONS_DIR, entry.name), { recursive: true, force: true });
        });
        console.log('Cleared persisted rooms at startup');
    } catch (e) {
        console.error('Failed to clear persisted rooms', e);
    }
}

clearPersistedRooms();

// Multer setup for CSV uploads (question banks)
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, QUESTION_LIB_DIR),
        filename: (req, file, cb) => {
            const base = path.parse(file.originalname).name || 'uploaded';
            cb(null, `${base}.csv`);
        }
    })
});

// Middleware
app.use('/sections', express.static(SECTIONS_DIR)); // serve saved images
app.get('/test-console.html', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'test-console.html'));
});
app.get('/i18n.json', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'i18n.json'));
});
app.use(express.static(DIST_DIR));
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// In-memory cache
const ROOMS = {};
let QUESTION_BANKS = {};
let ALL_QUESTIONS = [];

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// --- Question Bank Helpers ---
function loadQuestionBanks() {
    const files = fs.readdirSync(QUESTION_LIB_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
    const banks = {};
    files.forEach((file) => {
        const csvBuffer = fs.readFileSync(path.join(QUESTION_LIB_DIR, file));
        const records = parse(csvBuffer, { bom: true, relax_column_count: true, skip_empty_lines: true });
        if (!records.length) return;
        const [typeCell] = records.shift();
        const type = (typeCell || path.parse(file).name || 'default').trim();
        const entries = records
            .map(([wordA, wordB], idx) => ({
                id: `${type}-${idx}`,
                wordA: (wordA || '').trim(),
                wordB: (wordB || '').trim(),
                type
            }))
            .filter(q => q.wordA && q.wordB);
        if (entries.length) {
            banks[type] = entries;
        }
    });
    QUESTION_BANKS = banks;
    ALL_QUESTIONS = Object.values(banks).flat();
    console.log(`Loaded question banks: ${Object.keys(banks).join(', ') || 'none'}`);
}

function pickQuestion(selectedType, excludeIds = []) {
    const exclude = new Set(excludeIds || []);
    let pool = [];
    if (selectedType && QUESTION_BANKS[selectedType] && QUESTION_BANKS[selectedType].length) {
        pool = QUESTION_BANKS[selectedType];
    } else {
        pool = ALL_QUESTIONS;
    }
    if (!pool.length) throw new Error('No questions available');
    let available = pool.filter(q => !exclude.has(q.id));
    if (!available.length) {
        available = pool;
        console.log('All questions exhausted for selection; reusing from full pool.');
    }
    return available[Math.floor(Math.random() * available.length)];
}

function appShellFile(fallbackFile) {
    const distIndex = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(distIndex)) return distIndex;
    return path.join(PUBLIC_DIR, fallbackFile);
}

function parseOptionalPositiveInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : NaN;
}

function parseNonNegativeInt(value, fallback = 0) {
    if (value === undefined || value === null || value === '') return fallback;
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 ? num : NaN;
}

function emitHostError(socket, code, message) {
    if (socket) socket.emit('host_error', { code, message });
}

function sanitizePlayerName(name, fallback) {
    const trimmed = (name || '').trim();
    return (trimmed || fallback).substring(0, MAX_PLAYER_NAME_LENGTH);
}

function resetVotes(room) {
    room.votes = { counts: {}, voters: [] };
}

function sortedVoteEntries(votes) {
    return Object.entries(votes?.counts || {}).sort((a, b) => b[1] - a[1]);
}

function lockedVoteWinner(room) {
    const alivePlayers = room.players.filter(p => !p.isOut);
    const remainingVotes = Math.max(0, alivePlayers.length - (room.votes?.voters?.length || 0));
    const entries = sortedVoteEntries(room.votes);
    if (!entries.length) return null;
    const [topId, topVotes] = entries[0];
    const secondVotes = entries[1]?.[1] || 0;
    return topVotes > secondVotes + remainingVotes ? topId : null;
}

async function persistRoom(room) {
    const roomDir = path.join(SECTIONS_DIR, room.id);
    await fsp.mkdir(roomDir, { recursive: true });
    const filePath = path.join(roomDir, `${room.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(room, null, 2), 'utf8');
}

async function removeRoom(roomId) {
    delete ROOMS[roomId];
    HOST_VIEWS.delete(roomId);
    try {
        await fsp.rm(path.join(SECTIONS_DIR, roomId), { recursive: true, force: true });
    } catch (e) {
        console.error('Failed to remove room directory', e);
    }
    console.log(`Room removed: ${roomId}`);
}

async function attachWaitingPlayers(roomId, room) {
    const waiting = Array.from(WAITING_PLAYERS.values());
    if (!waiting.length) return;
    const maxPlayers = room.config.maxPlayers;
    const openSlots = maxPlayers ? Math.max(0, maxPlayers - room.players.length) : waiting.length;
    shuffle(waiting);
    const allowed = waiting.slice(0, openSlots);
    const kicked = waiting.slice(openSlots);
    allowed.forEach(w => {
        const sock = io.sockets.sockets.get(w.socketId);
        if (sock) {
            sock.emit('redirect_room', { roomId, name: w.name, image: w.image, playerId: w.playerId });
        }
        WAITING_PLAYERS.delete(w.socketId);
    });
    kicked.forEach(w => {
        const sock = io.sockets.sockets.get(w.socketId);
        if (sock) sock.emit('kicked_wait', { message: 'room full, please rejoin later' });
        WAITING_PLAYERS.delete(w.socketId);
    });
}

function scrubPlayersForHost(players) {
    return players.map(p => ({
        id: p.id,
        name: p.name,
        image: p.image,
        role: p.role,
        isOut: p.isOut && !p.pendingBlank,
        word: p.word,
        pendingBlank: !!p.pendingBlank
    }));
}

function lobbyPayload(room) {
    const counts = room.state !== 'LOBBY' ? remainingCounts(room) : null;
    const joined = room.players.filter(p => !p.isOut || p.pendingBlank).length;
    return {
        players: scrubPlayersForHost(room.players),
        joined,
        total: room.state === 'LOBBY' ? (room.config.maxPlayers || null) : (room.config.totalPlayers || room.players.length),
        maxPlayers: room.config.maxPlayers || null,
        config: {
            spyCount: room.config.spyCount,
            blankCount: room.config.blankCount,
            maxPlayers: room.config.maxPlayers || null,
            type: room.config.type
        },
        counts,
        votes: room.votes,
        state: room.state
    };
}

function scrubPlayersForAudience(players) {
    //console.log('scrubPlayersForAudience')
    //console.log(players);
    // Hide roles and words for non-owners
    return players.map(p => ({
        id: p.id,
        name: p.name,
        image: p.image,
        isOut: p.isOut && !p.pendingBlank,
        pendingBlank: !!p.pendingBlank
    }));
}

function remainingCounts(room) {
    const alive = room.players.filter(p => !p.isOut);
    return {
        spies: alive.filter(p => p.role === 'Spy').length,
        blanks: alive.filter(p => p.role === 'Blank').length,
        civilians: alive.filter(p => p.role === 'Civilian').length
    };
}

function checkEndGame(room) {
    const counts = remainingCounts(room);
    if (counts.spies === counts.civilians + counts.blanks && counts.spies > 0) {
        room.state = 'FINISHED';
        return { result: 'spy_win', spies: room.players.filter(p => p.role === 'Spy') };
    }
    if (counts.spies === 0 && counts.blanks === 0) {
        room.state = 'FINISHED';
        return { result: 'civil_win', civilians: room.players.filter(p => p.role === 'Civilian') };
    }
    if (counts.spies === 0 && counts.blanks > 0) {
        room.state = 'BLANK_GUESS';
        return { result: 'blank_guess', blanks: room.players.filter(p => p.role === 'Blank' && !p.isOut) };
    }
    room.state = 'GAMING';
    return { result: 'continue', counts };
}

async function startBlankGuess(room, options = {}) {
    const { onlyEliminated = false, extraEligibleIds = [] } = options;
    let eligibleIds;
    if (onlyEliminated && extraEligibleIds.length) {
        eligibleIds = Array.from(new Set(extraEligibleIds));
    } else {
        eligibleIds = Array.from(new Set([
            ...room.players.filter(p => p.role === 'Blank' && !p.isOut).map(p => p.id),
            ...extraEligibleIds
        ]));
    }
    if (!eligibleIds.length) return;
    room.state = 'BLANK_GUESS';
    room.lastResult = null;
    room.blankGuess = {
        eligible: eligibleIds,
        answers: {},
        target: room.currentWords?.civilWord || ''
    };
    await persistRoom(room);
    io.to(room.id).emit('blank_guess_start');
    room.players.forEach(p => {
        if (eligibleIds.includes(p.id)) {
            io.to(p.socketId).emit('blank_guess_prompt');
        } else {
            io.to(p.socketId).emit('blank_guess_wait');
        }
    });
    io.to(room.id).emit('update_lobby', lobbyPayload(room));
}

async function handleBlankGuessSubmit(roomId, playerId, guess) {
    const room = ROOMS[roomId];
    if (!room || room.state !== 'BLANK_GUESS') return; // only process if the room exists and is in blank-guess mode

    const player = room.players.find(p => p.id === playerId && p.role === 'Blank');
    if (!player || !room.blankGuess?.eligible?.includes(playerId)) return; // ignore submissions from non-eligible players

    room.blankGuess.answers[playerId] = (guess || '').trim();
    const allAnswered = Object.keys(room.blankGuess.answers).length >= room.blankGuess.eligible.length;
    if (!allAnswered) return; // wait until all eligible blanks have submitted

    const eligibleIds = room.blankGuess.eligible.slice();
    const target = room.blankGuess.target;
    const success = Object.values(room.blankGuess.answers).some(ans => ans === target); // exact match required
    room.blankGuess = null;
    if (success) {
        room.state = 'FINISHED';
        room.lastResult = 'blank_win';
        await persistRoom(room);
        const winners = room.players.filter(p => eligibleIds.includes(p.id));
        winners.forEach(p => p.pendingBlank = false);
        const finalRoles = scrubPlayersForHost(room.players);
        io.to(roomId).emit('game_over', {
            result: 'blank_win',
            players: winners,
            winnerProfiles: winners.map(p => scrubPlayersForHost([p])[0]),
            finalRoles
        });
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
    } else {
        room.state = 'GAMING';
        eligibleIds.forEach(id => {
            const blank = room.players.find(p => p.id === id);
            if (blank) {
                blank.pendingBlank = false;
                blank.isOut = true;
                if (blank.socketId) {
                    io.to(blank.socketId).emit('you_out', { reason: 'blank_guess_failed' });
                }
            }
        });
        await persistRoom(room);
        const result = checkEndGame(room);
        const finalRoles = scrubPlayersForHost(room.players);
        if (result.result === 'civil_win') {
            room.lastResult = 'civil_win';
            io.to(roomId).emit('game_over', { result: 'civil_win', players: room.players.filter(p => p.role === 'Civilian'), finalRoles });
        } else if (result.result === 'spy_win') {
            room.lastResult = 'spy_win';
            io.to(roomId).emit('game_over', { result: 'spy_win', players: room.players.filter(p => p.role === 'Spy'), finalRoles });
        } else {
            io.to(roomId).emit('blank_guess_end', { counts: remainingCounts(room), state: room.state });
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
        }
    }
}

async function processElimination(room, eliminated, reason, options = {}) {
    const { notifyPlayer = true, votingStatus = 'out', skipVotingComplete = false } = options;
    if (!room || !eliminated) return;

    const roomId = room.id;
    const wasBlank = eliminated.role === 'Blank';
    eliminated.isOut = true;
    eliminated.pendingBlank = wasBlank;
    if (notifyPlayer && eliminated.socketId) {
        io.to(eliminated.socketId).emit('you_out', { reason });
    }

    const eliminatedInfo = scrubPlayersForHost([eliminated])[0];

    if (wasBlank) {
        resetVotes(room);
        await persistRoom(room);
        if (!skipVotingComplete) {
            io.to(roomId).emit('voting_complete', {
                status: votingStatus,
                player: eliminatedInfo,
                result: { result: 'blank_guess' },
                counts: remainingCounts(room),
                votes: room.votes,
                players: scrubPlayersForHost(room.players)
            });
        }
        await startBlankGuess(room, { onlyEliminated: true, extraEligibleIds: [eliminated.id] });
        return;
    }

    const result = checkEndGame(room);
    resetVotes(room);
    await persistRoom(room);

    if (!skipVotingComplete) {
        io.to(roomId).emit('voting_complete', {
            status: votingStatus,
            player: eliminatedInfo,
            result: result.result === 'blank_guess' ? undefined : result,
            counts: remainingCounts(room),
            votes: room.votes,
            players: scrubPlayersForHost(room.players)
        });
    }

    const finalRoles = scrubPlayersForHost(room.players);
    if (result.result === 'civil_win') {
        room.lastResult = 'civil_win';
        await persistRoom(room);
        io.to(roomId).emit('game_over', { result: 'civil_win', players: room.players.filter(p => p.role === 'Civilian'), finalRoles });
    } else if (result.result === 'spy_win') {
        room.lastResult = 'spy_win';
        await persistRoom(room);
        io.to(roomId).emit('game_over', { result: 'spy_win', players: room.players.filter(p => p.role === 'Spy'), finalRoles });
    } else if (result.result === 'blank_guess') {
        await startBlankGuess(room);
    } else {
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
    }
}
async function startGame(roomId) {
    return startGameForSocket(roomId, null);
}

async function startGameForSocket(roomId, socket) {
    const room = ROOMS[roomId];
    if (!room) return emitHostError(socket, 'room_not_found', 'Room not found');
    if (room.state !== 'LOBBY') return emitHostError(socket, 'invalid_state', 'Game can only start from lobby');

    const joined = room.players.length;
    const spy = Number(room.config.spyCount);
    const blank = Number(room.config.blankCount);
    const civilians = joined - spy - blank;
    if (joined < 3) return emitHostError(socket, 'not_enough_players', 'At least 3 players are required');
    if (!Number.isInteger(spy) || spy < 1) return emitHostError(socket, 'invalid_spy_count', 'At least 1 spy is required');
    if (!Number.isInteger(blank) || blank < 0) return emitHostError(socket, 'invalid_blank_count', 'Invalid blank count');
    if (spy + blank >= joined || civilians < 1) return emitHostError(socket, 'invalid_role_total', 'Spies and blanks must leave at least 1 civilian');
    if (spy >= civilians + blank) return emitHostError(socket, 'start_condition_met', 'Role counts already meet an end-game condition');

    room.lastResult = null;
    room.config.totalPlayers = joined;
    room.usedQuestionIds = room.usedQuestionIds || [];
    room.questionHistory = room.questionHistory || [];
    const question = pickQuestion(room.config.type, room.usedQuestionIds);
    room.question = question;
    if (!room.usedQuestionIds.includes(question.id)) {
        room.usedQuestionIds.push(question.id);
    }
    room.questionHistory.push({
        id: question.id,
        type: question.type,
        wordA: question.wordA,
        wordB: question.wordB,
        usedAt: new Date().toISOString()
    });
    console.log(`Room ${roomId} question: [${question.id}] (${question.type}) ${question.wordA} / ${question.wordB}`);

    room.players = assignRoles(room.players, room.config.spyCount, room.config.blankCount);
    const flip = Math.random() > 0.5;
    const civilWord = flip ? room.question.wordA : room.question.wordB;
    const spyWord = flip ? room.question.wordB : room.question.wordA;
    room.currentWords = { civilWord, spyWord };

    room.players.forEach(p => {
        if (p.role === 'Civilian') p.word = civilWord;
        else if (p.role === 'Spy') p.word = spyWord;
        else p.word = '';
    });

    room.state = 'GAMING';
    await persistRoom(room);
    console.log(`Game started for room ${roomId}`);

    const counts = remainingCounts(room);
    io.to(roomId).emit('game_started', {
        players: scrubPlayersForAudience(room.players),
        counts,
        total: room.config.totalPlayers
    });

    room.players.forEach(p => {
        io.to(p.socketId).emit('your_word', { word: p.word || '' });
    });
    room.votes = { counts: {}, voters: [] };
    io.to(roomId).emit('update_lobby', lobbyPayload(room));
}

loadQuestionBanks();

// --- ROUTES ---
app.get('/api/question-types', (req, res) => {
    res.json({ types: Object.keys(QUESTION_BANKS), total: ALL_QUESTIONS.length });
});

app.post('/api/upload-question-bank', upload.single('file'), (req, res) => {
    loadQuestionBanks();
    res.json({ ok: true, types: Object.keys(QUESTION_BANKS) });
});

// 1. Create Room (Host)
app.post('/api/create-room', async (req, res) => {
    try {
        const { type, totalPlayers, maxPlayers, spyCount, blankCount } = req.body;
        const cap = parseOptionalPositiveInt(maxPlayers ?? totalPlayers);
        const spy = parseNonNegativeInt(spyCount, 1);
        const blank = parseNonNegativeInt(blankCount, 0);

        if (Number.isNaN(cap) || (cap !== null && cap < 3)) return res.status(400).json({ error: 'Invalid max player count' });
        if (Number.isNaN(spy)) return res.status(400).json({ error: 'Invalid spy count' });
        if (Number.isNaN(blank)) return res.status(400).json({ error: 'Invalid blank count' });

        const roomId = uuidv4().substring(0, 6).toUpperCase();
        ROOMS[roomId] = {
            id: roomId,
            config: { totalPlayers: null, maxPlayers: cap, spyCount: spy, blankCount: blank, type: type || 'all' },
            question: null,
            players: [],
            state: 'LOBBY', // LOBBY, GAMING, VOTING, FINISHED
            votes: { counts: {}, voters: [] },
            createdAt: new Date().toISOString(),
            usedQuestionIds: [],
            questionHistory: [],
            lastResult: null,
            kickedPlayerIds: []
        };

        const joinUrl = `${req.protocol}://${req.headers.host}/join/${roomId}`;
        const qrDataUrl = await QRCode.toDataURL(joinUrl);

        await persistRoom(ROOMS[roomId]);
        await attachWaitingPlayers(roomId, ROOMS[roomId]);

        console.log(`Room created: ${roomId} type=${type || 'all'} max=${cap || 'none'} spies=${spy} blanks=${blank}`);

        res.json({ roomId, url: joinUrl, qr: qrDataUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// 2. Join Room (Player landing)
app.get('/join/:roomId', (req, res) => {
    res.sendFile(appShellFile('player.html'));
});

// --- WEBSOCKETS ---

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Host subscribes to a room to receive updates
    socket.on('host_subscribe', ({ roomId }) => {
        const room = ROOMS[roomId];
        if (!room) return socket.emit('error', 'Room not found');
        socket.join(roomId);
        let viewers = HOST_VIEWS.get(roomId);
        if (!viewers) {
            viewers = new Set();
            HOST_VIEWS.set(roomId, viewers);
        }
        viewers.add(socket.id);
        socket.data.hostRoom = roomId;
        socket.emit('update_lobby', lobbyPayload(room));
        console.log(`Host viewing lobby for room ${roomId} (viewers=${viewers.size})`);
    });

    socket.on('update_lobby_config', async ({ roomId, spyCount, blankCount, maxPlayers }) => {
        const room = ROOMS[roomId];
        if (!room) return emitHostError(socket, 'room_not_found', 'Room not found');
        if (room.state !== 'LOBBY') return emitHostError(socket, 'invalid_state', 'Lobby settings can only change before game start');

        const spy = parseNonNegativeInt(spyCount, room.config.spyCount);
        const blank = parseNonNegativeInt(blankCount, room.config.blankCount);
        const cap = parseOptionalPositiveInt(maxPlayers);
        if (Number.isNaN(spy)) return emitHostError(socket, 'invalid_spy_count', 'Invalid spy count');
        if (Number.isNaN(blank)) return emitHostError(socket, 'invalid_blank_count', 'Invalid blank count');
        if (Number.isNaN(cap) || (cap !== null && cap < 3)) return emitHostError(socket, 'invalid_max_players', 'Invalid max player count');
        if (cap !== null && cap < room.players.length) return emitHostError(socket, 'max_below_joined', 'Max players cannot be less than joined players');

        room.config.spyCount = spy;
        room.config.blankCount = blank;
        room.config.maxPlayers = cap;
        await persistRoom(room);
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
    });

    // Host manual resync: resend current state to everyone in the room
    socket.on('host_resync', ({ roomId }) => {
        const targetRoomId = roomId || socket.data.hostRoom;
        if (!targetRoomId) return;
        const room = ROOMS[targetRoomId];
        if (!room) return;
        const counts = remainingCounts(room);
        io.to(targetRoomId).emit('update_lobby', lobbyPayload(room));

        if (room.state === 'GAMING') {
            io.to(targetRoomId).emit('game_started', {
                players: scrubPlayersForAudience(room.players),
                counts,
                total: room.config.totalPlayers
            });
            room.players.forEach(p => {
                if (p.socketId) {
                    io.to(p.socketId).emit('your_word', { word: p.word || '' });
                }
            });
        } else if (room.state === 'VOTING') {
            const alive = room.players.filter(p => !p.isOut);
            io.to(targetRoomId).emit('vote_begin', { players: scrubPlayersForAudience(alive), votes: room.votes || { counts: {}, voters: [] } });
        } else if (room.state === 'BLANK_GUESS') {
            io.to(targetRoomId).emit('blank_guess_start');
            const eligible = room.blankGuess?.eligible || [];
            room.players.forEach(p => {
                if (!p.socketId) return;
                if (eligible.includes(p.id)) {
                    io.to(p.socketId).emit('blank_guess_prompt');
                } else {
                    io.to(p.socketId).emit('blank_guess_wait');
                }
            });
        } else if (room.state === 'FINISHED') {
            const finalRoles = scrubPlayersForHost(room.players);
            io.to(targetRoomId).emit('game_over', { result: room.lastResult || 'finished', finalRoles });
        }
    });

    // Player Joins
    socket.on('join_game', async ({ roomId, name, photoBase64, playerId: existingId, existingImage }) => {
        const room = ROOMS[roomId];
        if (!room) {
            socket.emit('room_not_found');
            return;
        }

        const kickedIds = new Set(room.kickedPlayerIds || []);
        let player = existingId && !kickedIds.has(existingId) ? room.players.find(p => p.id === existingId && !p.kicked) : null;
        if (player) {
            // Rejoin flow
            player.socketId = socket.id;
            socket.join(roomId);
            socket.emit('joined', { playerId: player.id, roomId, name: player.name, image: player.image });
            socket.emit('your_word', { word: player.word || '' });
            const counts = room.state !== 'LOBBY' ? remainingCounts(room) : null;
            io.to(roomId).emit('update_lobby', lobbyPayload(room));

            // Send current state snapshot so the player UI can recover after reconnect/refresh
            if (room.state === 'GAMING') {
                socket.emit('game_started', {
                    players: scrubPlayersForAudience(room.players),
                    counts,
                    total: room.config.totalPlayers
                });
            } else if (room.state === 'VOTING') {
                const alive = room.players.filter(p => !p.isOut);
                socket.emit('vote_begin', { players: scrubPlayersForAudience(alive), votes: room.votes || { counts: {}, voters: [] } });
            } else if (room.state === 'BLANK_GUESS') {
                const eligible = room.blankGuess?.eligible || [];
                if (eligible.includes(player.id)) {
                    socket.emit('blank_guess_prompt');
                } else {
                    socket.emit('blank_guess_wait');
                }
            } else if (room.state === 'FINISHED') {
                const finalRoles = scrubPlayersForHost(room.players);
                socket.emit('game_over', { result: room.lastResult || 'finished', finalRoles });
            }

            console.log(`Player rejoined room ${roomId}: ${player.id}`);
            await persistRoom(room);
            return;
        }

        if (room.state !== 'LOBBY' && !existingId) return socket.emit('error', 'Game already started');
        if (room.config.maxPlayers && room.players.length >= room.config.maxPlayers) return socket.emit('error', 'Room is full');

        const playerId = kickedIds.has(existingId) ? uuidv4() : (existingId || uuidv4());
        const safeName = sanitizePlayerName(name, `玩家${room.players.length + 1}`);
        let imgPath = null;

        if (photoBase64) {
            try {
                const clean = photoBase64.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(clean, 'base64');
                const dir = path.join(SECTIONS_DIR, roomId);
                await fsp.mkdir(dir, { recursive: true });
                const fileName = `${playerId}.jpg`;
                try {
                    await sharp(buffer).resize({ width: 512, height: 512, fit: 'inside' }).jpeg({ quality: 75 }).toFile(path.join(dir, fileName));
                } catch (e) {
                    console.error('sharp resize failed, saving original', e);
                    await fsp.writeFile(path.join(dir, fileName), buffer);
                }
                imgPath = `/sections/${roomId}/${fileName}`;
            } catch (e) {
                console.error('Failed to save image', e);
            }
        } else if (existingImage) {
            imgPath = existingImage;
        }

        const newPlayer = {
            id: playerId,
            socketId: socket.id,
            name: safeName,
            image: imgPath,
            role: null,
            word: null,
            isOut: false,
            pendingBlank: false,
            vote: null
        };

        room.players.push(newPlayer);
        await persistRoom(room);

        socket.join(roomId);

        socket.emit('joined', { playerId, roomId, name: safeName, image: imgPath });
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
        console.log(`Player joined room ${roomId}: ${playerId}`);
    });

    // Player leaves (manual)
    socket.on('leave_room', async ({ roomId, playerId }) => {
        const room = ROOMS[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        if (room.state === 'LOBBY') {
            room.players = room.players.filter(p => p.id !== playerId);
            await persistRoom(room);
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
        } else {
            await processElimination(room, player, 'left', { skipVotingComplete: true });
        }
        console.log(`Player left room ${roomId}: ${playerId}`);
    });

    socket.on('host_kick_player', async ({ roomId, playerId }) => {
        const room = ROOMS[roomId];
        if (!room) return emitHostError(socket, 'room_not_found', 'Room not found');
        const player = room.players.find(p => p.id === playerId);
        if (!player) return emitHostError(socket, 'player_not_found', 'Player not found');

        const targetSocket = player.socketId ? io.sockets.sockets.get(player.socketId) : null;
        room.kickedPlayerIds = room.kickedPlayerIds || [];
        if (!room.kickedPlayerIds.includes(playerId)) room.kickedPlayerIds.push(playerId);
        if (room.state === 'LOBBY') {
            room.players = room.players.filter(p => p.id !== playerId);
            await persistRoom(room);
            if (targetSocket) {
                targetSocket.emit('kicked', { roomId, reason: 'host_kick' });
                targetSocket.leave(roomId);
            }
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
            return;
        }

        if (player.isOut) return emitHostError(socket, 'player_already_out', 'Player is already out');
        player.kicked = true;
        resetVotes(room);
        if (targetSocket) targetSocket.emit('kicked', { roomId, reason: 'host_kick' });
        await processElimination(room, player, 'host_kick', { votingStatus: 'kicked', skipVotingComplete: room.state !== 'VOTING' });
    });

    // Host Starts Game
    socket.on('start_game', async ({ roomId }) => {
        await startGameForSocket(roomId, socket);
    });

    // Voting Logic
    socket.on('start_vote', async ({ roomId }) => {
        console.log('start_vote');
        const room = ROOMS[roomId];
        if (!room || room.state !== 'GAMING') return;
        room.state = 'VOTING';
        room.votes = { counts: {}, voters: [] };
        await persistRoom(room);
        const alive = room.players.filter(p => !p.isOut);
        //console.log(alive);
        io.to(roomId).emit('vote_begin', { players: scrubPlayersForAudience(alive), votes: room.votes });
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
    });

    socket.on('cast_vote', async ({ roomId, voterId, targetId }) => {
        const room = ROOMS[roomId];
        if (!room || room.state !== 'VOTING') return;
        const voter = room.players.find(p => p.id === voterId && !p.isOut);
        if (!voter) return;
        const target = room.players.find(p => p.id === targetId && !p.isOut);
        if (!target) return;
        // prevent double vote
        if (room.votes?.voters?.includes(voterId)) return;
        room.votes.counts = room.votes.counts || {};
        room.votes.voters = room.votes.voters || [];
        room.votes.counts[targetId] = (room.votes.counts[targetId] || 0) + 1;
        room.votes.voters.push(voterId);

        io.to(roomId).emit('vote_update', { voterId, targetId, votes: room.votes, players: scrubPlayersForHost(room.players) });

        const alivePlayers = room.players.filter(p => !p.isOut);
        const lockedWinnerId = lockedVoteWinner(room);
        const allVoted = room.votes.voters.length >= alivePlayers.length;

        if (lockedWinnerId || allVoted) {
            const tallyEntries = sortedVoteEntries(room.votes);
            if (!tallyEntries.length) return;
            const [topId, topVotes] = tallyEntries[0];
            const second = tallyEntries[1];
            const tie = second && second[1] === topVotes;

            if (!lockedWinnerId && tie) {
                resetVotes(room);
                room.state = 'GAMING';
                await persistRoom(room);
                const counts = remainingCounts(room);
                return io.to(roomId).emit('voting_complete', { status: 'tie', counts, votes: room.votes, players: scrubPlayersForHost(room.players) });
            }

            const eliminated = room.players.find(p => p.id === (lockedWinnerId || topId));
            await processElimination(room, eliminated, 'voted_out', { votingStatus: lockedWinnerId ? 'locked_out' : 'out' });
        }
    });

    socket.on('blank_guess_submit', async ({ roomId, playerId, guess }) => {
        const room = ROOMS[roomId];
        await handleBlankGuessSubmit(roomId, playerId, guess);
        console.log(room.state);
    });

    socket.on('restart_game', async ({ roomId, keepPlayers }) => {
        const room = ROOMS[roomId];
        if (!room) return;
        if (keepPlayers) {
            room.question = null;
            room.votes = { counts: {}, voters: [] };
            room.state = 'LOBBY';
            room.lastResult = null;
            room.config.totalPlayers = null;
            room.players.forEach(p => {
                p.isOut = false;
                p.role = null;
                p.word = null;
                p.pendingBlank = false;
            });
            await persistRoom(room);
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
        } else {
            // move all players to waiting pool
            room.players.forEach(p => {
                WAITING_PLAYERS.set(p.socketId, { socketId: p.socketId, name: p.name, image: p.image, playerId: p.id });
                const sock = io.sockets.sockets.get(p.socketId);
                if (sock) sock.emit('room_reset_wait');
            });
            // notify host page to go back to creation
            io.to(roomId).emit('room_reset_host');
            await removeRoom(roomId);
        }
    });

    socket.on('disconnect', () => {
        // Remove host viewer tracking; if none remain, remove room
        const roomId = socket.data.hostRoom;
        if (roomId) {
            const viewers = HOST_VIEWS.get(roomId);
            if (viewers) {
                viewers.delete(socket.id);
                const room = ROOMS[roomId];
                if (viewers.size === 0 && room && room.players.length === 0) {
                    removeRoom(roomId);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
