<script lang="ts">
	import { onMount } from 'svelte';
	import { CANVAS_WIDTH, CANVAS_HEIGHT } from './constants.js';
	import type { GameSocket } from '$lib/network/socket.js';
	import type { GameState } from '$lib/network/types.js';

	let {
		socket,
		isHost,
		onScore,
		onStatus,
		onElapsed,
		hostColor = '#00d4ff',
		guestColor = '#ff2d7b'
	}: {
		socket: GameSocket;
		isHost: boolean;
		onScore: (host: number, guest: number) => void;
		onStatus: (status: GameState['status']) => void;
		onElapsed: (ms: number) => void;
		hostColor?: string;
		guestColor?: string;
	} = $props();

	let container: HTMLDivElement;

	onMount(async () => {
		const Phaser = (await import('phaser')).default;
		const { PlayScene } = await import('./scenes/PlayScene.js');

		const game = new Phaser.Game({
			type: Phaser.AUTO,
			parent: container,
			width: CANVAS_WIDTH,
			height: CANVAS_HEIGHT,
			backgroundColor: '#0a0a1a',
			scale: {
				mode: Phaser.Scale.FIT,
				autoCenter: Phaser.Scale.CENTER_BOTH
			},
			scene: PlayScene
		});

		game.scene.start('PlayScene', {
			socket, isHost, onScore, onStatus, onElapsed, hostColor, guestColor
		});

		return () => {
			game.destroy(true);
		};
	});
</script>

<div bind:this={container} class="phaser-container"></div>

<style>
	.phaser-container {
		height: 100%;
		max-height: 100%;
		aspect-ratio: 500 / 800;
		max-width: 500px;
	}

	.phaser-container :global(canvas) {
		width: 100% !important;
		height: 100% !important;
		border-radius: 12px;
		filter: drop-shadow(0 0 30px rgba(0, 0, 0, 0.5));
	}
</style>
