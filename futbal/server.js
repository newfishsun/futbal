/**
 * Football RNG Legends v2 — Real-Time Online 1v1 Server (Localhost & Render Cloud)
 * Run locally:   node server.js   -> http://localhost:3000
 * Render Cloud:  Start Command: node server.js (Health Check: /healthz)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const clients = new Map();
const rooms = new Map();
const serverFeed = [
    { time: 'Live', tag: 'ONLINE', text: '🟢 Server Online — Click "Find 1v1 Match" or challenge any player!', cls: 'text-emerald-300 font-bold' }
];

function pushServerFeed(tag, text, cls = 'text-sky-300') {
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5);
    serverFeed.unshift({ time: timeStr, tag, text, cls });
    if (serverFeed.length > 20) serverFeed.length = 20;
}

function encodeWsFrame(dataStr, opcode = 0x01) {
    const payload = Buffer.from(dataStr, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

function sendJson(client, obj) {
    if (!client || !client.socket || client.socket.destroyed || !client.socket.writable) return;
    try {
        client.socket.write(encodeWsFrame(JSON.stringify(obj), 0x01));
    } catch (e) {}
}

function broadcastJson(obj, excludeClientId = null) {
    const frame = encodeWsFrame(JSON.stringify(obj), 0x01);
    for (const [id, c] of clients.entries()) {
        if (id === excludeClientId) continue;
        if (c.socket && !c.socket.destroyed && c.socket.writable) {
            try { c.socket.write(frame); } catch (e) {}
        }
    }
}

function getPublicLobbySnapshot() {
    const playerList = [];
    for (const c of clients.values()) {
        playerList.push({
            clientId: c.id,
            gamerTag: c.gamerTag,
            rp: c.rp,
            division: c.division,
            formation: c.formation,
            ovr: c.ovr,
            status: c.roomId ? 'in_match' : (c.inQueue ? 'queuing' : 'idle'),
            ping: c.ping || 12
        });
    }
    const openRooms = [];
    for (const r of rooms.values()) {
        if (r.status === 'waiting') {
            const host = clients.get(r.hostId);
            if (host) {
                openRooms.push({
                    roomId: r.roomId,
                    code: r.code,
                    hostId: host.id,
                    hostGamerTag: host.gamerTag,
                    hostOvr: host.ovr,
                    hostFormation: host.formation,
                    fieldTheme: r.fieldTheme,
                    timeOfDay: r.timeOfDay
                });
            }
        }
    }
    return {
        type: 'lobby_state',
        onlineCount: clients.size,
        activeMatchCount: Array.from(rooms.values()).filter(r => r.status === 'playing').length,
        players: playerList,
        openRooms,
        serverFeed
    };
}

function broadcastLobbyState() {
    broadcastJson(getPublicLobbySnapshot());
}

function applyClientProfileFields(client, msg) {
    if (msg.gamerTag) client.gamerTag = String(msg.gamerTag).trim().slice(0, 20) || client.gamerTag;
    if (msg.rp) client.rp = Number(msg.rp) || 1200;
    if (msg.division) client.division = String(msg.division);
    if (msg.formation) client.formation = String(msg.formation);
    if (msg.ovr) client.ovr = Number(msg.ovr) || 90;
    if (msg.kitColor) client.kitColor = Number(msg.kitColor) || 0xef4444;
    if (msg.fieldPref) client.fieldPref = String(msg.fieldPref);
    if (msg.timePref) client.timePref = String(msg.timePref);
    if (Array.isArray(msg.xi) && msg.xi.length === 11) {
        client.xi = msg.xi;
    }
}

function createMatchRoom(hostClient, guestClient, options = {}) {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const code = options.code || String(Math.floor(1000 + Math.random() * 9000));
    const fieldKeys = ['classic_stripes', 'diamond_cut', 'bullseye_rings', 'cyber_neon', 'samba_carnival', 'alpine_frost'];
    const timeKeys = ['day', 'evening', 'night'];

    const chosenField = (options.fieldTheme && options.fieldTheme !== 'random')
        ? options.fieldTheme
        : fieldKeys[Math.floor(Math.random() * fieldKeys.length)];
    const chosenTime = (options.timeOfDay && options.timeOfDay !== 'random')
        ? options.timeOfDay
        : timeKeys[Math.floor(Math.random() * timeKeys.length)];

    const room = {
        roomId,
        code,
        hostId: hostClient.id,
        guestId: guestClient ? guestClient.id : null,
        status: guestClient ? 'playing' : 'waiting',
        fieldTheme: chosenField,
        timeOfDay: chosenTime,
        createdAt: Date.now()
    };

    rooms.set(roomId, room);
    hostClient.roomId = roomId;
    hostClient.inQueue = false;

    if (guestClient) {
        guestClient.roomId = roomId;
        guestClient.inQueue = false;
        startRoomMatch(room);
    } else {
        sendJson(hostClient, {
            type: 'room_created',
            roomId: room.roomId,
            code: room.code,
            fieldTheme: room.fieldTheme,
            timeOfDay: room.timeOfDay
        });
        broadcastLobbyState();
    }
    return room;
}

function startRoomMatch(room) {
    const host = clients.get(room.hostId);
    const guest = clients.get(room.guestId);
    if (!host || !guest) return;

    room.status = 'playing';
    const homePayload = {
        clientId: host.id,
        gamerTag: host.gamerTag,
        rp: host.rp,
        division: host.division,
        formation: host.formation || '4-3-3',
        ovr: host.ovr || 90,
        kitColor: 0x3b82f6,
        gkColor: 0xf59e0b,
        xi: host.xi || []
    };
    const awayPayload = {
        clientId: guest.id,
        gamerTag: guest.gamerTag,
        rp: guest.rp,
        division: guest.division,
        formation: guest.formation || '4-3-3',
        ovr: guest.ovr || 90,
        kitColor: 0xef4444,
        gkColor: 0x10b981,
        xi: guest.xi || []
    };

    pushServerFeed(
        '1V1',
        `⚔️ ${host.gamerTag} (${homePayload.ovr} OVR) vs ${guest.gamerTag} (${awayPayload.ovr} OVR) started!`,
        'text-fuchsia-300 font-bold'
    );

    const startMsgBase = {
        type: 'match_start',
        roomId: room.roomId,
        code: room.code,
        fieldTheme: room.fieldTheme,
        timeOfDay: room.timeOfDay,
        homePlayer: homePayload,
        awayPlayer: awayPayload
    };

    sendJson(host, { ...startMsgBase, role: 'host', teamIndex: 0 });
    sendJson(guest, { ...startMsgBase, role: 'guest', teamIndex: 1 });
    broadcastLobbyState();
}

function tryMatchmakeQueue() {
    const queuing = Array.from(clients.values()).filter(c => c.inQueue && !c.roomId && c.socket && !c.socket.destroyed);
    while (queuing.length >= 2) {
        const p1 = queuing.shift();
        const p2 = queuing.shift();
        if (p1.id === p2.id) continue;
        createMatchRoom(p1, p2, {
            fieldTheme: (p1.fieldPref && p1.fieldPref !== 'random') ? p1.fieldPref : (p2.fieldPref || 'random'),
            timeOfDay: (p1.timePref && p1.timePref !== 'random') ? p1.timePref : (p2.timePref || 'random')
        });
    }
}

function cleanupClientRoom(client, reason = 'Opponent disconnected') {
    if (!client.roomId) return;
    const room = rooms.get(client.roomId);
    client.roomId = null;
    if (!room) return;

    const otherId = room.hostId === client.id ? room.guestId : room.hostId;
    rooms.delete(room.roomId);
    if (otherId) {
        const other = clients.get(otherId);
        if (other) {
            other.roomId = null;
            sendJson(other, { type: 'opponent_left', reason });
        }
    }
}

function handleClientMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
        case 'ping_check': {
            if (typeof msg.rtt === 'number' && msg.rtt > 0 && msg.rtt < 5000) {
                client.ping = Math.round(msg.rtt);
            }
            sendJson(client, { type: 'pong_check', clientTs: msg.clientTs });
            break;
        }

        case 'register_profile': {
            const prevKey = `${client.gamerTag}|${client.ovr}|${client.formation}`;
            applyClientProfileFields(client, msg);
            const nextKey = `${client.gamerTag}|${client.ovr}|${client.formation}`;
            if (prevKey !== nextKey || !client.hasRegisteredOnce) {
                client.hasRegisteredOnce = true;
                broadcastLobbyState();
            } else {
                sendJson(client, getPublicLobbySnapshot());
            }
            break;
        }

        case 'join_queue': {
            cleanupClientRoom(client, 'Left previous room');
            applyClientProfileFields(client, msg);
            client.inQueue = true;
            sendJson(client, { type: 'queue_status', inQueue: true });
            tryMatchmakeQueue();
            broadcastLobbyState();
            break;
        }

        case 'leave_queue': {
            client.inQueue = false;
            sendJson(client, { type: 'queue_status', inQueue: false });
            broadcastLobbyState();
            break;
        }

        case 'create_room': {
            cleanupClientRoom(client, 'Created new room');
            applyClientProfileFields(client, msg);
            createMatchRoom(client, null, {
                fieldTheme: msg.fieldTheme || 'random',
                timeOfDay: msg.timeOfDay || 'random'
            });
            break;
        }

        case 'cancel_room': {
            cleanupClientRoom(client, 'Room cancelled');
            broadcastLobbyState();
            break;
        }

        case 'join_room': {
            const codeClean = String(msg.code || '').replace(/[^0-9]/g, '');
            const targetRoomId = msg.roomId || null;
            let targetRoom = null;
            for (const r of rooms.values()) {
                if (r.status === 'waiting' && (r.roomId === targetRoomId || (codeClean && r.code === codeClean))) {
                    targetRoom = r;
                    break;
                }
            }
            if (!targetRoom) {
                sendJson(client, { type: 'error_toast', message: 'Room not found or already full!' });
                return;
            }
            if (targetRoom.hostId === client.id) {
                sendJson(client, { type: 'error_toast', message: 'You are already hosting this room!' });
                return;
            }
            applyClientProfileFields(client, msg);
            cleanupClientRoom(client, 'Joined another room');
            targetRoom.guestId = client.id;
            client.roomId = targetRoom.roomId;
            client.inQueue = false;
            startRoomMatch(targetRoom);
            break;
        }

        case 'send_challenge': {
            const target = clients.get(msg.targetClientId);
            if (!target || target.id === client.id) {
                sendJson(client, { type: 'error_toast', message: 'Player is no longer available.' });
                return;
            }
            if (target.roomId) {
                sendJson(client, { type: 'error_toast', message: `${target.gamerTag} is already in a match!` });
                return;
            }
            applyClientProfileFields(client, msg);
            // If the target player is currently in queue, pair them immediately!
            if (target.inQueue) {
                cleanupClientRoom(client);
                createMatchRoom(target, client, {
                    fieldTheme: msg.fieldTheme || 'random',
                    timeOfDay: msg.timeOfDay || 'random'
                });
                return;
            }
            sendJson(target, {
                type: 'incoming_challenge',
                fromClientId: client.id,
                fromGamerTag: client.gamerTag,
                fromOvr: client.ovr,
                fromFormation: client.formation,
                fieldTheme: msg.fieldTheme || 'random',
                timeOfDay: msg.timeOfDay || 'random'
            });
            break;
        }

        case 'accept_challenge': {
            const challenger = clients.get(msg.fromClientId);
            if (!challenger || challenger.roomId) {
                sendJson(client, { type: 'error_toast', message: 'Challenger is no longer available!' });
                return;
            }
            applyClientProfileFields(client, msg);
            cleanupClientRoom(challenger);
            cleanupClientRoom(client);
            createMatchRoom(challenger, client, {
                fieldTheme: msg.fieldTheme || 'random',
                timeOfDay: msg.timeOfDay || 'random'
            });
            break;
        }

        case 'pvp_input':
        case 'pvp_action':
        case 'pvp_state':
        case 'pvp_event':
        case 'pvp_emote': {
            if (!client.roomId) return;
            const room = rooms.get(client.roomId);
            if (!room) return;
            const targetId = room.hostId === client.id ? room.guestId : room.hostId;
            const peer = targetId ? clients.get(targetId) : null;
            if (peer) sendJson(peer, msg);
            break;
        }

        case 'match_finished': {
            if (client.roomId) {
                const room = rooms.get(client.roomId);
                if (room && room.hostId === client.id) {
                    const host = clients.get(room.hostId);
                    const guest = clients.get(room.guestId);
                    if (host && guest) {
                        pushServerFeed(
                            'FT',
                            `🏁 ${host.gamerTag} (${msg.homeScore} - ${msg.awayScore}) ${guest.gamerTag}`,
                            'text-emerald-300 font-bold'
                        );
                    }
                }
                cleanupClientRoom(client, 'Match finished');
                broadcastLobbyState();
            }
            break;
        }

        case 'leave_match': {
            cleanupClientRoom(client, `${client.gamerTag} left the match`);
            broadcastLobbyState();
            break;
        }

        case 'chat_message': {
            const text = String(msg.text || '').trim().slice(0, 120);
            if (!text) return;
            pushServerFeed('CHAT', `💬 ${client.gamerTag}: ${text}`, 'text-sky-300');
            broadcastLobbyState();
            break;
        }
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    if (pathname === '/healthz' || pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            onlineCount: clients.size,
            activeMatches: Array.from(rooms.values()).filter(r => r.status === 'playing').length
        }));
        return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        pathname = '/football_rng_legends_v2.html';
    }

    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return;
    }

    const acceptKey = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
        .digest('base64');

    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
    ].join('\r\n'));
    socket.setNoDelay(true);

    const clientId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const client = {
        id: clientId,
        socket,
        gamerTag: 'Player_' + clientId.slice(-4).toUpperCase(),
        rp: 1200,
        division: '🥇 Gold',
        formation: '4-3-3',
        ovr: 90,
        kitColor: 0xef4444,
        ping: 12,
        xi: [],
        inQueue: false,
        roomId: null,
        hasRegisteredOnce: false,
        buffer: Buffer.alloc(0)
    };

    clients.set(clientId, client);
    sendJson(client, { type: 'welcome', clientId });
    broadcastLobbyState();

    socket.on('data', (chunk) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);

        while (client.buffer.length >= 2) {
            const firstByte = client.buffer[0];
            const secondByte = client.buffer[1];
            const opcode = firstByte & 0x0f;
            const isMasked = Boolean(secondByte & 0x80);
            let payloadLen = secondByte & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
                if (client.buffer.length < 4) return;
                payloadLen = client.buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (client.buffer.length < 10) return;
                payloadLen = Number(client.buffer.readBigUInt64BE(2));
                offset = 10;
            }

            const maskOffset = offset;
            if (isMasked) offset += 4;
            if (client.buffer.length < offset + payloadLen) return;

            const payload = Buffer.alloc(payloadLen);
            if (isMasked) {
                const mask = client.buffer.slice(maskOffset, maskOffset + 4);
                for (let i = 0; i < payloadLen; i++) {
                    payload[i] = client.buffer[offset + i] ^ mask[i % 4];
                }
            } else {
                client.buffer.copy(payload, 0, offset, offset + payloadLen);
            }

            client.buffer = client.buffer.slice(offset + payloadLen);

            if (opcode === 0x08) {
                socket.end();
                return;
            } else if (opcode === 0x09) {
                try { socket.write(encodeWsFrame(payload.toString('utf8'), 0x0a)); } catch (e) {}
            } else if (opcode === 0x01) {
                try {
                    handleClientMessage(client, JSON.parse(payload.toString('utf8')));
                } catch (e) {}
            }
        }
    });

    const handleDisconnect = () => {
        if (!clients.has(clientId)) return;
        cleanupClientRoom(client, `${client.gamerTag} disconnected`);
        clients.delete(clientId);
        broadcastLobbyState();
    };

    socket.on('close', handleDisconnect);
    socket.on('error', handleDisconnect);
    socket.on('end', handleDisconnect);
});

server.listen(PORT, HOST, () => {
    console.log(`⚽ Football RNG Legends v2 Server running at http://localhost:${PORT} (ws://localhost:${PORT})`);
});