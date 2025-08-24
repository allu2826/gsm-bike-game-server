// server.js

// 1. Imports and Setup
const WebSocket = require('ws');
const admin = require('firebase-admin');

// IMPORTANT: Initialize Firebase Admin with your Service Account Key
const serviceAccount = require('./service-account-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const auth = admin.auth();

const wss = new WebSocket.Server({ port: 8080 });

console.log('Server started on port 8080...');

const rooms = {}; // In-memory store for all game rooms
const clients = {}; // Store all connected clients

// 2. Game Logic and Loop
const TICK_RATE = 1000 / 60; // 60 times per second

function gameLoop() {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.state.status !== 'playing') continue;

        // Update player positions based on their inputs
        for (const playerId in room.state.players) {
            const player = room.state.players[playerId];
            const inputs = player.inputs;

            if (inputs['ArrowUp']) player.y -= player.speed;
            if (inputs['ArrowDown']) player.y += player.speed;
            if (inputs['ArrowLeft']) player.x -= player.speed;
            if (inputs['ArrowRight']) player.x += player.speed;

            // Boundary checks
            if (player.x - player.radius < 0) player.x = player.radius;
            if (player.x + player.radius > 800) player.x = 800 - player.radius;
            if (player.y - player.radius < 0) player.y = player.radius;
            if (player.y + player.radius > 600) player.y = 600 - player.radius;
        }

        // Broadcast the updated state to all players in the room
        const payload = { type: 'gameState', state: room.state };
        room.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(payload));
            }
        });
    }
}

setInterval(gameLoop, TICK_RATE);

// 3. WebSocket Connection Handling
wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        let client = clients[ws.id];

        // The first message MUST be for authentication
        if (data.type === 'auth') {
            try {
                const decodedToken = await auth.verifyIdToken(data.token);
                const uid = decodedToken.uid;
                
                // Fetch user profile from Firestore
                const userDoc = await db.collection('users').doc(uid).get();
                if (!userDoc.exists) throw new Error('User not found in Firestore');
                const userProfile = userDoc.data();

                ws.id = uid; // Assign the authenticated UID as the ws ID
                clients[uid] = { ws, userProfile };
                console.log(`Client authenticated: ${userProfile.nickname} (${userProfile.gid})`);
                ws.send(JSON.stringify({ type: 'authSuccess', message: 'Authentication successful!' }));
                return;
            } catch (error) {
                console.error("Auth error:", error.message);
                ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed.' }));
                ws.close();
                return;
            }
        }

        // If client is not authenticated yet, ignore other messages
        if (!client) return;

        // Handle other message types from authenticated clients
        switch (data.type) {
            case 'createRoom':
                const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                rooms[roomId] = {
                    id: roomId,
                    clients: [client],
                    state: {
                        status: 'waiting',
                        players: {
                            [client.ws.id]: {
                                x: 100, y: 300, radius: 8, speed: 4,
                                nickname: client.userProfile.nickname,
                                gid: client.userProfile.gid,
                                inputs: {}
                            }
                        }
                    }
                };
                client.roomId = roomId;
                console.log(`Room ${roomId} created by ${client.userProfile.nickname}`);
                ws.send(JSON.stringify({ type: 'roomCreated', roomId }));
                break;
            
            case 'joinRoom':
                const roomToJoin = rooms[data.roomId];
                if (roomToJoin && Object.keys(roomToJoin.state.players).length < 4) {
                    roomToJoin.clients.push(client);
                    roomToJoin.state.players[client.ws.id] = {
                        x: 100 + Object.keys(roomToJoin.state.players).length * 50,
                        y: 300, radius: 8, speed: 4,
                        nickname: client.userProfile.nickname,
                        gid: client.userProfile.gid,
                        inputs: {}
                    };
                    client.roomId = data.roomId;
                    console.log(`${client.userProfile.nickname} joined room ${data.roomId}`);
                    // Notify all players in the room of the new state
                    const joinPayload = { type: 'gameState', state: roomToJoin.state };
                    roomToJoin.clients.forEach(c => c.ws.send(JSON.stringify(joinPayload)));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found or is full.' }));
                }
                break;

            case 'input':
                const playerRoom = rooms[client.roomId];
                if (playerRoom && playerRoom.state.players[client.ws.id]) {
                    playerRoom.state.players[client.ws.id].inputs = data.inputs;
                }
                break;
            
            case 'startGame':
                const roomToStart = rooms[client.roomId];
                if(roomToStart) {
                    roomToStart.state.status = 'playing';
                    // You could load level obstacles here
                    // roomToStart.state.obstacles = loadLevel(levelId);
                    console.log(`Game started in room ${client.roomId}`);
                }
                break;
        }
    });

    ws.on('close', () => {
        const client = Object.values(clients).find(c => c.ws === ws);
        if (client) {
            console.log(`Client ${client.userProfile.nickname} disconnected`);
            const room = rooms[client.roomId];
            if (room) {
                // Remove player from room clients and state
                room.clients = room.clients.filter(c => c.ws.id !== client.ws.id);
                delete room.state.players[client.ws.id];
                
                // If room is empty, delete it
                if (room.clients.length === 0) {
                    console.log(`Room ${client.roomId} is empty, deleting.`);
                    delete rooms[client.roomId];
                } else {
                     // Notify remaining players
                    const leavePayload = { type: 'gameState', state: room.state };
                    room.clients.forEach(c => c.ws.send(JSON.stringify(leavePayload)));
                }
            }
            delete clients[client.ws.id];
        }
    });
});