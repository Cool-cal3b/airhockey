<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { connectSocket, loadSession, saveSession, clearSession } from '$lib/network/socket.js';
	import PhaserGame from '$lib/game/PhaserGame.svelte';
	import { NEON_COLORS, RECONNECT_GRACE_MS, type GameState, type RoomInfo, type NeonColorId } from '$lib/network/types.js';

	const roomId = $derived(page.url.searchParams.get('roomId') ?? '');

	let myRole = $state<'host' | 'guest' | null>(null);
	let roleResolved = $state(false);
	const isHost = $derived(myRole === 'host');

	let hostScore = $state(0);
	let guestScore = $state(0);
	let status = $state<GameState['status']>('countdown');
	let elapsedMs = $state(0);
	let room = $state<RoomInfo | null>(null);
	let showFullscreenHint = $state(false);
	let opponentDisconnected = $state(false);
	let graceRemaining = $state(0);
	let graceInterval: ReturnType<typeof setInterval> | null = null;

	const socket = connectSocket();

	const hostName = $derived(room?.hostName ?? 'Player 1');
	const guestName = $derived(room?.guestName ?? 'Player 2');
	const hostColorHex = $derived(colorHex(room?.hostColor ?? 'cyan'));
	const guestColorHex = $derived(colorHex(room?.guestColor ?? 'pink'));

	function colorHex(id: NeonColorId): string {
		return NEON_COLORS.find((c) => c.id === id)?.hex ?? '#ffffff';
	}

	const timerMinutes = $derived(Math.floor(elapsedMs / 60000));
	const timerSeconds = $derived(Math.floor((elapsedMs % 60000) / 1000));
	const timerDisplay = $derived(
		`${String(timerMinutes).padStart(2, '0')}:${String(timerSeconds).padStart(2, '0')}`
	);

	const graceSeconds = $derived(Math.ceil(graceRemaining / 1000));

	function handleScore(host: number, guest: number) {
		hostScore = host;
		guestScore = guest;
	}

	function handleStatus(newStatus: GameState['status']) {
		status = newStatus;
	}

	function handleElapsed(ms: number) {
		elapsedMs = ms;
	}

	function isMobile() {
		return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
	}

	async function goFullscreen() {
		try {
			await document.documentElement.requestFullscreen();
		} catch {
			// ignore
		}
		showFullscreenHint = false;
	}

	function startGraceCountdown(graceMs: number) {
		opponentDisconnected = true;
		graceRemaining = graceMs;
		if (graceInterval) clearInterval(graceInterval);
		graceInterval = setInterval(() => {
			graceRemaining -= 100;
			if (graceRemaining <= 0) {
				if (graceInterval) clearInterval(graceInterval);
				graceInterval = null;
			}
		}, 100);
	}

	function clearGraceCountdown() {
		opponentDisconnected = false;
		graceRemaining = 0;
		if (graceInterval) clearInterval(graceInterval);
		graceInterval = null;
	}

	onMount(() => {
		document.body.classList.add('game-active');
		if (isMobile() && !document.fullscreenElement) {
			showFullscreenHint = true;
		}
		return () => {
			document.body.classList.remove('game-active');
			clearGraceCountdown();
		};
	});

	function resolveRole(role: 'host' | 'guest' | null) {
		if (role) {
			myRole = role;
			roleResolved = true;
		}
	}

	function attemptRejoin() {
		const session = loadSession();
		if (session && session.roomId === roomId) {
			socket.emit('rejoinRoom', { token: session.token }, (rejoinedRoom, rejoinedRole) => {
				if (rejoinedRoom && rejoinedRole) {
					room = rejoinedRoom;
					resolveRole(rejoinedRole);
				} else {
					fetchRoleFromServer();
				}
			});
		} else {
			fetchRoleFromServer();
		}
	}

	function fetchRoleFromServer() {
		socket.emit('getRoom', { roomId }, (fetchedRoom) => {
			if (fetchedRoom) room = fetchedRoom;
		});
		socket.emit('getMyRole', { roomId }, (role) => {
			resolveRole(role);
		});
	}

	$effect(() => {
		attemptRejoin();

		socket.on('connect', () => {
			attemptRejoin();
		});

		socket.on('gameOver', (data) => {
			hostScore = data.hostScore;
			guestScore = data.guestScore;
			clearSession();
		});

		socket.on('roomClosed', () => {
			clearSession();
			goto('/');
		});

		socket.on('opponentDisconnected', (data) => {
			startGraceCountdown(data.graceMs);
		});

		socket.on('opponentReconnected', () => {
			clearGraceCountdown();
		});

		return () => {
			socket.off('connect');
			socket.off('gameOver');
			socket.off('roomClosed');
			socket.off('opponentDisconnected');
			socket.off('opponentReconnected');
		};
	});
</script>

