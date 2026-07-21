import Phaser from 'phaser';
import {
	RINK_WIDTH,
	RINK_HEIGHT,
	CANVAS_PADDING,
	PADDLE_RADIUS,
	PUCK_RADIUS,
	GOAL_WIDTH,
	CENTER_CIRCLE_RADIUS,
	CORNER_RADIUS,
	GOAL_X_MIN,
	GOAL_X_MAX,
	PADDLE_MAX_SPEED,
	PUCK_MAX_SPEED,
	TICK_MS,
	INPUT_MS
} from '../constants.js';
import { clampPaddleToHalf, stepPuck } from '../physics.js';
import { PointerInput } from '../input.js';
import type { GameSocket } from '$lib/network/socket.js';
import type { GameState } from '$lib/network/types.js';

function hexToNum(hex: string): number {
	return parseInt(hex.replace('#', ''), 16);
}

type InterpFrame = {
	from: GameState;
	to: GameState;
	t: number;
	extrapolationMs: number;
};

export class PlayScene extends Phaser.Scene {
	private socket!: GameSocket;
	private isHost!: boolean;
	private pointerInput!: PointerInput;
	private hostColorNum = 0x00d4ff;
	private guestColorNum = 0xff2d7b;

	private puckSprite!: Phaser.GameObjects.Arc;
	private puckGlow!: Phaser.GameObjects.Arc;
	private hostPaddleSprite!: Phaser.GameObjects.Arc;
	private hostPaddleGlow!: Phaser.GameObjects.Arc;
	private hostPaddleRing!: Phaser.GameObjects.Arc;
	private guestPaddleSprite!: Phaser.GameObjects.Arc;
	private guestPaddleGlow!: Phaser.GameObjects.Arc;
	private guestPaddleRing!: Phaser.GameObjects.Arc;

	private countdownText!: Phaser.GameObjects.Text;
	private goalText!: Phaser.GameObjects.Text;

	private snapshotBuffer: Array<{ receivedAt: number; state: GameState }> = [];
	private readonly INTERP_DELAY_MS = 50;
	private readonly MAX_EXTRAPOLATION_MS = 50;
	private readonly MAX_BUFFER_MS = 500;
	private serverClockOffset: number | null = null;
	private lastSequence = -1;

	private localPaddle = { x: 0, y: 0 };
	private lastFrameTime = 0;
	private lastPaddleSendTime = 0;
	private prevStatus: GameState['status'] | null = null;
	private graceUntil = 0;

	// Client-side puck prediction. Each frame the puck is re-simulated from the latest
	// authoritative snapshot up to "now" using our recorded paddle history, so our own
	// strikes register instantly instead of after a full network round-trip. The replay
	// is deterministic and stateless per frame (no drift), and reconciles automatically
	// as new snapshots arrive.
	private puckRenderX = RINK_WIDTH / 2;
	private puckRenderY = RINK_HEIGHT / 2;
	private predPrevX = RINK_WIDTH / 2;
	private predPrevY = RINK_HEIGHT / 2;
	private predictedVx = 0;
	private predictedVy = 0;
	private puckInitialized = false;
	private paddleHistory: Array<{ t: number; x: number; y: number }> = [];
	private readonly MAX_REPLAY_MS = 250;
	private readonly PADDLE_HISTORY_MS = 600;

	// Screen-shake feedback on strikes and goals.
	private wasTouchingPuck = false;
	private lastShakeAt = 0;
	private reducedMotion = false;

	private scoreCallback?: (host: number, guest: number) => void;
	private statusCallback?: (status: GameState['status']) => void;
	private elapsedCallback?: (ms: number) => void;

	// Cached UI values so reactive Svelte updates only fire when a value changes.
	private lastUiHostScore = -1;
	private lastUiGuestScore = -1;
	private lastUiStatus: GameState['status'] | null = null;
	private lastUiElapsedSecond = -1;

	// Dev-only realtime diagnostics, logged once per second.
	private diagnostics = {
		received: 0,
		missingSequences: 0,
		extrapolatedFrames: 0,
		largestArrivalGap: 0,
		lastArrivalAt: 0
	};
	private lastDiagnosticsLogAt = 0;

	constructor() {
		super({ key: 'PlayScene' });
	}

