import type { GameState } from '$lib/network/types.js';
import {
	RINK_WIDTH,
	RINK_HEIGHT,
	PADDLE_RADIUS,
	CENTER_CIRCLE_RADIUS,
	PUCK_MAX_SPEED,
	PUCK_FRICTION,
	PADDLE_MAX_SPEED,
	TICK_MS,
	TICK_RATE,
	NETWORK_RATE,
	COUNTDOWN_SECONDS,
	GOAL_RESET_DELAY_MS
} from '$lib/game/constants.js';
import {
	resolvePuckPaddleCollision,
	containPuckInRink,
	clampSpeed,
	clampPaddleToHalf
} from '$lib/game/physics.js';

export type GameEventCallback = {
	onStateUpdate: (state: GameState) => void;
	onCountdown: (seconds: number) => void;
	onGoalScored: (scorer: 'host' | 'guest') => void;
	onGameOver: (winner: 'host' | 'guest', hostScore: number, guestScore: number) => void;
};

const SUBSTEPS = 4;
const PUSH_OUT_SPEED = 400;

export class GameSession {
	private puck = { x: RINK_WIDTH / 2, y: RINK_HEIGHT / 2, vx: 0, vy: 0 };
	private hostPaddle = { x: RINK_WIDTH / 2, y: RINK_HEIGHT - 80, vx: 0, vy: 0 };
	private guestPaddle = { x: RINK_WIDTH / 2, y: 80, vx: 0, vy: 0 };
	private hostTarget = { x: RINK_WIDTH / 2, y: RINK_HEIGHT - 80 };
	private guestTarget = { x: RINK_WIDTH / 2, y: 80 };
	private score = { host: 0, guest: 0 };
	private status: GameState['status'] = 'countdown';
	private interval: ReturnType<typeof setInterval> | null = null;
	private countdownRemaining = COUNTDOWN_SECONDS;
	private countdownTimer: ReturnType<typeof setTimeout> | null = null;
	private goalResetTimer: ReturnType<typeof setTimeout> | null = null;
	private maxScore: number;
	private callbacks: GameEventCallback;
	private dt = TICK_MS / 1000;
	private elapsedMs = 0;
	private pushingPaddles = false;
	private resetGraceTicks = 0;
	private statusBeforePause: GameState['status'] | null = null;
	private tickCount = 0;
	private networkEveryNTicks = Math.round(TICK_RATE / NETWORK_RATE);

	constructor(maxScore: number, callbacks: GameEventCallback) {
		this.maxScore = maxScore;
		this.callbacks = callbacks;
	}

	start() {
		this.status = 'countdown';
		this.countdownRemaining = COUNTDOWN_SECONDS;
		this.callbacks.onCountdown(this.countdownRemaining);

		this.countdownTimer = setInterval(() => {
			this.countdownRemaining--;
			if (this.countdownRemaining <= 0) {
				if (this.countdownTimer) clearInterval(this.countdownTimer);
				this.countdownTimer = null;
				this.status = 'playing';
				this.startPhysicsLoop();
			} else {
				this.callbacks.onCountdown(this.countdownRemaining);
			}
		}, 1000);
	}

	private startPhysicsLoop() {
		this.interval = setInterval(() => this.tick(), TICK_MS);
	}

	private shouldSendNetwork(): boolean {
		return this.tickCount % this.networkEveryNTicks === 0;
	}

