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
	TICK_MS
} from '../constants.js';
import { clampPaddleToHalf } from '../physics.js';
import { PointerInput } from '../input.js';
import type { GameSocket } from '$lib/network/socket.js';
import type { GameState } from '$lib/network/types.js';

function hexToNum(hex: string): number {
	return parseInt(hex.replace('#', ''), 16);
}

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

	private latestState: GameState | null = null;
	private stateTimestamp = 0;

	private localPaddle = { x: 0, y: 0 };
	private lastFrameTime = 0;
	private prevStatus: GameState['status'] | null = null;
	private graceUntil = 0;

	private scoreCallback?: (host: number, guest: number) => void;
	private statusCallback?: (status: GameState['status']) => void;
	private elapsedCallback?: (ms: number) => void;

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

		this.pointerInput = new PointerInput(RINK_WIDTH, RINK_HEIGHT, CANVAS_PADDING);
		this.pointerInput.attach(this.game.canvas);
		this.lastFrameTime = performance.now();

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
	}

	private setupSocketListeners() {
		this.socket.on('gameState', (state: GameState) => {
			this.latestState = state;
			this.stateTimestamp = performance.now();

			this.scoreCallback?.(state.score.host, state.score.guest);
			this.statusCallback?.(state.status);
			this.elapsedCallback?.(state.elapsedMs);
		});

		this.socket.on('countdown', (data) => {
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
		});

		this.socket.on('goalScored', () => {
			this.goalText.setAlpha(1).setScale(0.5);
			this.tweens.add({
				targets: this.goalText,
				scaleX: 1.2,
				scaleY: 1.2,
				alpha: 0,
				duration: 1200,
				ease: 'Power2'
			});
		});
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

	update() {
		const now = performance.now();
		const dt = Math.min((now - this.lastFrameTime) / 1000, 0.05);
		this.lastFrameTime = now;

		if (!this.latestState) return;

		const state = this.latestState;

		if (this.prevStatus !== null && this.prevStatus !== 'playing' && state.status === 'playing') {
			this.graceUntil = now + TICK_MS * 12;
		}
		this.prevStatus = state.status;

		const useServerPosition = state.status === 'goal' || state.status === 'countdown' || state.status === 'paused';
		const inGrace = now < this.graceUntil;

		if (this.pointerInput.active && !useServerPosition) {
			let target = clampPaddleToHalf(this.pointerInput.x, this.pointerInput.y, this.isHost);
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

			this.socket.volatile.emit('paddleMove', {
				x: this.pointerInput.x,
				y: this.pointerInput.y
			});
		}

		const puckVisible = state.status === 'playing' || state.status === 'countdown' || state.status === 'paused';
		this.puckSprite.setVisible(puckVisible);
		this.puckGlow.setVisible(puckVisible);

		this.setPuckPosition(state.puck.x, state.puck.y);

		const myServerPos = this.isHost ? state.hostPaddle : state.guestPaddle;
		const opponentServerPos = this.isHost ? state.guestPaddle : state.hostPaddle;

		const useLocal = this.pointerInput.active && !useServerPosition;

		if (this.isHost) {
			this.setHostPaddlePosition(
				useLocal ? this.localPaddle.x : myServerPos.x,
				useLocal ? this.localPaddle.y : myServerPos.y
			);
			this.setGuestPaddlePosition(opponentServerPos.x, opponentServerPos.y);
		} else {
			this.setGuestPaddlePosition(
				useLocal ? this.localPaddle.x : myServerPos.x,
				useLocal ? this.localPaddle.y : myServerPos.y
			);
			this.setHostPaddlePosition(opponentServerPos.x, opponentServerPos.y);
		}

		if (useServerPosition) {
			this.localPaddle.x = myServerPos.x;
			this.localPaddle.y = myServerPos.y;
		}
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

	shutdown() {
		this.pointerInput.detach();
		this.socket.off('gameState');
		this.socket.off('countdown');
		this.socket.off('goalScored');
	}
}
