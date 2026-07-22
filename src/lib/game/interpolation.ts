import type { GameState, PaddleState } from '$lib/network/types.js';

export interface InterpolationFrame {
	from: GameState;
	to: GameState;
	t: number;
	extrapolationMs: number;
}

export function interpolatePuck(frame: InterpolationFrame): { x: number; y: number } {
	if (frame.extrapolationMs > 0 && frame.to.status === 'playing') {
		const seconds = frame.extrapolationMs / 1000;
		return {
			x: frame.to.puck.x + frame.to.puck.vx * seconds,
			y: frame.to.puck.y + frame.to.puck.vy * seconds
		};
	}
	if (frame.from.status !== frame.to.status) return { x: frame.to.puck.x, y: frame.to.puck.y };
	return {
		x: frame.from.puck.x + (frame.to.puck.x - frame.from.puck.x) * frame.t,
		y: frame.from.puck.y + (frame.to.puck.y - frame.from.puck.y) * frame.t
	};
}

export function interpolatePaddle(
	from: PaddleState,
	to: PaddleState,
	t: number,
	crossedLifecycleBoundary: boolean
): { x: number; y: number } {
	if (crossedLifecycleBoundary) return { x: to.x, y: to.y };
	return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
