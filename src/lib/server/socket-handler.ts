import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type {
	ClientToServerEvents,
	ServerToClientEvents,
	RoomInfo,
	RoomListEntry
} from '$lib/network/types.js';
import { RECONNECT_GRACE_MS } from '$lib/network/types.js';
import { GameSession } from './game-loop.js';
import crypto from 'crypto';

const rooms = new Map<string, RoomInfo>();
const sessions = new Map<string, GameSession>();
const socketToRoom = new Map<string, string>();

const tokenToRoom = new Map<string, { roomId: string; role: 'host' | 'guest' }>();
const roomTokens = new Map<string, { hostToken: string; guestToken: string | null }>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function generateRoomId(): string {
	return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateToken(): string {
	return crypto.randomBytes(16).toString('hex');
}

function getRoomList(): RoomListEntry[] {
	return Array.from(rooms.values())
		.filter((r) => !r.guestId)
		.map((r) => ({
			id: r.id,
			name: r.name,
			maxScore: r.maxScore,
			players: r.guestId ? 2 : 1
		}));
}

function broadcastRoomList(
	io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>
) {
	io.to('browser').emit('roomList', getRoomList());
}

export function setupSocketIO(server: HttpServer) {
	const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
		cors: { origin: '*' },
		pingInterval: 10000,
		pingTimeout: 5000
	});

	io.on('connection', (socket) => {
		socket.join('browser');

		socket.on('createRoom', (data, callback) => {
			const id = generateRoomId();
			const room: RoomInfo = {
				id,
				name: data.name,
				maxScore: data.maxScore,
				hostId: socket.id,
				guestId: null,
				hostReady: true,
				guestReady: false,
				hostName: 'Player 1',
				guestName: 'Player 2',
				hostColor: 'cyan',
				guestColor: 'pink'
			};
			rooms.set(id, room);
			socketToRoom.set(socket.id, id);
			socket.join(id);

			const hostToken = generateToken();
			tokenToRoom.set(hostToken, { roomId: id, role: 'host' });
			roomTokens.set(id, { hostToken, guestToken: null });

			callback(room, hostToken);
			broadcastRoomList(io);
		});

		socket.on('joinRoom', (data, callback) => {
			const room = rooms.get(data.roomId);
			if (!room) {
				callback(null, 'Room not found');
				return;
			}
			if (room.guestId) {
				callback(null, 'Room is full');
				return;
			}
			room.guestId = socket.id;
			room.guestReady = false;
			socketToRoom.set(socket.id, room.id);
			socket.join(room.id);

			const guestToken = generateToken();
			tokenToRoom.set(guestToken, { roomId: room.id, role: 'guest' });
			const tokens = roomTokens.get(room.id);
			if (tokens) {
				if (tokens.guestToken) tokenToRoom.delete(tokens.guestToken);
				tokens.guestToken = guestToken;
			}

			callback(room, guestToken);
			io.to(room.id).emit('roomUpdated', room);
			broadcastRoomList(io);
		});

		socket.on('rejoinRoom', (data, callback) => {
			const mapping = tokenToRoom.get(data.token);
			if (!mapping) {
				callback(null);
				return;
			}

			const room = rooms.get(mapping.roomId);
			if (!room) {
				tokenToRoom.delete(data.token);
				callback(null);
				return;
			}

			const { roomId, role } = mapping;

			const oldSocketId = role === 'host' ? room.hostId : room.guestId;
			if (oldSocketId) {
				socketToRoom.delete(oldSocketId);
			}

			if (role === 'host') {
				room.hostId = socket.id;
			} else {
				room.guestId = socket.id;
			}
			socketToRoom.set(socket.id, roomId);
			socket.join(roomId);

			const timerKey = `${roomId}:${role}`;
			const timer = disconnectTimers.get(timerKey);
			if (timer) {
				clearTimeout(timer);
				disconnectTimers.delete(timerKey);
			}

			const session = sessions.get(roomId);
			if (session) {
				session.resume();
				io.to(roomId).emit('opponentReconnected');
				io.to(roomId).emit('gameState', session.getState());
			}

			callback(room, role);
			io.to(roomId).emit('roomUpdated', room);
		});

		socket.on('getRoom', (data, callback) => {
			const room = rooms.get(data.roomId);
			callback(room ?? null);
		});

		socket.on('getMyRole', (data, callback) => {
			const room = rooms.get(data.roomId);
			if (!room) {
				callback(null);
				return;
			}
			if (socket.id === room.hostId) callback('host');
			else if (socket.id === room.guestId) callback('guest');
			else callback(null);
		});

		socket.on('listRooms', (callback) => {
			callback(getRoomList());
		});

		socket.on('toggleReady', () => {
			const roomId = socketToRoom.get(socket.id);
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;

			if (socket.id === room.hostId) {
				room.hostReady = !room.hostReady;
			} else if (socket.id === room.guestId) {
				room.guestReady = !room.guestReady;
			}
			io.to(room.id).emit('roomUpdated', room);
		});

		socket.on('setName', (data) => {
			const roomId = socketToRoom.get(socket.id);
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;

			const name = data.name.trim().substring(0, 16) || (socket.id === room.hostId ? 'Player 1' : 'Player 2');
			if (socket.id === room.hostId) {
				room.hostName = name;
			} else if (socket.id === room.guestId) {
				room.guestName = name;
			}
			io.to(room.id).emit('roomUpdated', room);
		});

		socket.on('setColor', (data) => {
			const roomId = socketToRoom.get(socket.id);
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;

			const color = data.color;
			if (socket.id === room.hostId && color !== room.guestColor) {
				room.hostColor = color;
			} else if (socket.id === room.guestId && color !== room.hostColor) {
				room.guestColor = color;
			}
			io.to(room.id).emit('roomUpdated', room);
		});

		socket.on('startGame', () => {
			const roomId = socketToRoom.get(socket.id);
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;
			if (socket.id !== room.hostId) return;
			if (!room.guestId || !room.hostReady || !room.guestReady) return;
			if (sessions.has(roomId)) return;

			const session = new GameSession(room.maxScore, {
				onStateUpdate: (state) => {
					io.to(roomId).emit('gameState', state);
				},
				onCountdown: (seconds) => {
					io.to(roomId).emit('countdown', { seconds });
				},
				onGoalScored: (scorer) => {
					io.to(roomId).emit('goalScored', { scorer });
				},
				onGameOver: (winner, hostScore, guestScore) => {
					io.to(roomId).emit('gameOver', { winner, hostScore, guestScore });
					sessions.delete(roomId);
				}
			});

			sessions.set(roomId, session);
			io.to(roomId).emit('gameStarted', { roomId });
			session.start();
		});

		socket.on('paddleMove', (data) => {
			const roomId = socketToRoom.get(socket.id);
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;
			const session = sessions.get(roomId);
			if (!session) return;

			const isHost = socket.id === room.hostId;
			session.setPaddlePosition(isHost, data.x, data.y);
		});

		socket.on('leaveRoom', () => {
			handleLeave(socket, io, true);
		});

		socket.on('disconnect', () => {
			handleLeave(socket, io, false);
			socket.leave('browser');
		});
	});

	return io;
}

