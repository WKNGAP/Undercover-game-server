const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'test-console.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s+src="[^"]+")?><\/script>|<script>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts.map(match => match[1]).filter(Boolean).join('\n');
const listeners = new Map();
const elements = new Map();
const emitted = [];
const ioTargets = [];

class Element {
    constructor(id = '') {
        this.id = id;
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.children = [];
        this.className = '';
        this.disabled = false;
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.style = {};
        this.classList = { add() {}, remove() {} };
    }

    addEventListener(event, handler) {
        listeners.set(`${this.id}:${event}`, handler);
    }

    append(...children) {
        this.children.push(...children);
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    focus() {
        this.focused = true;
    }
}

function element(id) {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
}

const document = {
    getElementById: element,
    createElement: tag => new Element(tag)
};

const socket = {
    connected: true,
    handlers: {},
    on(event, handler) {
        this.handlers[event] = handler;
    },
    emit(event, payload) {
        emitted.push({ event, payload });
        if (event === 'join_game') {
            this.handlers.joined?.({
                playerId: `player-${emitted.length}`,
                roomId: payload.roomId,
                name: payload.name
            });
        }
    },
    disconnect() {
        this.connected = false;
        this.handlers.disconnect?.();
    }
};

const context = {
    console,
    document,
    window: { location: { origin: 'http://localhost:3000' } },
    location: { search: '' },
    URLSearchParams,
    Date,
    io: (target) => {
        ioTargets.push(target);
        return socket;
    }
};

element('serverUrl').value = 'http://localhost:3000';
element('roomId').value = 'ABC123';
element('playerCount').value = '3';
element('namePrefix').value = 'Tester';

vm.runInNewContext(inlineScript, context);

const click = listeners.get('joinBtn:click');
if (!click) throw new Error('Join Players click handler was not registered');
click();

const joins = emitted.filter(item => item.event === 'join_game');
if (joins.length !== 3) {
    throw new Error(`Expected 3 join_game emits, got ${joins.length}`);
}

if (!ioTargets.every(target => target === 'http://localhost:3000')) {
    throw new Error(`Unexpected Socket.IO targets: ${ioTargets.join(', ')}`);
}

const badRoom = joins.find(item => item.payload.roomId !== 'ABC123');
if (badRoom) throw new Error(`Unexpected room ID ${badRoom.payload.roomId}`);

console.log('test-console smoke passed');
