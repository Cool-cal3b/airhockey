<script lang="ts">
	import { onMount } from 'svelte';
	import { clearSession } from '$lib/network/socket.js';

	let puckY = $state(0);

	onMount(() => {
		clearSession();
	});

	$effect(() => {
		let frame: number;
		const animate = () => {
			puckY = Math.sin(Date.now() / 800) * 8;
			frame = requestAnimationFrame(animate);
		};
		frame = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(frame);
	});
</script>

<div class="page">
	<div class="hero">
		<div class="puck-icon" style="transform: translateY({puckY}px)">●</div>
		<h1>AIR HOCKEY</h1>
		<p class="subtitle">LAN Multiplayer</p>
	</div>

	<div class="actions">
		<a href="/host" class="btn btn-host">
			<span class="btn-icon">⚡</span>
			Host Game
		</a>
		<a href="/join" class="btn btn-join">
			<span class="btn-icon">🎮</span>
			Join Game
		</a>
	</div>

	<footer class="version">v0.0.1</footer>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		gap: 3rem;
		padding: 2rem;
	}

	.hero {
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.puck-icon {
		font-size: 3rem;
		color: var(--color-neon-blue);
		text-shadow: var(--glow-blue);
		margin-bottom: 0.5rem;
	}

	h1 {
		font-size: clamp(2.5rem, 8vw, 4.5rem);
		font-weight: 900;
		letter-spacing: 0.15em;
		background: linear-gradient(135deg, var(--color-neon-blue), var(--color-neon-pink));
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.subtitle {
		font-size: 1.1rem;
		color: var(--color-text-muted);
		letter-spacing: 0.3em;
		text-transform: uppercase;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
		max-width: 320px;
	}

	.btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 1rem 2rem;
		border-radius: 12px;
		font-family: 'Orbitron', sans-serif;
		font-size: 1.1rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-decoration: none;
		transition: all 0.2s ease;
		cursor: pointer;
		border: 2px solid transparent;
	}

	.btn-icon {
		font-size: 1.3rem;
	}

	.btn-host {
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
		border-color: var(--color-neon-blue);
		color: var(--color-neon-blue);
		box-shadow: var(--glow-blue);
	}

	.btn-host:hover {
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.3), rgba(0, 212, 255, 0.1));
		transform: translateY(-2px);
		box-shadow: 0 0 30px rgba(0, 212, 255, 0.5), 0 0 80px rgba(0, 212, 255, 0.15);
	}

	.btn-join {
		background: linear-gradient(135deg, rgba(255, 45, 123, 0.15), rgba(255, 45, 123, 0.05));
		border-color: var(--color-neon-pink);
		color: var(--color-neon-pink);
		box-shadow: var(--glow-pink);
	}

	.btn-join:hover {
		background: linear-gradient(135deg, rgba(255, 45, 123, 0.3), rgba(255, 45, 123, 0.1));
		transform: translateY(-2px);
		box-shadow: 0 0 30px rgba(255, 45, 123, 0.5), 0 0 80px rgba(255, 45, 123, 0.15);
	}

	.version {
		position: fixed;
		bottom: 1rem;
		right: 1.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
		opacity: 0.5;
	}
</style>