function handleLeave(
	socket: { id: string },
	io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>,
	intentional: boolean
) {
	const roomId = socketToRoom.get(socket.id);
	if (!roomId) return;
	const room = rooms.get(roomId);
	socketToRoom.delete(socket.id);
	if (!room) return;

	const isHost = socket.id === room.hostId;
	const role = isHost ? 'host' : 'guest';
	const session = sessions.get(roomId);

	if (intentional) {
		cleanupTokensForRole(roomId, role);
		destroyRoom(roomId, isHost, io);
		return;
	}

	if (session && session.getState().status !== 'ended') {
		session.pause();
		io.to(roomId).emit('opponentDisconnected', { graceMs: RECONNECT_GRACE_MS });
		io.to(roomId).emit('gameState', session.getState());

		const timerKey = `${roomId}:${role}`;
		disconnectTimers.set(
			timerKey,
			setTimeout(() => {
				disconnectTimers.delete(timerKey);
				cleanupTokensForRole(roomId, role);
				destroyRoom(roomId, isHost, io);
			}, RECONNECT_GRACE_MS)
		);
		return;
	}

	if (!session) {
		if (isHost) {
			cleanupTokensForRole(roomId, 'host');
			cleanupTokensForRole(roomId, 'guest');
			rooms.delete(roomId);
			io.to(roomId).emit('roomClosed');
			io.in(roomId).socketsLeave(roomId);
		} else {
			cleanupTokensForRole(roomId, 'guest');
			room.guestId = null;
			room.guestReady = false;
			io.to(roomId).emit('roomUpdated', room);
		}
		broadcastRoomList(io);
	}
}

function destroyRoom(
	roomId: string,
	disconnectedIsHost: boolean,
	io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>
) {
	const session = sessions.get(roomId);
	if (session) {
		session.stop();
		sessions.delete(roomId);
	}

	const room = rooms.get(roomId);
	if (!room) return;

	if (disconnectedIsHost) {
		cleanupTokensForRole(roomId, 'host');
		cleanupTokensForRole(roomId, 'guest');
		rooms.delete(roomId);
		io.to(roomId).emit('roomClosed');
		io.in(roomId).socketsLeave(roomId);
	} else {
		cleanupTokensForRole(roomId, 'guest');
		if (session) {
			session.stop();
			rooms.delete(roomId);
			io.to(roomId).emit('roomClosed');
			io.in(roomId).socketsLeave(roomId);
		} else {
			room.guestId = null;
			room.guestReady = false;
			io.to(roomId).emit('roomUpdated', room);
		}
	}
	broadcastRoomList(io);
}

function cleanupTokensForRole(roomId: string, role: 'host' | 'guest') {
	const tokens = roomTokens.get(roomId);
	if (!tokens) return;

	if (role === 'host') {
		tokenToRoom.delete(tokens.hostToken);
		if (tokens.guestToken) tokenToRoom.delete(tokens.guestToken);
		roomTokens.delete(roomId);
	} else {
		if (tokens.guestToken) {
			tokenToRoom.delete(tokens.guestToken);
			tokens.guestToken = null;
		}
	}
}
