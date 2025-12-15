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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_ROOT = path.join(__dirname, 'data');
const QUESTION_LIB_DIR = path.join(DATA_ROOT, 'QuestionLib');
const SECTIONS_DIR = path.join(DATA_ROOT, 'Sections');

// Ensure required folders exist
[DATA_ROOT, QUESTION_LIB_DIR, SECTIONS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
app.use(express.static('public'));
app.use('/sections', express.static(SECTIONS_DIR)); // serve saved images
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
    const allowCount = Math.max(0, room.config.totalPlayers - 1); // leave one slot to avoid auto start
    shuffle(waiting);
    const allowed = waiting.slice(0, allowCount);
    const kicked = waiting.slice(allowCount);
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
        total: room.config.totalPlayers,
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
            io.to(roomId).emit('game_over', { result: 'civil_win', players: room.players.filter(p => p.role === 'Civilian'), finalRoles });
        } else if (result.result === 'spy_win') {
            io.to(roomId).emit('game_over', { result: 'spy_win', players: room.players.filter(p => p.role === 'Spy'), finalRoles });
        } else {
            io.to(roomId).emit('blank_guess_end', { counts: remainingCounts(room), state: room.state });
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
        }
    }
}
async function startGame(roomId) {
    const room = ROOMS[roomId];
    if (!room || room.state !== 'LOBBY') return;
    if (room.players.length !== room.config.totalPlayers) return;

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
            roles: scrubPlayersForHost(room.players),
            counts
        });

        room.players.forEach(p => {
        io.to(p.socketId).emit('your_word', { word: p.word });
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
        const { type, totalPlayers, spyCount, blankCount } = req.body;
        const total = Number(totalPlayers);
        const spy = Number(spyCount);
        const blank = Number(blankCount);

        // Logic Validation
        if (!Number.isInteger(total) || total < 3) return res.status(400).json({ error: 'Invalid player count' });
        const maxSpy = Math.floor(total / 2);
        const maxBlank = Math.floor(total / 2) - spy;

        if (spy < 1 || spy > maxSpy) return res.status(400).json({ error: 'Invalid spy count' });
        if (blank < 0 || blank > maxBlank) return res.status(400).json({ error: 'Invalid blank count' });

        const roomId = uuidv4().substring(0, 6).toUpperCase();
        ROOMS[roomId] = {
            id: roomId,
            config: { totalPlayers: total, spyCount: spy, blankCount: blank, type: type || 'all' },
            question: null,
            players: [],
            state: 'LOBBY', // LOBBY, GAMING, VOTING, FINISHED
            votes: { counts: {}, voters: [] },
            createdAt: new Date().toISOString(),
            usedQuestionIds: [],
            questionHistory: []
        };

        const joinUrl = `${req.protocol}://${req.headers.host}/join/${roomId}`;
        const qrDataUrl = await QRCode.toDataURL(joinUrl);

        await persistRoom(ROOMS[roomId]);
        await attachWaitingPlayers(roomId, ROOMS[roomId]);

        console.log(`Room created: ${roomId} type=${type || 'all'} players=${total} spies=${spy} blanks=${blank}`);

        res.json({ roomId, url: joinUrl, qr: qrDataUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// 2. Join Room (Player landing)
app.get('/join/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
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

    // Player Joins
    socket.on('join_game', async ({ roomId, name, photoBase64, playerId: existingId, existingImage }) => {
        const room = ROOMS[roomId];
        if (!room) {
            socket.emit('room_not_found');
            return;
        }

        let player = existingId ? room.players.find(p => p.id === existingId) : null;
        if (player) {
            // Rejoin flow
            player.socketId = socket.id;
            socket.join(roomId);
            socket.emit('joined', { playerId: player.id, roomId, name: player.name, image: player.image });
            if (player.word) {
                socket.emit('your_word', { word: player.word });
            }
            const counts = room.state !== 'LOBBY' ? remainingCounts(room) : null;
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
        console.log(`Player rejoined room ${roomId}: ${player.id}`);
        await persistRoom(room);
        return;
    }

        if (room.players.length >= room.config.totalPlayers) return socket.emit('error', 'Room is full');

        const playerId = existingId || uuidv4();
        const safeName = (name || '').trim() || `玩家${room.players.length + 1}`;
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

        if (room.players.length === room.config.totalPlayers && room.state === 'LOBBY') {
            await startGame(roomId);
        }
    });

    // Player leaves (manual)
    socket.on('leave_room', async ({ roomId, playerId }) => {
        const room = ROOMS[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        const wasBlank = player.role === 'Blank';
        player.isOut = true;
        player.pendingBlank = wasBlank;
        const result = wasBlank ? { result: 'blank_guess' } : checkEndGame(room);
        await persistRoom(room);
        io.to(roomId).emit('update_lobby', lobbyPayload(room));
        io.to(player.socketId).emit('you_out', { reason: 'left' });
        const finalRoles = scrubPlayersForHost(room.players);
        if (result.result === 'civil_win') {
            io.to(roomId).emit('game_over', { result: 'civil_win', players: room.players.filter(p => p.role === 'Civilian'), finalRoles });
        } else if (result.result === 'spy_win') {
            io.to(roomId).emit('game_over', { result: 'spy_win', players: room.players.filter(p => p.role === 'Spy'), finalRoles });
        } else if (result.result === 'blank_guess') {
            await startBlankGuess(room, { onlyEliminated: true, extraEligibleIds: [player.id] });
        }
        console.log(`Player left room ${roomId}: ${playerId}`);
    });

    // Host Starts Game
    socket.on('start_game', async ({ roomId }) => {
        await startGame(roomId);
    });

    // Voting Logic
    socket.on('start_vote', async ({ roomId }) => {
        console.log('start_vote');
        const room = ROOMS[roomId];
        if (!room || room.state === 'FINISHED') return;
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
        // prevent double vote
        if (room.votes?.voters?.includes(voterId)) return;
        room.votes.counts = room.votes.counts || {};
        room.votes.voters = room.votes.voters || [];
        room.votes.counts[targetId] = (room.votes.counts[targetId] || 0) + 1;
        room.votes.voters.push(voterId);

        io.to(roomId).emit('vote_update', { voterId, targetId, votes: room.votes, players: scrubPlayersForHost(room.players) });

        const alivePlayers = room.players.filter(p => !p.isOut);
        const allVoted = room.votes.voters.length >= alivePlayers.length;

        if (allVoted) {
            const tallyEntries = Object.entries(room.votes.counts).sort((a, b) => b[1] - a[1]);
            if (!tallyEntries.length) return;
            const [topId, topVotes] = tallyEntries[0];
            const second = tallyEntries[1];
            const tie = second && second[1] === topVotes;

            if (tie) {
                room.votes = { counts: {}, voters: [] };
                room.state = 'GAMING';
                await persistRoom(room);
                const counts = remainingCounts(room);
                return io.to(roomId).emit('voting_complete', { status: 'tie', counts, votes: room.votes, players: scrubPlayersForHost(room.players) });
            }

            const eliminated = room.players.find(p => p.id === topId);
            if (eliminated) {
                const wasBlank = eliminated.role === 'Blank';
                eliminated.isOut = true;
                eliminated.pendingBlank = wasBlank;
            }
            const eliminatedInfo = scrubPlayersForHost([eliminated])[0];
            if (eliminated?.socketId) {
                io.to(eliminated.socketId).emit('you_out', { reason: 'voted_out' });
            }

            // If a Blank was eliminated, trigger blank guess immediately (include eliminated in eligible list)
            if (eliminated?.role === 'Blank') {
                room.votes = { counts: {}, voters: [] };
                await persistRoom(room);
                io.to(roomId).emit('voting_complete', { status: 'out', player: eliminatedInfo, result: { result: 'blank_guess' }, counts: remainingCounts(room), votes: room.votes, players: scrubPlayersForHost(room.players) });
                await startBlankGuess(room, { onlyEliminated: true, extraEligibleIds: [eliminated.id] });
                return;
            }

            const result = checkEndGame(room);
            room.votes = { counts: {}, voters: [] };
            await persistRoom(room);

            io.to(roomId).emit('voting_complete', { status: 'out', player: eliminatedInfo, result: result.result === 'blank_guess' ? undefined : result, counts: remainingCounts(room), votes: room.votes, players: scrubPlayersForHost(room.players) });

        const finalRoles = scrubPlayersForHost(room.players);
        if (result.result === 'civil_win') {
            io.to(roomId).emit('game_over', { result: 'civil_win', players: room.players.filter(p => p.role === 'Civilian'), finalRoles });
        } else if (result.result === 'spy_win') {
            io.to(roomId).emit('game_over', { result: 'spy_win', players: room.players.filter(p => p.role === 'Spy'), finalRoles });
        } else if (result.result === 'blank_guess') {
            await startBlankGuess(room);
        } else {
                room.state = 'GAMING';
            }
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
            room.players.forEach(p => {
                p.isOut = false;
                p.role = null;
                p.word = null;
                p.pendingBlank = false;
            });
            await persistRoom(room);
            io.to(roomId).emit('update_lobby', lobbyPayload(room));
            if (room.players.length === room.config.totalPlayers) {
                await startGame(roomId);
            }
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
                if (viewers.size === 0) {
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