	init(data: {
		socket: GameSocket;
		isHost: boolean;
		onScore: (host: number, guest: number) => void;
		onStatus: (status: GameState['status']) => void;
		onElapsed: (ms: number) => void;
		hostColor: string;
		guestColor: string;
	}) {
		this.socket = data.socket;
		this.isHost = data.isHost;
		this.scoreCallback = data.onScore;
		this.statusCallback = data.onStatus;
		this.elapsedCallback = data.onElapsed;
		this.hostColorNum = hexToNum(data.hostColor);
		this.guestColorNum = hexToNum(data.guestColor);

		this.localPaddle = this.isHost
			? { x: RINK_WIDTH / 2, y: RINK_HEIGHT - 80 }
			: { x: RINK_WIDTH / 2, y: 80 };
	}

	create() {
		this.cameras.main.setScroll(-CANVAS_PADDING, -CANVAS_PADDING);

		// The server simulates in canonical coordinates: the host defends the bottom
		// goal, the guest defends the top. Rendered as-is, the guest would always play
		// from the top — a harder, unnatural viewpoint. The camera's rotation pivot is
		// the rink center (200, 350), so rotating the guest's camera 180° maps every
		// point (x, y) -> (RINK_WIDTH - x, RINK_HEIGHT - y), putting the guest's own
		// paddle and goal at the bottom of *their* screen. Networking stays canonical;
		// only this client's view flips.
		if (!this.isHost) {
			this.cameras.main.setRotation(Math.PI);
		}

		this.pointerInput = new PointerInput(RINK_WIDTH, RINK_HEIGHT, CANVAS_PADDING);
		this.pointerInput.attach(this.game.canvas);
		this.lastFrameTime = performance.now();

		this.reducedMotion =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

		this.drawRink();
		this.createEntities();
		this.createOverlayText();
		this.setupSocketListeners();
	}

	private drawRink() {
		const g = this.add.graphics();

		g.fillStyle(0x0d1b2a);
		g.fillRoundedRect(0, 0, RINK_WIDTH, RINK_HEIGHT, CORNER_RADIUS);
		g.lineStyle(3, 0x1b3a5c);
		g.strokeRoundedRect(0, 0, RINK_WIDTH, RINK_HEIGHT, CORNER_RADIUS);

		g.lineStyle(2, 0x1b3a5c);
		const dashLength = 8;
		const gapLength = 6;
		const y = RINK_HEIGHT / 2;
		let x = 0;
		while (x < RINK_WIDTH) {
			const end = Math.min(x + dashLength, RINK_WIDTH);
			g.beginPath();
			g.moveTo(x, y);
			g.lineTo(end, y);
			g.strokePath();
			x += dashLength + gapLength;
		}

		g.lineStyle(2, 0x1b3a5c);
		g.strokeCircle(RINK_WIDTH / 2, RINK_HEIGHT / 2, CENTER_CIRCLE_RADIUS);

		g.fillStyle(0x1b3a5c);
		g.fillCircle(RINK_WIDTH / 2, RINK_HEIGHT / 2, 4);

		g.fillStyle(this.guestColorNum, 0.8);
		g.fillRoundedRect(GOAL_X_MIN, 0, GOAL_WIDTH, 6, 3);

		g.fillStyle(this.hostColorNum, 0.8);
		g.fillRoundedRect(GOAL_X_MIN, RINK_HEIGHT - 6, GOAL_WIDTH, 6, 3);

		const creaseSteps = 20;
		g.lineStyle(1, this.guestColorNum, 0.3);
		g.beginPath();
		g.moveTo(GOAL_X_MIN, 0);
		for (let i = 1; i <= creaseSteps; i++) {
			const t = i / creaseSteps;
			const cx = RINK_WIDTH / 2;
			const cy = 50;
			const startX = GOAL_X_MIN;
			const endX = GOAL_X_MAX;
			const px = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cx + t * t * endX;
			const py = (1 - t) * (1 - t) * 0 + 2 * (1 - t) * t * cy + t * t * 0;
			g.lineTo(px, py);
		}
		g.strokePath();

		g.lineStyle(1, this.hostColorNum, 0.3);
		g.beginPath();
		g.moveTo(GOAL_X_MIN, RINK_HEIGHT);
		for (let i = 1; i <= creaseSteps; i++) {
			const t = i / creaseSteps;
			const cx = RINK_WIDTH / 2;
			const cy = RINK_HEIGHT - 50;
			const startX = GOAL_X_MIN;
			const endX = GOAL_X_MAX;
			const px = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cx + t * t * endX;
			const py = (1 - t) * (1 - t) * RINK_HEIGHT + 2 * (1 - t) * t * cy + t * t * RINK_HEIGHT;
			g.lineTo(px, py);
		}
		g.strokePath();
	}