	private tick() {
		this.tickCount++;

		if (this.status === 'playing') {
			this.elapsedMs += TICK_MS;
		}

		if (this.pushingPaddles) {
			this.pushPaddlesOutOfCenter();
			if (this.shouldSendNetwork()) {
				this.callbacks.onStateUpdate(this.getState());
			}
			return;
		}

		if (this.status !== 'playing') return;

		this.movePaddle(this.hostPaddle, this.hostTarget, true);
		this.movePaddle(this.guestPaddle, this.guestTarget, false);

		if (this.resetGraceTicks > 0) {
			this.resetGraceTicks--;
			if (this.shouldSendNetwork()) {
				this.callbacks.onStateUpdate(this.getState());
			}
			return;
		}

		const subDt = this.dt / SUBSTEPS;

		for (let step = 0; step < SUBSTEPS; step++) {
			const frictionFactor = Math.pow(PUCK_FRICTION, subDt);
			this.puck.vx *= frictionFactor;
			this.puck.vy *= frictionFactor;

			this.puck.x += this.puck.vx * subDt;
			this.puck.y += this.puck.vy * subDt;

			const afterHost = resolvePuckPaddleCollision(this.puck, this.hostPaddle);
			this.puck.x = afterHost.x;
			this.puck.y = afterHost.y;
			this.puck.vx = afterHost.vx;
			this.puck.vy = afterHost.vy;

			const afterGuest = resolvePuckPaddleCollision(this.puck, this.guestPaddle);
			this.puck.x = afterGuest.x;
			this.puck.y = afterGuest.y;
			this.puck.vx = afterGuest.vx;
			this.puck.vy = afterGuest.vy;

			const clamped = clampSpeed(this.puck.vx, this.puck.vy, PUCK_MAX_SPEED);
			this.puck.vx = clamped.vx;
			this.puck.vy = clamped.vy;

			const wall = containPuckInRink(this.puck.x, this.puck.y, this.puck.vx, this.puck.vy);
			this.puck.x = wall.x;
			this.puck.y = wall.y;
			this.puck.vx = wall.vx;
			this.puck.vy = wall.vy;

			if (wall.scored) {
				this.handleGoal(wall.scored);
				return;
			}
		}

		if (this.shouldSendNetwork()) {
			this.callbacks.onStateUpdate(this.getState());
		}
	}

	private isPaddleInCenter(paddle: { x: number; y: number }): boolean {
		const dx = paddle.x - RINK_WIDTH / 2;
		const dy = paddle.y - RINK_HEIGHT / 2;
		return Math.sqrt(dx * dx + dy * dy) < CENTER_CIRCLE_RADIUS + PADDLE_RADIUS;
	}

	private pushPaddlesOutOfCenter() {
		const cy = RINK_HEIGHT / 2;
		const clearRadius = CENTER_CIRCLE_RADIUS + PADDLE_RADIUS + 2;
		const maxMove = PUSH_OUT_SPEED * this.dt;
		let allClear = true;

		for (const entry of [
			{ paddle: this.hostPaddle, target: this.hostTarget, isHost: true },
			{ paddle: this.guestPaddle, target: this.guestTarget, isHost: false }
		]) {
			const { paddle, target, isHost } = entry;
			if (!this.isPaddleInCenter(paddle)) continue;

			allClear = false;
			const targetY = isHost ? cy + clearRadius : cy - clearRadius;
			const dy = targetY - paddle.y;
			const absDy = Math.abs(dy);

			if (absDy <= maxMove) {
				paddle.y = targetY;
			} else {
				paddle.y += Math.sign(dy) * maxMove;
			}

			const final = clampPaddleToHalf(paddle.x, paddle.y, isHost);
			paddle.x = final.x;
			paddle.y = final.y;
			paddle.vx = 0;
			paddle.vy = 0;

			target.x = paddle.x;
			target.y = paddle.y;
		}

		if (allClear) {
			this.pushingPaddles = false;
			this.resetPuck();
			this.resetGraceTicks = 10;
			this.status = 'playing';
			this.callbacks.onStateUpdate(this.getState());
		}
	}

	private movePaddle(
		paddle: { x: number; y: number; vx: number; vy: number },
		target: { x: number; y: number },
		isHost: boolean
	) {
		const clamped = clampPaddleToHalf(target.x, target.y, isHost);

		const prevX = paddle.x;
		const prevY = paddle.y;

		let dx = clamped.x - paddle.x;
		let dy = clamped.y - paddle.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const maxDist = PADDLE_MAX_SPEED * this.dt;

		if (dist > maxDist && dist > 0) {
			const scale = maxDist / dist;
			dx *= scale;
			dy *= scale;
		}

		paddle.x += dx;
		paddle.y += dy;

		let final = clampPaddleToHalf(paddle.x, paddle.y, isHost);
		if (this.resetGraceTicks > 0) {
			final = this.pushTargetOutOfCenter(final.x, final.y, isHost);
		}
		paddle.x = final.x;
		paddle.y = final.y;

		paddle.vx = (paddle.x - prevX) / this.dt;
		paddle.vy = (paddle.y - prevY) / this.dt;
	}

	private handleGoal(scorer: 'host' | 'guest') {
		this.score[scorer]++;
		this.status = 'goal';
		this.callbacks.onGoalScored(scorer);
		this.callbacks.onStateUpdate(this.getState());

		if (this.score[scorer] >= this.maxScore) {
			this.status = 'ended';
			this.callbacks.onGameOver(scorer, this.score.host, this.score.guest);
			this.callbacks.onStateUpdate(this.getState());
			this.stop();
			return;
		}

		this.goalResetTimer = setTimeout(() => {
			const hostInCenter = this.isPaddleInCenter(this.hostPaddle);
			const guestInCenter = this.isPaddleInCenter(this.guestPaddle);

			if (hostInCenter || guestInCenter) {
				this.pushingPaddles = true;
			} else {
				this.resetPuck();
				this.resetGraceTicks = 10;
				this.status = 'playing';
				this.callbacks.onStateUpdate(this.getState());
			}
		}, GOAL_RESET_DELAY_MS);
	}

