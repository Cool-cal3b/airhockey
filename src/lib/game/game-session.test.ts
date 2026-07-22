import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '$lib/network/types.js';
import { GameSession } from './game-session.js';

afterEach(() => vi.useRealTimers());

describe('GameSession protocol state', () => {
	it('runs fixed ticks and acknowledges the latest processed input', () => {
		vi.useFakeTimers();
		const states: GameState[] = [];
		const session = new GameSession(7, {
			onStateUpdate: (state) => states.push(state),
			onCountdown: () => {}, onGoalScored: () => {}, onGameOver: () => {}
		});
		session.start();
		vi.advanceTimersByTime(3_050);
		session.setPaddlePosition(true, 250, 600, 42);
		session.setPaddlePosition(true, 100, 600, 41);
		vi.advanceTimersByTime(100);
		const latest = states.at(-1);
		expect(latest?.simulationTick).toBeGreaterThan(0);
		expect(latest?.acknowledgedInput.host).toBe(42);
		expect(latest?.hostPaddle.vx).not.toBeUndefined();
		expect(latest?.sequence).toBeGreaterThan(1);
		session.stop();
	});
});