	private createEntities() {
		const hc = this.hostColorNum;
		const gc = this.guestColorNum;

		this.hostPaddleGlow = this.add.circle(RINK_WIDTH / 2, RINK_HEIGHT - 80, PADDLE_RADIUS + 15, hc, 0.15);
		this.hostPaddleSprite = this.add.circle(RINK_WIDTH / 2, RINK_HEIGHT - 80, PADDLE_RADIUS, 0x0a1628);
		this.hostPaddleSprite.setStrokeStyle(3, hc);
		this.hostPaddleRing = this.add.circle(RINK_WIDTH / 2, RINK_HEIGHT - 80, PADDLE_RADIUS * 0.4);
		this.hostPaddleRing.setStrokeStyle(1.5, hc, 0.5);
		this.hostPaddleRing.setFillStyle();

		this.guestPaddleGlow = this.add.circle(RINK_WIDTH / 2, 80, PADDLE_RADIUS + 15, gc, 0.15);
		this.guestPaddleSprite = this.add.circle(RINK_WIDTH / 2, 80, PADDLE_RADIUS, 0x0a1628);
		this.guestPaddleSprite.setStrokeStyle(3, gc);
		this.guestPaddleRing = this.add.circle(RINK_WIDTH / 2, 80, PADDLE_RADIUS * 0.4);
		this.guestPaddleRing.setStrokeStyle(1.5, gc, 0.5);
		this.guestPaddleRing.setFillStyle();

		this.puckGlow = this.add.circle(RINK_WIDTH / 2, RINK_HEIGHT / 2, PUCK_RADIUS + 10, 0xffffff, 0.12);
		this.puckSprite = this.add.circle(RINK_WIDTH / 2, RINK_HEIGHT / 2, PUCK_RADIUS, 0xe0e0f0);
		this.puckSprite.setStrokeStyle(1.5, 0xffffff);
	}

	private createOverlayText() {
		this.countdownText = this.add.text(RINK_WIDTH / 2, RINK_HEIGHT / 2, '', {
			fontFamily: 'Orbitron, sans-serif',
			fontSize: '72px',
			color: '#ffffff',
			align: 'center'
		}).setOrigin(0.5).setAlpha(0);

		this.goalText = this.add.text(RINK_WIDTH / 2, RINK_HEIGHT / 2, 'GOAL!', {
			fontFamily: 'Orbitron, sans-serif',
			fontSize: '48px',
			color: '#00ff88',
			align: 'center'
		}).setOrigin(0.5).setAlpha(0);

		// These sit on the camera's rotation pivot, so the guest's 180° camera flip would
		// render them upside down. Counter-rotate to keep the text readable for both players.
		if (!this.isHost) {
			this.countdownText.setRotation(Math.PI);
			this.goalText.setRotation(Math.PI);
		}
	}

	private setupSocketListeners() {
		this.socket.on('gameState', this.onGameState);
		this.socket.on('countdown', this.onCountdown);
		this.socket.on('goalScored', this.onGoalScored);
	}

