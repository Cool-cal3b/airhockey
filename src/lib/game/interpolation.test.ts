import { describe, expect, it } from 'vitest';
import type { GameState } from '$lib/network/types.js';
import { interpolatePaddle, interpolatePuck } from './interpolation.js';

function state(status: GameState['status'], x: number, vx = 0): GameState {
	return {
		sequence: 1, simulationTick: 1, serverTime: 100,
		puck: { x, y: x, vx, vy: vx },
		hostPaddle: { x: 200, y: 620, vx: 0, vy: 0 },
		guestPaddle: { x: 200, y: 80, vx: 0, vy: 0 },
		acknowledgedInput: { host: -1, guest: -1 },
		score: { host: 0, guest: 0 }, status, elapsedMs: 0
	};
}

describe('authoritative interpolation', () => {
	it('interpolates ordinary puck movement', () => {
		expect(interpolatePuck({ from: state('playing', 10), to: state('playing', 30), t: 0.25, extrapolationMs: 0 }))
			.toEqual({ x: 15, y: 15 });
	});

	it('snaps across lifecycle boundaries', () => {
		expect(interpolatePuck({ from: state('goal', 390), to: state('playing', 200), t: 0.5, extrapolationMs: 0 }))
			.toEqual({ x: 200, y: 200 });
		expect(interpolatePaddle(
			{ x: 10, y: 10, vx: 0, vy: 0 }, { x: 50, y: 50, vx: 0, vy: 0 }, 0.5, true
		)).toEqual({ x: 50, y: 50 });
	});

	it('extrapolates from velocity for the bounded gap supplied by the buffer', () => {
		expect(interpolatePuck({ from: state('playing', 10), to: state('playing', 10, 100), t: 0, extrapolationMs: 20 }))
			.toEqual({ x: 12, y: 12 });
	});
});
