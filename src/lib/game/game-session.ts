import type { GameState } from '$lib/network/types.js';
import {
	RINK_WIDTH,
	RINK_HEIGHT,
	PADDLE_RADIUS,
	CENTER_CIRCLE_RADIUS,
	PADDLE_MAX_SPEED,
	TICK_MS,
	TICK_RATE,
	SNAPSHOT_RATE,
	COUNTDOWN_SECONDS,
	GOAL_RESET_DELAY_MS
} from '$lib/game/constants.js';
import {
	stepPuck,
	clampPaddleToHalf
} from '$lib/game/physics.js';

export type GameEventCallback = {
	onStateUpdate: (state: GameState) => void;
	onCountdown: (seconds: number) => void;
	onGoalScored: (scorer: 'host' | 'guest') => void;
	onGameOver: (winner: 'host' | 'guest', hostScore: number, guestScore: number) => void;
};

const PUSH_OUT_SPEED = 400;

export class GameSession {
	private puck = { x: RINK_WIDTH / 2, y: RINK_HEIGHT / 2, vx: 0, vy: 0 };
	private hostPaddle = { x: RINK_WIDTH / 2, y: RINK_HEIGHT - 80, vx: 0, vy: 0 };
	private guestPaddle = { x: RINK_WIDTH / 2, y: 80, vx: 0, vy: 0 };
	private hostTarget = { x: RINK_WIDTH / 2, y: RINK_HEIGHT - 80 };
	private guestTarget = { x: RINK_WIDTH / 2, y: 80 };
	private score = { host: 0, guest: 0 };
	private status: GameState['status'] = 'countdown';
	private physicsTimer: ReturnType<typeof setTimeout> | null = null;
	private lastLoopTime = 0;
	private accumulatorMs = 0;
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
	private sequence = 0;
	private acknowledgedInput = { host: -1, guest: -1 };
	private networkEveryNTicks = Math.round(TICK_RATE / SNAPSHOT_RATE);

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
		if (this.physicsTimer) clearTimeout(this.physicsTimer);
		this.lastLoopTime = performance.now();
		this.accumulatorMs = 0;
		this.schedulePhysicsLoop();
	}

	private schedulePhysicsLoop(delayMs = TICK_MS) {
		this.physicsTimer = setTimeout(() => this.runPhysicsLoop(), delayMs);
	}

	private runPhysicsLoop() {
		const now = performance.now();
		const elapsed = Math.min(now - this.lastLoopTime, 100);
		this.lastLoopTime = now;
		this.accumulatorMs += elapsed;

		let steps = 0;
		const maxCatchUpSteps = 5;

		while (this.accumulatorMs >= TICK_MS && steps < maxCatchUpSteps) {
			this.tick();
			this.accumulatorMs -= TICK_MS;
			steps++;
		}

		if (steps === maxCatchUpSteps) {
			// Avoid a spiral of death after a heavily delayed event-loop turn.
			this.accumulatorMs = 0;
		}

		if (this.status !== 'paused' && this.status !== 'ended') {
			const nextDelay = Math.max(1, TICK_MS - this.accumulatorMs);
			this.schedulePhysicsLoop(nextDelay);
		}
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

		const result = stepPuck(this.puck, this.hostPaddle, this.guestPaddle, this.dt);
		this.puck.x = result.x;
		this.puck.y = result.y;
		this.puck.vx = result.vx;
		this.puck.vy = result.vy;

		if (result.scored) {
			this.handleGoal(result.scored);
			return;
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

	setPaddlePosition(isHost: boolean, x: number, y: number, inputSequence = -1) {
		if (this.pushingPaddles) return;
		const lastProcessed = isHost
			? this.acknowledgedInput.host
			: this.acknowledgedInput.guest;
		if (inputSequence >= 0 && inputSequence <= lastProcessed) return;

		if (this.resetGraceTicks > 0) {
			const pushed = this.pushTargetOutOfCenter(x, y, isHost);
			x = pushed.x;
			y = pushed.y;
		}

		if (isHost) {
			this.hostTarget.x = x;
			this.hostTarget.y = y;
			this.acknowledgedInput.host = Math.max(this.acknowledgedInput.host, inputSequence);
		} else {
			this.guestTarget.x = x;
			this.guestTarget.y = y;
			this.acknowledgedInput.guest = Math.max(this.acknowledgedInput.guest, inputSequence);
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
			sequence: ++this.sequence,
			simulationTick: this.tickCount,
			serverTime: performance.now(),
			puck: { x: this.puck.x, y: this.puck.y, vx: this.puck.vx, vy: this.puck.vy },
			hostPaddle: { ...this.hostPaddle },
			guestPaddle: { ...this.guestPaddle },
			acknowledgedInput: { ...this.acknowledgedInput },
			score: { ...this.score },
			status: this.status,
			elapsedMs: this.elapsedMs
		};
	}

	pause() {
		if (this.status === 'ended' || this.status === 'paused') return;
		this.statusBeforePause = this.status;
		this.status = 'paused';

		if (this.physicsTimer) clearTimeout(this.physicsTimer);
		if (this.countdownTimer) clearInterval(this.countdownTimer);
		if (this.goalResetTimer) clearTimeout(this.goalResetTimer);
		this.physicsTimer = null;
		this.accumulatorMs = 0;
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
		if (this.physicsTimer) clearTimeout(this.physicsTimer);
		if (this.countdownTimer) clearInterval(this.countdownTimer);
		if (this.goalResetTimer) clearTimeout(this.goalResetTimer);
		this.physicsTimer = null;
		this.accumulatorMs = 0;
		this.countdownTimer = null;
		this.goalResetTimer = null;
	}
}