	private onGameState = (state: GameState) => {
		// Discard old or duplicated snapshots (volatile transport may reorder).
		if (state.sequence <= this.lastSequence) return;

		const now = performance.now();

		if (this.lastSequence >= 0 && state.sequence > this.lastSequence + 1) {
			this.diagnostics.missingSequences += state.sequence - this.lastSequence - 1;
		}
		if (this.diagnostics.lastArrivalAt > 0) {
			const gap = now - this.diagnostics.lastArrivalAt;
			this.diagnostics.largestArrivalGap = Math.max(this.diagnostics.largestArrivalGap, gap);
		}
		this.diagnostics.lastArrivalAt = now;
		this.diagnostics.received++;

		this.lastSequence = state.sequence;

		// The smallest observed offset is the sample least inflated by network delay.
		const offsetSample = now - state.serverTime;
		if (this.serverClockOffset === null || offsetSample < this.serverClockOffset) {
			this.serverClockOffset = offsetSample;
		}

		this.snapshotBuffer.push({ receivedAt: now, state });

		const cutoffServerTime = state.serverTime - this.MAX_BUFFER_MS;
		while (
			this.snapshotBuffer.length > 2 &&
			this.snapshotBuffer[0].state.serverTime < cutoffServerTime
		) {
			this.snapshotBuffer.shift();
		}

		// Only push reactive UI updates when a displayed value actually changes.
		if (state.score.host !== this.lastUiHostScore || state.score.guest !== this.lastUiGuestScore) {
			this.lastUiHostScore = state.score.host;
			this.lastUiGuestScore = state.score.guest;
			this.scoreCallback?.(state.score.host, state.score.guest);
		}

		if (state.status !== this.lastUiStatus) {
			this.lastUiStatus = state.status;
			this.statusCallback?.(state.status);
		}

		const elapsedSecond = Math.floor(state.elapsedMs / 1000);
		if (elapsedSecond !== this.lastUiElapsedSecond) {
			this.lastUiElapsedSecond = elapsedSecond;
			this.elapsedCallback?.(state.elapsedMs);
		}
	};

	private onCountdown = (data: { seconds: number }) => {
		this.countdownText.setText(String(data.seconds));
		this.countdownText.setAlpha(1);
		this.tweens.add({
			targets: this.countdownText,
			scaleX: 1.5,
			scaleY: 1.5,
			alpha: 0,
			duration: 800,
			ease: 'Power2',
			onComplete: () => {
				this.countdownText.setScale(1);
			}
		});
	};

	private onGoalScored = () => {
		if (!this.reducedMotion) {
			this.cameras.main.shake(280, 0.012);
		}
		this.goalText.setAlpha(1).setScale(0.5);
		this.tweens.add({
			targets: this.goalText,
			scaleX: 1.2,
			scaleY: 1.2,
			alpha: 0,
			duration: 1200,
			ease: 'Power2'
		});
	};

	// The guest's camera is rotated 180°, so their raw pointer (which the browser reports
	// in unrotated canvas space) is mirrored relative to the canonical simulation. Undo the
	// flip so paddle clamping and the coordinates sent to the server stay in canonical space.
	private readPointerCanonical(): { x: number; y: number } {
		if (this.isHost) {
			return { x: this.pointerInput.x, y: this.pointerInput.y };
		}
		return { x: RINK_WIDTH - this.pointerInput.x, y: RINK_HEIGHT - this.pointerInput.y };
	}

	private pushOutOfCenter(x: number, y: number): { x: number; y: number } {
		const cx = RINK_WIDTH / 2;
		const cy = RINK_HEIGHT / 2;
		const exclusion = CENTER_CIRCLE_RADIUS + PADDLE_RADIUS + 2;
		const dx = x - cx;
		const dy = y - cy;
		const dist = Math.sqrt(dx * dx + dy * dy);

		if (dist >= exclusion) return { x, y };
		if (dist === 0) {
			return { x, y: this.isHost ? cy + exclusion : cy - exclusion };
		}
		return {
			x: cx + (dx / dist) * exclusion,
			y: cy + (dy / dist) * exclusion
		};
	}

	private getInterpFrame(now: number): InterpFrame | null {
		const buffer = this.snapshotBuffer;
		if (buffer.length === 0 || this.serverClockOffset === null) return null;

		// Convert the local monotonic clock into estimated server simulation time.
		const renderServerTime = now - this.serverClockOffset - this.INTERP_DELAY_MS;
		const first = buffer[0].state;
		const latest = buffer[buffer.length - 1].state;

		if (renderServerTime <= first.serverTime) {
			return { from: first, to: first, t: 0, extrapolationMs: 0 };
		}

		if (renderServerTime >= latest.serverTime) {
			return {
				from: latest,
				to: latest,
				t: 0,
				extrapolationMs: Math.min(
					renderServerTime - latest.serverTime,
					this.MAX_EXTRAPOLATION_MS
				)
			};
		}

		for (let i = buffer.length - 1; i > 0; i--) {
			const previous = buffer[i - 1].state;
			const current = buffer[i].state;

			if (previous.serverTime <= renderServerTime && renderServerTime <= current.serverTime) {
				const span = current.serverTime - previous.serverTime;
				const t = span > 0 ? (renderServerTime - previous.serverTime) / span : 0;
				return { from: previous, to: current, t, extrapolationMs: 0 };
			}
		}

		return { from: latest, to: latest, t: 0, extrapolationMs: 0 };
	}

