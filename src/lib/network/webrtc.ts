import type { GameSocket } from './socket.js';
import type { PlayerRole, RtcSignal } from './types.js';

type DataListener = (data: unknown) => void;

export class DirectPeer {
	private connection: RTCPeerConnection;
	private realtime: RTCDataChannel | null = null;
	private reliable: RTCDataChannel | null = null;
	private realtimeListeners = new Set<DataListener>();
	private reliableListeners = new Set<DataListener>();
	private started = false;
	private pendingCandidates: RTCIceCandidateInit[] = [];

	constructor(
		private socket: GameSocket,
		readonly roomId: string,
		readonly role: PlayerRole
	) {
		this.connection = new RTCPeerConnection({
			iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
		});
		this.connection.onicecandidate = ({ candidate }) => {
			if (candidate) this.sendSignal({ candidate: candidate.toJSON() });
		};
		this.connection.onconnectionstatechange = () => {
			if (['failed', 'closed', 'disconnected'].includes(this.connection.connectionState)) {
				this.socket.emit('directReady', { roomId: this.roomId, ready: false });
			}
		};
		this.connection.ondatachannel = ({ channel }) => this.attachChannel(channel);
		this.socket.on('rtcSignal', this.onSignal);
	}

	async start() {
		if (this.started || this.role !== 'host') return;
		this.started = true;
		this.attachChannel(this.connection.createDataChannel('realtime', {
			ordered: false,
			maxRetransmits: 0
		}));
		this.attachChannel(this.connection.createDataChannel('reliable', { ordered: true }));
		const offer = await this.connection.createOffer();
		await this.connection.setLocalDescription(offer);
		this.sendSignal({ description: offer });
	}

	private sendSignal(signal: RtcSignal) {
		this.socket.emit('rtcSignal', { roomId: this.roomId, signal });
	}

	private onSignal = async ({ signal }: { signal: RtcSignal }) => {
		try {
			if ('description' in signal) {
				await this.connection.setRemoteDescription(signal.description);
				for (const candidate of this.pendingCandidates.splice(0)) {
					await this.connection.addIceCandidate(candidate);
				}
				if (signal.description.type === 'offer') {
					const answer = await this.connection.createAnswer();
					await this.connection.setLocalDescription(answer);
					this.sendSignal({ description: answer });
				}
			} else if (signal.candidate) {
				if (this.connection.remoteDescription) {
					await this.connection.addIceCandidate(signal.candidate);
				} else {
					this.pendingCandidates.push(signal.candidate);
				}
			}
		} catch (error) {
			console.warn('WebRTC signaling failed; the match can use server fallback.', error);
			this.socket.emit('directReady', { roomId: this.roomId, ready: false });
		}
	};

	private attachChannel(channel: RTCDataChannel) {
		if (channel.label === 'realtime') this.realtime = channel;
		if (channel.label === 'reliable') this.reliable = channel;
		channel.onopen = () => this.reportReady();
		channel.onclose = () => this.socket.emit('directReady', { roomId: this.roomId, ready: false });
		channel.onmessage = ({ data }) => {
			try {
				const parsed = JSON.parse(String(data));
				const listeners = channel.label === 'realtime' ? this.realtimeListeners : this.reliableListeners;
				for (const listener of listeners) listener(parsed);
			} catch {
				// Ignore malformed peer messages.
			}
		};
	}

	private reportReady() {
		if (this.isReady()) this.socket.emit('directReady', { roomId: this.roomId, ready: true });
	}

	isReady() {
		return this.realtime?.readyState === 'open' && this.reliable?.readyState === 'open';
	}

	sendRealtime(data: unknown) {
		if (this.realtime?.readyState === 'open') this.realtime.send(JSON.stringify(data));
	}

	sendReliable(data: unknown) {
		if (this.reliable?.readyState === 'open') this.reliable.send(JSON.stringify(data));
	}

	onRealtime(listener: DataListener) {
		this.realtimeListeners.add(listener);
		return () => this.realtimeListeners.delete(listener);
	}

	onReliable(listener: DataListener) {
		this.reliableListeners.add(listener);
		return () => this.reliableListeners.delete(listener);
	}

	close() {
		this.socket.emit('directReady', { roomId: this.roomId, ready: false });
		this.socket.off('rtcSignal', this.onSignal);
		this.realtime?.close();
		this.reliable?.close();
		this.connection.close();
	}
}

let directPeer: DirectPeer | null = null;

export function prepareDirectPeer(socket: GameSocket, roomId: string, role: PlayerRole) {
	if (directPeer && (directPeer.roomId !== roomId || directPeer.role !== role)) {
		directPeer.close();
		directPeer = null;
	}
	if (!directPeer) directPeer = new DirectPeer(socket, roomId, role);
	return directPeer;
}

export function getDirectPeer() { return directPeer; }

export function closeDirectPeer() {
	directPeer?.close();
	directPeer = null;
}
