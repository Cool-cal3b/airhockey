import {
	RINK_WIDTH,
	RINK_HEIGHT,
	PADDLE_RADIUS,
	PUCK_RADIUS,
	CORNER_RADIUS,
	GOAL_X_MIN,
	GOAL_X_MAX
} from './constants.js';

export function resolvePuckPaddleCollision(
	puck: { x: number; y: number; vx: number; vy: number },
	paddle: { x: number; y: number; vx: number; vy: number }
): { x: number; y: number; vx: number; vy: number } {
	const dx = puck.x - paddle.x;
	const dy = puck.y - paddle.y;
	const distSq = dx * dx + dy * dy;
	const minDist = PUCK_RADIUS + PADDLE_RADIUS;

	if (distSq >= minDist * minDist) return puck;
	if (distSq === 0) {
		return {
			x: paddle.x,
			y: paddle.y - minDist,
			vx: puck.vx,
			vy: puck.vy - 300
		};
	}

	const dist = Math.sqrt(distSq);
	const nx = dx / dist;
	const ny = dy / dist;

	const separatedX = paddle.x + nx * (minDist + 0.5);
	const separatedY = paddle.y + ny * (minDist + 0.5);

	const relVx = puck.vx - paddle.vx;
	const relVy = puck.vy - paddle.vy;
	const relDotN = relVx * nx + relVy * ny;

	// Already separating — just fix position
	if (relDotN > 0) {
		return { x: separatedX, y: separatedY, vx: puck.vx, vy: puck.vy };
	}

	const restitution = 0.85;
	const impulse = -(1 + restitution) * relDotN;

	const newVx = puck.vx + impulse * nx;
	const newVy = puck.vy + impulse * ny;

	return { x: separatedX, y: separatedY, vx: newVx, vy: newVy };
}

const CORNER_CENTERS = [
	{ cx: CORNER_RADIUS, cy: CORNER_RADIUS },
	{ cx: RINK_WIDTH - CORNER_RADIUS, cy: CORNER_RADIUS },
	{ cx: CORNER_RADIUS, cy: RINK_HEIGHT - CORNER_RADIUS },
	{ cx: RINK_WIDTH - CORNER_RADIUS, cy: RINK_HEIGHT - CORNER_RADIUS }
];

function resolveCornerCollision(
	x: number, y: number, vx: number, vy: number
): { x: number; y: number; vx: number; vy: number; hit: boolean } {
	const r = CORNER_RADIUS - PUCK_RADIUS;
	const bounce = 0.9;

	for (const { cx, cy } of CORNER_CENTERS) {
		const inCornerX = (cx < RINK_WIDTH / 2) ? x < cx : x > cx;
		const inCornerY = (cy < RINK_HEIGHT / 2) ? y < cy : y > cy;
		if (!inCornerX || !inCornerY) continue;

		const dx = x - cx;
		const dy = y - cy;
		const distSq = dx * dx + dy * dy;

		if (distSq <= r * r) continue;

		const dist = Math.sqrt(distSq);
		const nx = dx / dist;
		const ny = dy / dist;

		x = cx + nx * r;
		y = cy + ny * r;

		const dot = vx * nx + vy * ny;
		if (dot > 0) {
			vx -= (1 + bounce) * dot * nx;
			vy -= (1 + bounce) * dot * ny;
		}

		return { x, y, vx, vy, hit: true };
	}

	return { x, y, vx, vy, hit: false };
}

export function containPuckInRink(
	x: number,
	y: number,
	vx: number,
	vy: number
): { x: number; y: number; vx: number; vy: number; scored: 'host' | 'guest' | null } {
	let scored: 'host' | 'guest' | null = null;

	const corner = resolveCornerCollision(x, y, vx, vy);
	if (corner.hit) {
		return { ...corner, scored: null };
	}
	x = corner.x;
	y = corner.y;
	vx = corner.vx;
	vy = corner.vy;

	if (x - PUCK_RADIUS < 0) {
		x = PUCK_RADIUS;
		vx = Math.abs(vx) * 0.9;
	} else if (x + PUCK_RADIUS > RINK_WIDTH) {
		x = RINK_WIDTH - PUCK_RADIUS;
		vx = -Math.abs(vx) * 0.9;
	}

	if (y - PUCK_RADIUS < 0) {
		if (x >= GOAL_X_MIN && x <= GOAL_X_MAX) {
			scored = 'host';
		} else {
			y = PUCK_RADIUS;
			vy = Math.abs(vy) * 0.9;
		}
	} else if (y + PUCK_RADIUS > RINK_HEIGHT) {
		if (x >= GOAL_X_MIN && x <= GOAL_X_MAX) {
			scored = 'guest';
		} else {
			y = RINK_HEIGHT - PUCK_RADIUS;
			vy = -Math.abs(vy) * 0.9;
		}
	}

	return { x, y, vx, vy, scored };
}

export function clampSpeed(vx: number, vy: number, max: number): { vx: number; vy: number } {
	const speedSq = vx * vx + vy * vy;
	if (speedSq <= max * max) return { vx, vy };
	const scale = max / Math.sqrt(speedSq);
	return { vx: vx * scale, vy: vy * scale };
}

export function clampPaddleToHalf(
	x: number,
	y: number,
	isHost: boolean
): { x: number; y: number } {
	x = Math.max(PADDLE_RADIUS, Math.min(RINK_WIDTH - PADDLE_RADIUS, x));

	const halfY = RINK_HEIGHT / 2;
	if (isHost) {
		y = Math.max(halfY + PADDLE_RADIUS, Math.min(RINK_HEIGHT - PADDLE_RADIUS, y));
	} else {
		y = Math.max(PADDLE_RADIUS, Math.min(halfY - PADDLE_RADIUS, y));
	}

	return { x, y };
}