	private lerpPuck(frame: InterpFrame) {
		// Short extrapolation covers late snapshots so the puck keeps moving.
		if (frame.extrapolationMs > 0 && frame.to.status === 'playing') {
			const seconds = frame.extrapolationMs / 1000;
			return {
				x: frame.to.puck.x + frame.to.puck.vx * seconds,
				y: frame.to.puck.y + frame.to.puck.vy * seconds
			};
		}

		// Status boundaries (goal reset, countdown end) teleport the puck — snap instead of lerping.
		if (frame.from.status !== frame.to.status) {
			return { x: frame.to.puck.x, y: frame.to.puck.y };
		}
		return {
			x: frame.from.puck.x + (frame.to.puck.x - frame.from.puck.x) * frame.t,
			y: frame.from.puck.y + (frame.to.puck.y - frame.from.puck.y) * frame.t
		};
	}

	private lerpOpponent(frame: InterpFrame) {
		const from = this.isHost ? frame.from.guestPaddle : frame.from.hostPaddle;
		const to = this.isHost ? frame.to.guestPaddle : frame.to.hostPaddle;
		if (frame.from.status !== frame.to.status) {
			return { x: to.x, y: to.y };
		}
		return {
			x: from.x + (to.x - from.x) * frame.t,
			y: from.y + (to.y - from.y) * frame.t
		};
	}

	update() {
		const now = performance.now();
		const dt = Math.min((now - this.lastFrameTime) / 1000, 0.05);
		this.lastFrameTime = now;

		if (this.snapshotBuffer.length === 0) return;

		const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1].state;
		const frame = this.getInterpFrame(now);
		if (!frame) return;

		if (frame.extrapolationMs > 0) this.diagnostics.extrapolatedFrames++;
		if (import.meta.env.DEV) this.logDiagnostics(now);

		if (this.prevStatus !== null && this.prevStatus !== 'playing' && latest.status === 'playing') {
			this.graceUntil = now + TICK_MS * 12;
		}
		this.prevStatus = latest.status;

		const useServerPosition = latest.status === 'goal' || latest.status === 'countdown' || latest.status === 'paused';
		const inGrace = now < this.graceUntil;

		if (this.pointerInput.active && !useServerPosition) {
			const pointer = this.readPointerCanonical();
			let target = clampPaddleToHalf(pointer.x, pointer.y, this.isHost);
			if (inGrace) {
				target = this.pushOutOfCenter(target.x, target.y);
			}

			const dx = target.x - this.localPaddle.x;
			const dy = target.y - this.localPaddle.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const maxDist = PADDLE_MAX_SPEED * dt;

			if (dist <= maxDist || dist === 0) {
				this.localPaddle.x = target.x;
				this.localPaddle.y = target.y;
			} else {
				const scale = maxDist / dist;
				this.localPaddle.x += dx * scale;
				this.localPaddle.y += dy * scale;
			}

			let clamped = clampPaddleToHalf(this.localPaddle.x, this.localPaddle.y, this.isHost);
			if (inGrace) {
				clamped = this.pushOutOfCenter(clamped.x, clamped.y);
			}
			this.localPaddle.x = clamped.x;
			this.localPaddle.y = clamped.y;

			if (now - this.lastPaddleSendTime >= INPUT_MS) {
				this.lastPaddleSendTime = now;
				this.socket.volatile.emit('paddleMove', {
					x: this.localPaddle.x,
					y: this.localPaddle.y
				});
			}
		}

