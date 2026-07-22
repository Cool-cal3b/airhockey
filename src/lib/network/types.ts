export const NEON_COLORS = [
	{ id: 'cyan', hex: '#00d4ff', label: 'Cyan' },
	{ id: 'pink', hex: '#ff2d7b', label: 'Pink' },
	{ id: 'green', hex: '#00ff88', label: 'Green' },
	{ id: 'purple', hex: '#b44dff', label: 'Purple' },
	{ id: 'orange', hex: '#ff8c00', label: 'Orange' },
	{ id: 'yellow', hex: '#ffe600', label: 'Yellow' },
	{ id: 'red', hex: '#ff3333', label: 'Red' },
	{ id: 'lime', hex: '#aaff00', label: 'Lime' },
	{ id: 'teal', hex: '#00ffc8', label: 'Teal' },
	{ id: 'magenta', hex: '#ff00ff', label: 'Magenta' }
] as const;

export type NeonColorId = (typeof NEON_COLORS)[number]['id'];

export const RECONNECT_GRACE_MS = 30_000;
// Opening a native share sheet can suspend a mobile browser for several minutes.
// Keep waiting rooms alive long enough for the host to send the invite and return.
export const LOBBY_RECONNECT_GRACE_MS = 10 * 60_000;

export type PlayerRole = 'host' | 'guest';
export type TransportMode = 'direct' | 'server';

export interface PaddleInput {
	sequence: number;
	x: number;
	y: number;
	clientTime: number;
}

export interface PaddleState {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface RoomInfo {
	id: string;
	name: string;
	maxScore: number;
	hostId: string;
	guestId: string | null;
	hostReady: boolean;
	guestReady: boolean;
	hostName: string;
	guestName: string;
	hostColor: NeonColorId;
	guestColor: NeonColorId;
}

export interface RoomListEntry {
	id: string;
	name: string;
	maxScore: number;
	players: number;
}

export interface GameState {
	sequence: number;
	simulationTick: number;
	serverTime: number;
	puck: { x: number; y: number; vx: number; vy: number };
	hostPaddle: PaddleState;
	guestPaddle: PaddleState;
	acknowledgedInput: { host: number; guest: number };
	score: { host: number; guest: number };
	status: 'countdown' | 'playing' | 'goal' | 'ended' | 'paused';
	elapsedMs: number;
}

export type ReliableGameEvent =
	| { type: 'countdown'; seconds: number }
	| { type: 'goal'; scorer: PlayerRole }
	| { type: 'gameOver'; winner: PlayerRole; hostScore: number; guestScore: number }
	| { type: 'paused' }
	| { type: 'resumed' };

export type GameMessage =
	| { type: 'input'; role: PlayerRole; input: PaddleInput }
	| { type: 'snapshot'; state: GameState }
	| { type: 'event'; event: ReliableGameEvent };

export type RtcSignal =
	| { description: RTCSessionDescriptionInit }
	| { candidate: RTCIceCandidateInit };

export interface ClientToServerEvents {
	createRoom: (data: { name: string; maxScore: number }, callback: (room: RoomInfo, token: string) => void) => void;
	joinRoom: (data: { roomId: string }, callback: (room: RoomInfo | null, errorOrToken?: string) => void) => void;
	rejoinRoom: (data: { token: string }, callback: (room: RoomInfo | null, role?: 'host' | 'guest') => void) => void;
	getRoom: (data: { roomId: string }, callback: (room: RoomInfo | null) => void) => void;
	getMyRole: (data: { roomId: string }, callback: (role: 'host' | 'guest' | null) => void) => void;
	listRooms: (callback: (rooms: RoomListEntry[]) => void) => void;
	toggleReady: () => void;
	setName: (data: { name: string }) => void;
	setColor: (data: { color: NeonColorId }) => void;
	startGame: () => void;
	paddleMove: (data: PaddleInput) => void;
	rtcSignal: (data: { roomId: string; signal: RtcSignal }) => void;
	directPrepare: (data: { roomId: string }) => void;
	directReady: (data: { roomId: string; ready: boolean }) => void;
	timeSync: (callback: (data: { serverTime: number }) => void) => void;
	leaveRoom: () => void;
}

export interface ServerToClientEvents {
	roomUpdated: (room: RoomInfo) => void;
	roomClosed: () => void;
	roomList: (rooms: RoomListEntry[]) => void;
	gameStarted: (data: { roomId: string; mode: TransportMode }) => void;
	rtcSignal: (data: { signal: RtcSignal }) => void;
	rtcPeerReady: () => void;
	gameState: (state: GameState) => void;
	countdown: (data: { seconds: number }) => void;
	goalScored: (data: { scorer: 'host' | 'guest' }) => void;
	gameOver: (data: { winner: 'host' | 'guest'; hostScore: number; guestScore: number }) => void;
	opponentDisconnected: (data: { graceMs: number }) => void;
	opponentReconnected: () => void;
	hostDisconnected: (data: { graceMs: number }) => void;
	hostReconnected: () => void;
}
