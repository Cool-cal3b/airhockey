import type { GameSocket } from './socket.js';
import type {
	GameMessage,
	GameState,
	PaddleInput,
	PlayerRole,
	ReliableGameEvent,
	TransportMode
} from './types.js';
import { getDirectPeer, type DirectPeer } from './webrtc.js';
import { GameSession } from '$lib/game/game-session.js';

export interface GameTransport {
	readonly mode: TransportMode;
	sendInput(input: PaddleInput): void;
	sendSnapshot(state: GameState): void;
	sendReliable(event: ReliableGameEvent): void;
	onMessage(callback: (message: GameMessage) => void): () => void;
	getClockOffset(): number | null;
	getDiagnostics(): { rttMs: number | null; jitterMs: number | null; clockOffsetMs: number | null };
	close(): void;
}

type MessageListener = (message: GameMessage) => void;

abstract class BaseTransport implements GameTransport {
	abstract readonly mode: TransportMode;
	protected listeners = new Set<MessageListener>();

	abstract sendInput(input: PaddleInput): void;
	abstract sendSnapshot(state: GameState): void;
	abstract sendReliable(event: ReliableGameEvent): void;
	abstract getClockOffset(): number | null;
	abstract getDiagnostics(): { rttMs: number | null; jitterMs: number | null; clockOffsetMs: number | null };
	abstract close(): void;

	onMessage(callback: MessageListener) {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	protected dispatch(message: GameMessage) {
		for (const listener of this.listeners) listener(message);
	}
}

export class SocketGameTransport extends BaseTransport {
	readonly mode = 'server' as const;
	private clockOffset: number | null = null;
	private syncTimer: ReturnType<typeof setInterval> | null = null;
	private samples: Array<{ rtt: number; offset: number }> = [];

	constructor(private socket: GameSocket, private role: PlayerRole) {
		super();
		socket.on('gameState', this.onState);
		socket.on('countdown', this.onCountdown);
		socket.on('goalScored', this.onGoal);
		socket.on('gameOver', this.onGameOver);
		this.syncClock();
		this.syncTimer = setInterval(() => this.syncClock(), 5_000);
	}

	private onState = (state: GameState) => this.dispatch({ type: 'snapshot', state });
	private onCountdown = ({ seconds }: { seconds: number }) =>
		this.dispatch({ type: 'event', event: { type: 'countdown', seconds } });
	private onGoal = ({ scorer }: { scorer: PlayerRole }) =>
		this.dispatch({ type: 'event', event: { type: 'goal', scorer } });
	private onGameOver = (data: { winner: PlayerRole; hostScore: number; guestScore: number }) =>
		this.dispatch({ type: 'event', event: { type: 'gameOver', ...data } });

	private syncClock() {
		const sentAt = performance.now();
		this.socket.emit('timeSync', ({ serverTime }) => {
			const receivedAt = performance.now();
			const rtt = receivedAt - sentAt;
			this.samples.push({ rtt, offset: (sentAt + receivedAt) / 2 - serverTime });
			this.samples = this.samples.slice(-12);
			const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
			this.clockOffset = best.reduce((sum, sample) => sum + sample.offset, 0) / best.length;
		});
	}

	sendInput(input: PaddleInput) {
		this.socket.volatile.emit('paddleMove', input);
	}

	// Only an authority sends these. The VPS owns authority for this transport.
	sendSnapshot(_state: GameState) {}
	sendReliable(_event: ReliableGameEvent) {}
	getClockOffset() { return this.clockOffset; }
	getDiagnostics() {
		const rtts = this.samples.map((sample) => sample.rtt);
		const mean = rtts.length ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : null;
		const jitter = mean === null
			? null
			: Math.sqrt(rtts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rtts.length);
		return { rttMs: mean, jitterMs: jitter, clockOffsetMs: this.clockOffset };
	}

	close() {
		this.socket.off('gameState', this.onState);
		this.socket.off('countdown', this.onCountdown);
		this.socket.off('goalScored', this.onGoal);
		this.socket.off('gameOver', this.onGameOver);
		if (this.syncTimer) clearInterval(this.syncTimer);
		this.syncTimer = null;
	}
}

export class WebRTCGameTransport extends BaseTransport {
	readonly mode = 'direct' as const;
	private session: GameSession | null = null;
	private clockOffset: number | null;
	private clockTimer: ReturnType<typeof setInterval> | null = null;
	private startTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingPings = new Map<number, number>();
	private nextPing = 0;
	private rttSamples: number[] = [];
	private removeRealtime: () => void;
	private removeReliable: () => void;