		const myServerPos = this.isHost ? latest.hostPaddle : latest.guestPaddle;
		const useLocal = this.pointerInput.active && !useServerPosition;
		const myX = useLocal ? this.localPaddle.x : myServerPos.x;
		const myY = useLocal ? this.localPaddle.y : myServerPos.y;

		// Record where our paddle is (in server-time) so prediction replay can re-apply
		// our strikes on top of each authoritative snapshot.
		if (this.serverClockOffset !== null) {
			this.recordPaddle(now - this.serverClockOffset, myX, myY);
		}

		const puckVisible = latest.status === 'playing' || latest.status === 'countdown' || latest.status === 'paused';
		this.puckSprite.setVisible(puckVisible);
		this.puckGlow.setVisible(puckVisible);

		if (latest.status === 'playing' && this.serverClockOffset !== null) {
			const predicted = this.predictPuck(now, latest);

			const divX = predicted.x - this.puckRenderX;
			const divY = predicted.y - this.puckRenderY;
			if (!this.puckInitialized || divX * divX + divY * divY > 60 * 60) {
				// First frame, goal reset, or large divergence: snap.
				this.puckRenderX = predicted.x;
				this.puckRenderY = predicted.y;
			} else {
				// Feed forward the real per-frame motion (zero lag on fast shots), then
				// spring only the residual offset toward the prior target — this absorbs
				// the small discontinuity when a new snapshot re-bases the prediction
				// without dragging behind a fast-moving puck.
				const feedX = predicted.x - this.predPrevX;
				const feedY = predicted.y - this.predPrevY;
				const k = 1 - Math.exp(-dt / 0.05);
				this.puckRenderX += feedX + (this.predPrevX - this.puckRenderX) * k;
				this.puckRenderY += feedY + (this.predPrevY - this.puckRenderY) * k;
			}
			this.predPrevX = predicted.x;
			this.predPrevY = predicted.y;
			this.predictedVx = predicted.vx;
			this.predictedVy = predicted.vy;
			this.puckInitialized = true;
			this.maybeShakeOnHit(myX, myY, now);
		} else {
			const puckPos = this.lerpPuck(frame);
			this.puckRenderX = puckPos.x;
			this.puckRenderY = puckPos.y;
			this.predPrevX = puckPos.x;
			this.predPrevY = puckPos.y;
			this.predictedVx = 0;
			this.predictedVy = 0;
			this.wasTouchingPuck = false;
			this.puckInitialized = true;
		}
		this.setPuckPosition(this.puckRenderX, this.puckRenderY);

		const oppPos = this.lerpOpponent(frame);
		if (this.isHost) {
			this.setHostPaddlePosition(myX, myY);
			this.setGuestPaddlePosition(oppPos.x, oppPos.y);
		} else {
			this.setGuestPaddlePosition(myX, myY);
			this.setHostPaddlePosition(oppPos.x, oppPos.y);
		}

