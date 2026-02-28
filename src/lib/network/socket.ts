import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types.js';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION_KEY = 'airhockey_session';

export interface SessionInfo {
	roomId: string;
	role: 'host' | 'guest';
	token: string;
}

let socket: GameSocket | null = null;

export function getSocket(): GameSocket {
	if (!socket) {
		socket = io({ autoConnect: false });
	}
	return socket;
}

export function connectSocket(): GameSocket {
	const s = getSocket();
	if (!s.connected) {
		s.connect();
	}
	return s;
}

export function disconnectSocket() {
	if (socket?.connected) {
		socket.disconnect();
	}
}

export function saveSession(info: SessionInfo) {
	try {
		sessionStorage.setItem(SESSION_KEY, JSON.stringify(info));
	} catch {
		// sessionStorage unavailable
	}
}

export function loadSession(): SessionInfo | null {
	try {
		const raw = sessionStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as SessionInfo;
	} catch {
		return null;
	}
}

export function clearSession() {
	try {
		sessionStorage.removeItem(SESSION_KEY);
	} catch {
		// ignore
	}
}
