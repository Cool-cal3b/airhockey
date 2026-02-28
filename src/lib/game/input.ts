import { CANVAS_WIDTH, CANVAS_HEIGHT } from './constants.js';

export class PointerInput {
	x = 0;
	y = 0;
	active = false;

	private canvas: HTMLCanvasElement | null = null;
	private padding: number;

	private onPointerMove = (e: PointerEvent) => {
		e.preventDefault();
		this.handleMove(e);
	};
	private onPointerDown = (e: PointerEvent) => {
		e.preventDefault();
		this.active = true;
		this.handleMove(e);
	};
	private onPointerUp = (e: PointerEvent) => {
		e.preventDefault();
		this.active = false;
	};
	private onPointerEnter = () => {
		this.active = true;
	};
	private onPointerLeave = () => {
		this.active = false;
	};
	private onTouchMove = (e: TouchEvent) => {
		e.preventDefault();
	};

	constructor(_logicalWidth: number, _logicalHeight: number, padding = 0) {
		this.padding = padding;
	}

	attach(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		canvas.addEventListener('pointermove', this.onPointerMove);
		canvas.addEventListener('pointerdown', this.onPointerDown);
		canvas.addEventListener('pointerup', this.onPointerUp);
		canvas.addEventListener('pointerenter', this.onPointerEnter);
		canvas.addEventListener('pointerleave', this.onPointerLeave);
		canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
		canvas.style.touchAction = 'none';
	}

	detach() {
		if (!this.canvas) return;
		this.canvas.removeEventListener('pointermove', this.onPointerMove);
		this.canvas.removeEventListener('pointerdown', this.onPointerDown);
		this.canvas.removeEventListener('pointerup', this.onPointerUp);
		this.canvas.removeEventListener('pointerenter', this.onPointerEnter);
		this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
		this.canvas.removeEventListener('touchmove', this.onTouchMove);
		this.canvas = null;
	}

	private handleMove(e: PointerEvent) {
		if (!this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = CANVAS_WIDTH / rect.width;
		const scaleY = CANVAS_HEIGHT / rect.height;
		this.x = (e.clientX - rect.left) * scaleX - this.padding;
		this.y = (e.clientY - rect.top) * scaleY - this.padding;
	}
}