		if (useServerPosition) {
			this.localPaddle.x = myServerPos.x;
			this.localPaddle.y = myServerPos.y;
		}
	}

	// Re-simulate the puck from the latest authoritative snapshot up to the present using
	// our recorded paddle history. Deterministic and stateless: the same inputs always
	// produce the same result, so there is no accumulating prediction drift.
	private predictPuck(now: number, base: GameState): { x: number; y: number; vx: number; vy: number } {
		const present = now - (this.serverClockOffset as number);
		let t = base.serverTime;
		const end = t + Math.min(Math.max(present - t, 0), this.MAX_REPLAY_MS);

		let px = base.puck.x;
		let py = base.puck.y;
		let pvx = base.puck.vx;
		let pvy = base.puck.vy;

		// Snapshots carry no paddle velocity, so hold the opponent's paddle where it was.
		// A stale opponent position self-corrects on the next snapshot.
		const oppServer = this.isHost ? base.guestPaddle : base.hostPaddle;
		const opp = { x: oppServer.x, y: oppServer.y, vx: 0, vy: 0 };

		while (end - t >= 1) {
			const stepMs = Math.min(TICK_MS, end - t);
			const stepS = stepMs / 1000;
			const p0 = this.samplePaddle(t);
			const p1 = this.samplePaddle(t + stepMs);
			const my = {
				x: p1.x,
				y: p1.y,
				vx: (p1.x - p0.x) / stepS,
				vy: (p1.y - p0.y) / stepS
			};
			const host = this.isHost ? my : opp;
			const guest = this.isHost ? opp : my;

			const r = stepPuck({ x: px, y: py, vx: pvx, vy: pvy }, host, guest, stepS);
			px = r.x;
			py = r.y;
			pvx = r.vx;
			pvy = r.vy;
			if (r.scored) break;
			t += stepMs;
		}

		return { x: px, y: py, vx: pvx, vy: pvy };
	}

	private recordPaddle(t: number, x: number, y: number) {
		const h = this.paddleHistory;
		// t should increase monotonically; if the clock estimate stalls, just update the tail.
		if (h.length > 0 && t <= h[h.length - 1].t) {
			h[h.length - 1].x = x;
			h[h.length - 1].y = y;
			return;
		}
		h.push({ t, x, y });
		const cutoff = t - this.PADDLE_HISTORY_MS;
		while (h.length > 2 && h[0].t < cutoff) h.shift();
	}

	private samplePaddle(t: number): { x: number; y: number } {
		const h = this.paddleHistory;
		if (h.length === 0) return { x: this.localPaddle.x, y: this.localPaddle.y };
		if (t <= h[0].t) return { x: h[0].x, y: h[0].y };
		const last = h[h.length - 1];
		if (t >= last.t) return { x: last.x, y: last.y };
		for (let i = h.length - 1; i > 0; i--) {
			const a = h[i - 1];
			const b = h[i];
			if (a.t <= t && t <= b.t) {
				const span = b.t - a.t;
				const f = span > 0 ? (t - a.t) / span : 0;
				return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
			}
		}
		return { x: last.x, y: last.y };
	}

	private maybeShakeOnHit(myX: number, myY: number, now: number) {
		const dx = this.puckRenderX - myX;
		const dy = this.puckRenderY - myY;
		const touching = dx * dx + dy * dy <= (PUCK_RADIUS + PADDLE_RADIUS + 3) ** 2;

		if (touching && !this.wasTouchingPuck && !this.reducedMotion && now - this.lastShakeAt > 120) {
			const speed = Math.sqrt(this.predictedVx * this.predictedVx + this.predictedVy * this.predictedVy);
			const strength = Math.min(speed / PUCK_MAX_SPEED, 1);
			// Subtle at a soft touch, punchier on a hard strike.
			this.cameras.main.shake(90, 0.003 + strength * 0.009);
			this.lastShakeAt = now;
		}
		this.wasTouchingPuck = touching;
	}

	private setPuckPosition(x: number, y: number) {
		this.puckSprite.setPosition(x, y);
		this.puckGlow.setPosition(x, y);
	}

	private setHostPaddlePosition(x: number, y: number) {
		this.hostPaddleSprite.setPosition(x, y);
		this.hostPaddleGlow.setPosition(x, y);
		this.hostPaddleRing.setPosition(x, y);
	}

	private setGuestPaddlePosition(x: number, y: number) {
		this.guestPaddleSprite.setPosition(x, y);
		this.guestPaddleGlow.setPosition(x, y);
		this.guestPaddleRing.setPosition(x, y);
	}

	private logDiagnostics(now: number) {
		if (this.lastDiagnosticsLogAt === 0) {
			this.lastDiagnosticsLogAt = now;
			return;
		}
		if (now - this.lastDiagnosticsLogAt < 1000) return;

		const d = this.diagnostics;
		// eslint-disable-next-line no-console
		console.log(
			`[net] snapshots/s=${d.received} missing=${d.missingSequences} ` +
				`extrapolatedFrames=${d.extrapolatedFrames} ` +
				`largestGap=${d.largestArrivalGap.toFixed(1)}ms interpDelay=${this.INTERP_DELAY_MS}ms`
		);

		d.received = 0;
		d.missingSequences = 0;
		d.extrapolatedFrames = 0;
		d.largestArrivalGap = 0;
		this.lastDiagnosticsLogAt = now;
	}

	shutdown() {
		this.pointerInput.detach();
		this.socket.off('gameState', this.onGameState);
		this.socket.off('countdown', this.onCountdown);
		this.socket.off('goalScored', this.onGoalScored);
	}
}