<div class="game-page">
	<div class="game-layout">
		<div class="score-bar top-bar">
			<div class="score-item">
				<span class="score-name" style="color: {hostColorHex}">{isHost ? hostName : guestName}</span>
				<span class="score-num" style="color: {hostColorHex}; text-shadow: 0 0 16px {hostColorHex}80">{hostScore}</span>
			</div>
			<div class="timer">{timerDisplay}</div>
			<div class="score-item">
				<span class="score-name" style="color: {guestColorHex}">{isHost ? guestName : hostName}</span>
				<span class="score-num" style="color: {guestColorHex}; text-shadow: 0 0 16px {guestColorHex}80">{guestScore}</span>
			</div>
		</div>

		<div class="rink-container">
			{#if roleResolved}
				<PhaserGame
					{socket}
					{isHost}
					onScore={handleScore}
					onStatus={handleStatus}
					onElapsed={handleElapsed}
					hostColor={hostColorHex}
					guestColor={guestColorHex}
				/>
			{:else}
				<div class="loading-role">Connecting...</div>
			{/if}
		</div>

		<div class="room-code">{roomId}</div>
	</div>

	{#if opponentDisconnected}
		<div class="disconnect-overlay">
			<div class="disconnect-card">
				<div class="disconnect-icon">⚠</div>
				<h3>Opponent Disconnected</h3>
				<p class="disconnect-detail">Waiting for reconnection...</p>
				<div class="grace-timer">{graceSeconds}s</div>
				<div class="grace-bar">
					<div class="grace-fill" style="width: {(graceRemaining / RECONNECT_GRACE_MS) * 100}%"></div>
				</div>
			</div>
		</div>
	{/if}

	{#if showFullscreenHint}
		<button class="fullscreen-hint" onclick={goFullscreen}>
			Tap for fullscreen
		</button>
	{/if}

	{#if status === 'ended'}
		<div class="game-over-overlay">
			<div class="game-over-card">
				<h2 class="game-over-title">
					{#if (isHost && hostScore > guestScore) || (!isHost && guestScore > hostScore)}
						You Win!
					{:else}
						You Lose
					{/if}
				</h2>
				<p class="final-score">{hostScore} - {guestScore}</p>
				<p class="final-time">{timerDisplay}</p>
				<div class="game-over-actions">
					<button class="btn-lobby" onclick={() => goto('/')}>Back to Menu</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.game-page {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100vh;
		height: 100dvh;
		background: var(--color-bg);
		user-select: none;
		overflow: hidden;
		position: relative;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
	}

	.game-layout {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		width: 100%;
		padding: 0.5rem;
		box-sizing: border-box;
		gap: 0.35rem;
	}

	.score-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		max-width: 500px;
		padding: 0 0.5rem;
		flex-shrink: 0;
	}

	.score-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.score-name {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.6rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		max-width: 70px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.score-num {
		font-family: 'Orbitron', sans-serif;
		font-size: 1.8rem;
		font-weight: 900;
		line-height: 1;
	}

	.timer {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--color-text);
		letter-spacing: 0.1em;
		opacity: 0.7;
	}

	.rink-container {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
		width: 100%;
	}

	.room-code {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.5rem;
		color: var(--color-text-muted);
		letter-spacing: 0.15em;
		opacity: 0.3;
		flex-shrink: 0;
	}

	.loading-role {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.9rem;
		color: var(--color-text-muted);
		letter-spacing: 0.1em;
	}

	.disconnect-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 90;
	}

	.disconnect-card {
		background: var(--color-surface);
		border: 1px solid rgba(255, 200, 0, 0.3);
		border-radius: 16px;
		padding: 2rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		min-width: 260px;
		max-width: 90vw;
	}

	.disconnect-icon {
		font-size: 2.5rem;
	}

	.disconnect-card h3 {
		font-family: 'Orbitron', sans-serif;
		font-size: 1.1rem;
		font-weight: 700;
		color: #ffc800;
		letter-spacing: 0.05em;
	}

	.disconnect-detail {
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}

	.grace-timer {
		font-family: 'Orbitron', sans-serif;
		font-size: 1.5rem;
		font-weight: 900;
		color: #ffc800;
	}

	.grace-bar {
		width: 100%;
		height: 4px;
		background: var(--color-border);
		border-radius: 2px;
		overflow: hidden;
	}

	.grace-fill {
		height: 100%;
		background: #ffc800;
		border-radius: 2px;
		transition: width 0.1s linear;
	}

	.game-over-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.game-over-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 16px;
		padding: 2rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 260px;
		max-width: 90vw;
	}

	.game-over-title {
		font-family: 'Orbitron', sans-serif;
		font-size: 1.8rem;
		font-weight: 900;
		background: linear-gradient(135deg, var(--color-neon-blue), var(--color-neon-pink));
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.final-score {
		font-family: 'Orbitron', sans-serif;
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.final-time {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.9rem;
		color: var(--color-text-muted);
	}

	.game-over-actions {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	.btn-lobby {
		padding: 0.85rem 1.5rem;
		border-radius: 10px;
		border: 2px solid var(--color-neon-blue);
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
		color: var(--color-neon-blue);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.9rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-lobby:hover {
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.3), rgba(0, 212, 255, 0.1));
		box-shadow: var(--glow-blue);
	}

	.fullscreen-hint {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		padding: 0.6rem 1.2rem;
		border-radius: 20px;
		border: 1px solid var(--color-neon-blue);
		background: rgba(10, 10, 26, 0.9);
		color: var(--color-neon-blue);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		cursor: pointer;
		animation: hintPulse 2s ease-in-out infinite;
	}

	@keyframes hintPulse {
		0%, 100% { opacity: 0.8; }
		50% { opacity: 1; box-shadow: var(--glow-blue); }
	}
</style>
