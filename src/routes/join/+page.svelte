<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { connectSocket, disconnectSocket, saveSession } from '$lib/network/socket.js';
	import type { RoomListEntry, RoomInfo } from '$lib/network/types.js';

	let games = $state<RoomListEntry[]>([]);
	let scanning = $state(true);
	let manualRoomId = $state('');
	let joinError = $state('');
	let autoJoining = $state(false);

	$effect(() => {
		const socket = connectSocket();

		const code = page.url.searchParams.get('code');
		if (code && !autoJoining) {
			autoJoining = true;
			joinGame(code.toUpperCase());
		}

		socket.emit('listRooms', (roomList) => {
			games = roomList;
			scanning = false;
		});

		socket.on('roomList', (roomList) => {
			games = roomList;
			scanning = false;
		});

		return () => {
			socket.off('roomList');
		};
	});

	function joinGame(roomId: string) {
		joinError = '';
		const socket = connectSocket();
		socket.emit('joinRoom', { roomId }, (room: RoomInfo | null, errorOrToken?: string) => {
			if (!room) {
				joinError = errorOrToken ?? 'Failed to join room';
				return;
			}
			if (errorOrToken) {
				saveSession({ roomId: room.id, role: 'guest', token: errorOrToken });
			}
			goto(`/waiting?roomId=${room.id}`);
		});
	}

	function joinByCode() {
		if (!manualRoomId.trim()) return;
		joinGame(manualRoomId.trim().toUpperCase());
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') joinByCode();
	}
</script>

<div class="page">
	<div class="card">
		<a href="/" class="back-link" onclick={() => disconnectSocket()}>← Back to Menu</a>
		<h2>Join a Game</h2>

		{#if joinError}
			<div class="error">{joinError}</div>
		{/if}

		<div class="games-list">
			{#if scanning}
				<div class="scanning">
					<div class="spinner"></div>
					<span>Looking for games...</span>
				</div>
			{:else if games.length === 0}
				<div class="empty">
					<p>No games found</p>
					<p class="hint">Ask the host to start a game, or enter a room code below</p>
				</div>
			{:else}
				{#each games as game}
					<button class="game-row" onclick={() => joinGame(game.id)}>
						<div class="game-info">
							<span class="game-name">{game.name}</span>
							<span class="game-meta">Room {game.id} · First to {game.maxScore}</span>
						</div>
						<span class="game-players">{game.players}/2</span>
					</button>
				{/each}
			{/if}
		</div>

		<div class="divider">
			<span>or enter room code</span>
		</div>

		<div class="manual-join">
			<input
				type="text"
				bind:value={manualRoomId}
				onkeydown={handleKeydown}
				placeholder="Room code (e.g. A1B2C3)"
				maxlength="6"
			/>
			<button class="btn-connect" onclick={joinByCode} disabled={!manualRoomId.trim()}>
				Join
			</button>
		</div>
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
		max-width: 440px;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	h2 {
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--color-neon-pink);
		text-align: center;
	}

	.error {
		text-align: center;
		color: #ff4444;
		font-size: 0.85rem;
		padding: 0.5rem;
		border: 1px solid rgba(255, 68, 68, 0.3);
		border-radius: 8px;
		background: rgba(255, 68, 68, 0.08);
	}

	.games-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 120px;
	}

	.scanning {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem;
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}

	.spinner {
		width: 18px;
		height: 18px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-neon-pink);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.empty {
		text-align: center;
		padding: 1.5rem;
	}

	.empty p {
		color: var(--color-text-muted);
		font-size: 0.95rem;
	}

	.hint {
		margin-top: 0.5rem;
		font-size: 0.8rem !important;
		opacity: 0.6;
	}

	.game-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.85rem 1rem;
		border-radius: 10px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		cursor: pointer;
		transition: all 0.2s;
		text-align: left;
	}

	.game-row:hover {
		border-color: var(--color-neon-pink);
		background: rgba(255, 45, 123, 0.05);
	}

	.game-info {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.game-name {
		color: var(--color-text);
		font-weight: 600;
		font-size: 0.95rem;
	}

	.game-meta {
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.game-players {
		color: var(--color-neon-green);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.85rem;
		font-weight: 700;
	}

	.divider {
		display: flex;
		align-items: center;
		gap: 1rem;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}

	.manual-join {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.7rem 1rem;
		font-size: 0.95rem;
		color: var(--color-text);
		font-family: inherit;
		outline: none;
		transition: border-color 0.2s;
		text-transform: uppercase;
		letter-spacing: 0.15em;
	}

	input:focus {
		border-color: var(--color-neon-pink);
	}

	input::placeholder {
		color: var(--color-text-muted);
		opacity: 0.5;
		text-transform: none;
		letter-spacing: normal;
	}

	.btn-connect {
		padding: 0.7rem 1.25rem;
		border-radius: 8px;
		border: 1px solid var(--color-neon-pink);
		background: rgba(255, 45, 123, 0.1);
		color: var(--color-neon-pink);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
	}

	.btn-connect:hover:not(:disabled) {
		background: rgba(255, 45, 123, 0.2);
		box-shadow: var(--glow-pink);
	}

	.btn-connect:disabled {
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
			gap: 1rem;
		}
	}
</style>