	private resetPuck() {
		this.puck.x = RINK_WIDTH / 2;
		this.puck.y = RINK_HEIGHT / 2;
		this.puck.vx = 0;
		this.puck.vy = 0;
	}

	setPaddlePosition(isHost: boolean, x: number, y: number) {
		if (this.pushingPaddles) return;

		if (this.resetGraceTicks > 0) {
			const pushed = this.pushTargetOutOfCenter(x, y, isHost);
			x = pushed.x;
			y = pushed.y;
		}

		if (isHost) {
			this.hostTarget.x = x;
			this.hostTarget.y = y;
		} else {
			this.guestTarget.x = x;
			this.guestTarget.y = y;
		}
	}

	private pushTargetOutOfCenter(x: number, y: number, isHost: boolean): { x: number; y: number } {
		const cx = RINK_WIDTH / 2;
		const cy = RINK_HEIGHT / 2;
		const exclusion = CENTER_CIRCLE_RADIUS + PADDLE_RADIUS + 2;
		const dx = x - cx;
		const dy = y - cy;
		const dist = Math.sqrt(dx * dx + dy * dy);

		if (dist >= exclusion) return { x, y };

		if (dist === 0) {
			return { x, y: isHost ? cy + exclusion : cy - exclusion };
		}

		return {
			x: cx + (dx / dist) * exclusion,
			y: cy + (dy / dist) * exclusion
		};
	}

	getState(): GameState {
		return {
			puck: { x: this.puck.x, y: this.puck.y, vx: this.puck.vx, vy: this.puck.vy },
			hostPaddle: { x: this.hostPaddle.x, y: this.hostPaddle.y },
			guestPaddle: { x: this.guestPaddle.x, y: this.guestPaddle.y },
			score: { ...this.score },
			status: this.status,
			elapsedMs: this.elapsedMs
		};
	}

	pause() {
		if (this.status === 'ended' || this.status === 'paused') return;
		this.statusBeforePause = this.status;
		this.status = 'paused';

		if (this.interval) clearInterval(this.interval);
		if (this.countdownTimer) clearInterval(this.countdownTimer);
		if (this.goalResetTimer) clearTimeout(this.goalResetTimer);
		this.interval = null;
		this.countdownTimer = null;
		this.goalResetTimer = null;
	}

	resume() {
		if (this.status !== 'paused' || !this.statusBeforePause) return;

		const prev = this.statusBeforePause;
		this.statusBeforePause = null;

		if (prev === 'countdown') {
			this.status = 'countdown';
			this.callbacks.onCountdown(this.countdownRemaining);
			this.countdownTimer = setInterval(() => {
				this.countdownRemaining--;
				if (this.countdownRemaining <= 0) {
					if (this.countdownTimer) clearInterval(this.countdownTimer);
					this.countdownTimer = null;
					this.status = 'playing';
					this.startPhysicsLoop();
				} else {
					this.callbacks.onCountdown(this.countdownRemaining);
				}
			}, 1000);
		} else if (prev === 'playing') {
			this.status = 'playing';
			this.startPhysicsLoop();
		} else if (prev === 'goal') {
			this.status = 'goal';
			this.startPhysicsLoop();
			this.goalResetTimer = setTimeout(() => {
				const hostInCenter = this.isPaddleInCenter(this.hostPaddle);
				const guestInCenter = this.isPaddleInCenter(this.guestPaddle);

				if (hostInCenter || guestInCenter) {
					this.pushingPaddles = true;
				} else {
					this.resetPuck();
					this.resetGraceTicks = 10;
					this.status = 'playing';
					this.callbacks.onStateUpdate(this.getState());
				}
			}, GOAL_RESET_DELAY_MS);
		}
	}

	stop() {
		if (this.interval) clearInterval(this.interval);
		if (this.countdownTimer) clearInterval(this.countdownTimer);
		if (this.goalResetTimer) clearTimeout(this.goalResetTimer);
		this.interval = null;
		this.countdownTimer = null;
		this.goalResetTimer = null;
	}
}