	constructor(
		private peer: DirectPeer,
		private role: PlayerRole,
		maxScore: number
	) {
		super();
		this.clockOffset = role === 'host' ? 0 : null;
		this.removeRealtime = peer.onRealtime((data) => this.receive(data));
		this.removeReliable = peer.onReliable((data) => this.receive(data));

		if (role === 'host') {
			this.session = new GameSession(maxScore, {
				onStateUpdate: (state) => this.sendSnapshot(state),
				onCountdown: (seconds) => this.sendReliable({ type: 'countdown', seconds }),
				onGoalScored: (scorer) => this.sendReliable({ type: 'goal', scorer }),
				onGameOver: (winner, hostScore, guestScore) =>
					this.sendReliable({ type: 'gameOver', winner, hostScore, guestScore })
			});
			// Both clients navigate after the server's mode decision. Give the guest
			// time to attach its reliable-channel listeners before countdown begins.
			this.startTimer = setTimeout(() => this.session?.start(), 500);
		} else {
			this.syncClock();
			this.clockTimer = setInterval(() => this.syncClock(), 5_000);
		}
	}

	private receive(data: unknown) {
		if (!data || typeof data !== 'object') return;
		const message = data as Record<string, unknown>;
		if (message.kind === 'input' && this.role === 'host' && this.session) {
			const input = message.input as PaddleInput;
			if (Number.isFinite(input?.x) && Number.isFinite(input?.y) && Number.isFinite(input?.sequence)) {
				this.session.setPaddlePosition(false, input.x, input.y, input.sequence);
			}
			return;
		}
		if (message.kind === 'snapshot' && this.role === 'guest') {
			this.dispatch({ type: 'snapshot', state: message.state as GameState });
			return;
		}
		if (message.kind === 'event' && this.role === 'guest') {
			this.dispatch({ type: 'event', event: message.event as ReliableGameEvent });
			return;
		}
		if (message.kind === 'clockPing' && this.role === 'host') {
			this.peer.sendReliable({
				kind: 'clockPong',
				id: message.id,
				authorityTime: performance.now()
			});
			return;
		}
		if (message.kind === 'clockPong' && this.role === 'guest') {
			const id = Number(message.id);
			const sentAt = this.pendingPings.get(id);
			if (sentAt === undefined) return;
			this.pendingPings.delete(id);
			const receivedAt = performance.now();
			this.rttSamples.push(receivedAt - sentAt);
			this.rttSamples = this.rttSamples.slice(-12);
			this.clockOffset = (sentAt + receivedAt) / 2 - Number(message.authorityTime);
		}
	}

	private syncClock() {
		const id = ++this.nextPing;
		this.pendingPings.set(id, performance.now());
		this.peer.sendReliable({ kind: 'clockPing', id });
	}

	sendInput(input: PaddleInput) {
		if (this.role === 'host' && this.session) {
			this.session.setPaddlePosition(true, input.x, input.y, input.sequence);
		} else {
			this.peer.sendRealtime({ kind: 'input', input });
		}
	}

	sendSnapshot(state: GameState) {
		if (this.role !== 'host') return;
		this.dispatch({ type: 'snapshot', state });
		this.peer.sendRealtime({ kind: 'snapshot', state });
	}

	sendReliable(event: ReliableGameEvent) {
		if (this.role !== 'host') return;
		this.dispatch({ type: 'event', event });
		this.peer.sendReliable({ kind: 'event', event });
	}

	getClockOffset() { return this.clockOffset; }
	getDiagnostics() {
		const mean = this.rttSamples.length
			? this.rttSamples.reduce((sum, value) => sum + value, 0) / this.rttSamples.length
			: this.role === 'host' ? 0 : null;
		const jitter = mean === null
			? null
			: Math.sqrt(this.rttSamples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(this.rttSamples.length, 1));
		return { rttMs: mean, jitterMs: jitter, clockOffsetMs: this.clockOffset };
	}

	close() {
		this.session?.stop();
		this.session = null;
		this.removeRealtime();
		this.removeReliable();
		if (this.clockTimer) clearInterval(this.clockTimer);
		this.clockTimer = null;
		if (this.startTimer) clearTimeout(this.startTimer);
		this.startTimer = null;
	}
}

let activeTransport: GameTransport | null = null;

export function createGameTransport(
	socket: GameSocket,
	mode: TransportMode,
	role: PlayerRole,
	maxScore: number
): GameTransport {
	activeTransport?.close();
	if (mode === 'direct') {
		const peer = getDirectPeer();
		if (!peer?.isReady()) throw new Error('Direct transport was selected before WebRTC was ready');
		activeTransport = new WebRTCGameTransport(peer, role, maxScore);
	} else {
		activeTransport = new SocketGameTransport(socket, role);
	}
	return activeTransport;
}

export function closeGameTransport() {
	activeTransport?.close();
	activeTransport = null;
}
