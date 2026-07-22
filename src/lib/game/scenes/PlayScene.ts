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
	INPUT_MS,
	INTERPOLATION_DELAY_MS,
	MAX_EXTRAPOLATION_MS
} from '../constants.js';
import { clampPaddleToHalf } from '../physics.js';
import { PointerInput } from '../input.js';
import { interpolatePaddle, interpolatePuck } from '../interpolation.js';
import type { GameTransport } from '$lib/network/transport.js';
import type { GameMessage, GameState } from '$lib/network/types.js';

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
	private transport!: GameTransport;
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
	private readonly INTERP_DELAY_MS = INTERPOLATION_DELAY_MS;
	private readonly MAX_EXTRAPOLATION_MS = MAX_EXTRAPOLATION_MS;
	private readonly MAX_BUFFER_MS = 500;
	private serverClockOffset: number | null = null;
	private lastSequence = -1;

	private localPaddle = { x: 0, y: 0 };
	private lastFrameTime = 0;
	private lastPaddleSendTime = 0;
	// A time-based starting point remains monotonic across a page refresh/rejoin.
	private inputSequence = Date.now() * 100;
	private removeTransportListener: (() => void) | null = null;
	private prevStatus: GameState['status'] | null = null;
	private graceUntil = 0;

	private puckRenderX = RINK_WIDTH / 2;
	private puckRenderY = RINK_HEIGHT / 2;
	private predictedVx = 0;
	private predictedVy = 0;

	// Screen-shake feedback on strikes and goals.
	private wasTouchingPuck = false;
	private lastShakeAt = 0;
	private reducedMotion = false;

	// While a goal "pop" is playing, the tween owns the puck sprite. It is driven by the
	// reliable `goalScored` event (the single `status:'goal'` snapshot is volatile and may
	// drop), so the puck reliably disappears on a goal. Cleared when the next round
	// re-centres the puck.
	private goalPopPlaying = false;

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
		transport: GameTransport;
		isHost: boolean;
		onScore: (host: number, guest: number) => void;
		onStatus: (status: GameState['status']) => void;
		onElapsed: (ms: number) => void;
		hostColor: string;
		guestColor: string;
	}) {
		this.transport = data.transport;
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
		this.removeTransportListener = this.transport.onMessage(this.onTransportMessage);
	}

	private onTransportMessage = (message: GameMessage) => {
		if (message.type === 'snapshot') {
			this.onGameState(message.state);
			return;
		}
		if (message.type !== 'event') return;
		if (message.event.type === 'countdown') this.onCountdown({ seconds: message.event.seconds });
		if (message.event.type === 'goal') this.onGoalScored();
		if (message.event.type === 'gameOver') {
			this.scoreCallback?.(message.event.hostScore, message.event.guestScore);
			this.statusCallback?.('ended');
		}
	};

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

		this.serverClockOffset = this.transport.getClockOffset() ?? (now - state.serverTime);

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
		this.playGoalPop();
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

	// Bursts the puck at the point it went in, then hides it until the next round.
	private playGoalPop() {
		if (this.goalPopPlaying) return;
		this.goalPopPlaying = true;

		const x = this.puckRenderX;
		const y = this.puckRenderY;

		this.puckSprite.setVisible(true).setPosition(x, y).setScale(1).setAlpha(1);
		this.puckGlow.setVisible(true).setPosition(x, y).setScale(1).setAlpha(1);

		this.tweens.add({
			targets: [this.puckSprite, this.puckGlow],
			scaleX: 1.9,
			scaleY: 1.9,
			alpha: 0,
			duration: 260,
			ease: 'Quad.easeOut',
			onComplete: () => {
				this.puckSprite.setVisible(false).setScale(1).setAlpha(1);
				this.puckGlow.setVisible(false).setScale(1).setAlpha(1);
			}
		});

		// Expanding shockwave ring in the goal-flash colour.
		const ring = this.add.circle(x, y, PUCK_RADIUS);
		ring.setStrokeStyle(3, 0x00ff88, 0.9);
		ring.setFillStyle();
		this.tweens.add({
			targets: ring,
			scaleX: 3.6,
			scaleY: 3.6,
			alpha: 0,
			duration: 380,
			ease: 'Cubic.easeOut',
			onComplete: () => ring.destroy()
		});
	}

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
		return interpolatePuck(frame);
	}

	private lerpOpponent(frame: InterpFrame) {
		const from = this.isHost ? frame.from.guestPaddle : frame.from.hostPaddle;
		const to = this.isHost ? frame.to.guestPaddle : frame.to.hostPaddle;
		return interpolatePaddle(from, to, frame.t, frame.from.status !== frame.to.status);
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
				this.transport.sendInput({
					sequence: ++this.inputSequence,
					x: this.localPaddle.x,
					y: this.localPaddle.y,
					clientTime: now
				});
			}
		}

		const myServerPos = this.isHost ? latest.hostPaddle : latest.guestPaddle;
		const useLocal = this.pointerInput.active && !useServerPosition;
		const myX = useLocal ? this.localPaddle.x : myServerPos.x;
		const myY = useLocal ? this.localPaddle.y : myServerPos.y;

		// A goal pop owns the puck sprite until the next round re-centres the puck.
		if (this.goalPopPlaying) {
			const cx = RINK_WIDTH / 2;
			const cy = RINK_HEIGHT / 2;
			const reset =
				latest.status === 'playing' &&
				Math.abs(latest.puck.x - cx) < 3 &&
				Math.abs(latest.puck.y - cy) < 3;
			if (reset) {
				this.goalPopPlaying = false;
				this.puckSprite.setScale(1).setAlpha(1);
				this.puckGlow.setScale(1).setAlpha(1);
				this.puckRenderX = cx;
				this.puckRenderY = cy;
				this.wasTouchingPuck = false;
			}
		}

		// While a pop is playing the tween owns the puck sprite, so only render it here
		// otherwise. Paddles are always rendered below.
		if (!this.goalPopPlaying) {
			const puckVisible = latest.status === 'playing' || latest.status === 'countdown' || latest.status === 'paused';
			this.puckSprite.setVisible(puckVisible);
			this.puckGlow.setVisible(puckVisible);

			this.renderPuck(now, latest, frame, myX, myY);
		}

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

	private renderPuck(
		now: number,
		latest: GameState,
		frame: InterpFrame,
		myX: number,
		myY: number
	) {
		// The puck is always rendered from buffered authoritative snapshots. Local
		// paddle rendering remains immediate, but puck collisions have one authority.
		const authoritative = this.lerpPuck(frame);
		this.puckRenderX = authoritative.x;
		this.puckRenderY = authoritative.y;
		this.predictedVx = frame.to.puck.vx;
		this.predictedVy = frame.to.puck.vy;
		if (latest.status === 'playing') this.maybeShakeOnHit(myX, myY, now);
		else this.wasTouchingPuck = false;
		this.setPuckPosition(this.puckRenderX, this.puckRenderY);
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
		const network = this.transport.getDiagnostics();
		const rtt = network.rttMs === null ? 'n/a' : `${network.rttMs.toFixed(1)}ms`;
		const jitter = network.jitterMs === null ? 'n/a' : `${network.jitterMs.toFixed(1)}ms`;
		// eslint-disable-next-line no-console
		console.log(
			`[net] snapshots/s=${d.received} missing=${d.missingSequences} ` +
				`extrapolatedFrames=${d.extrapolatedFrames} ` +
				`largestGap=${d.largestArrivalGap.toFixed(1)}ms interpDelay=${this.INTERP_DELAY_MS}ms ` +
				`rtt=${rtt} jitter=${jitter}`
		);

		d.received = 0;
		d.missingSequences = 0;
		d.extrapolatedFrames = 0;
		d.largestArrivalGap = 0;
		this.lastDiagnosticsLogAt = now;
	}

	shutdown() {
		this.pointerInput.detach();
		this.removeTransportListener?.();
		this.removeTransportListener = null;
	}
}
