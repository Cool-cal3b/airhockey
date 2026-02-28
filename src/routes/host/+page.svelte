<script lang="ts">
	import { goto } from '$app/navigation';
	import { connectSocket, saveSession } from '$lib/network/socket.js';
	import type { RoomInfo } from '$lib/network/types.js';

	let gameName = $state('');
	let maxScore = $state(7);
	let creating = $state(false);

	function startGame() {
		if (!gameName.trim() || creating) return;
		creating = true;

		const socket = connectSocket();
		socket.emit('createRoom', { name: gameName.trim(), maxScore }, (room: RoomInfo, token: string) => {
			saveSession({ roomId: room.id, role: 'host', token });
			goto(`/waiting?roomId=${room.id}`);
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') startGame();
	}
</script>

<div class="page">
	<div class="card">
		<a href="/" class="back-link">← Back to Menu</a>
		<h2>Host a Game</h2>

		<div class="field">
			<label for="game-name">Game Name</label>
			<input
				id="game-name"
				type="text"
				bind:value={gameName}
				onkeydown={handleKeydown}
				placeholder="e.g. Living Room Match"
				maxlength="30"
				autofocus
			/>
		</div>

		<div class="field">
			<label for="max-score">First to</label>
			<div class="score-picker">
				{#each [5, 7, 10] as score}
					<button
						class="score-option"
						class:active={maxScore === score}
						onclick={() => (maxScore = score)}
					>
						{score}
					</button>
				{/each}
			</div>
		</div>

		<button class="btn-start" onclick={startGame} disabled={!gameName.trim() || creating}>
			{creating ? 'Creating...' : 'Create & Start'}
		</button>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: 2rem;
		gap: 2rem;
	}

	.back-link {
		align-self: flex-start;
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: 0.9rem;
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		border: 1px solid transparent;
		transition: all 0.2s;
	}

	.back-link:hover {
		color: var(--color-text);
		border-color: var(--color-border);
		background: var(--color-bg);
	}

	.card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 16px;
		padding: 2.5rem;
		width: 100%;
		max-width: 400px;
		display: flex;
		flex-direction: column;
		gap: 1.75rem;
	}

	h2 {
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--color-neon-blue);
		text-align: center;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	label {
		font-size: 0.85rem;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	input {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.75rem 1rem;
		font-size: 1rem;
		color: var(--color-text);
		font-family: inherit;
		outline: none;
		transition: border-color 0.2s;
	}

	input:focus {
		border-color: var(--color-neon-blue);
	}

	input::placeholder {
		color: var(--color-text-muted);
		opacity: 0.5;
	}

	.score-picker {
		display: flex;
		gap: 0.5rem;
	}

	.score-option {
		flex: 1;
		padding: 0.6rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-text-muted);
		font-family: 'Orbitron', sans-serif;
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s;
	}

	.score-option:hover {
		border-color: var(--color-neon-blue);
		color: var(--color-text);
	}

	.score-option.active {
		border-color: var(--color-neon-blue);
		background: rgba(0, 212, 255, 0.1);
		color: var(--color-neon-blue);
		box-shadow: var(--glow-blue);
	}

	.btn-start {
		padding: 1rem;
		border-radius: 12px;
		border: 2px solid var(--color-neon-blue);
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
		color: var(--color-neon-blue);
		font-family: 'Orbitron', sans-serif;
		font-size: 1.05rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.2s;
		box-shadow: var(--glow-blue);
	}

	.btn-start:hover:not(:disabled) {
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.3), rgba(0, 212, 255, 0.1));
		transform: translateY(-2px);
		box-shadow: 0 0 30px rgba(0, 212, 255, 0.5), 0 0 80px rgba(0, 212, 255, 0.15);
	}

	.btn-start:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	@media (max-width: 480px) {
		.page {
			padding: 1rem;
			justify-content: flex-start;
			padding-top: 3rem;
		}

		.card {
			padding: 1.5rem;
			gap: 1.25rem;
		}
	}
</style>
