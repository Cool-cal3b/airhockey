<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { connectSocket } from '$lib/network/socket.js';
	import { NEON_COLORS, type RoomInfo, type NeonColorId } from '$lib/network/types.js';

	const roomId = $derived(page.url.searchParams.get('roomId') ?? '');

	let myRole = $state<'host' | 'guest' | null>(null);
	const isHost = $derived(myRole === 'host');

	let room = $state<RoomInfo | null>(null);
	let connected = $state(false);
	let nameInput = $state('');
	let nameSet = $state(false);
	let copied = $state(false);

	const shareUrl = $derived(
		typeof window !== 'undefined'
			? `${window.location.origin}/join?code=${roomId}`
			: ''
	);

	const myColor = $derived(isHost ? room?.hostColor ?? 'cyan' : room?.guestColor ?? 'pink');
	const opponentColor = $derived(isHost ? room?.guestColor ?? 'pink' : room?.hostColor ?? 'cyan');

	function colorHex(id: NeonColorId): string {
		return NEON_COLORS.find((c) => c.id === id)?.hex ?? '#ffffff';
	}

	$effect(() => {
		if (!roomId) {
			goto('/');
			return;
		}

		const socket = connectSocket();
		connected = socket.connected;

		socket.on('connect', () => {
			connected = true;
			socket.emit('getMyRole', { roomId }, (role) => { myRole = role; });
		});
		socket.on('disconnect', () => { connected = false; });
		socket.on('roomUpdated', (updatedRoom) => { room = updatedRoom; });
		socket.on('roomClosed', () => { goto('/'); });
		socket.on('gameStarted', () => {
			goto(`/game?roomId=${roomId}`);
		});

		socket.emit('getRoom', { roomId }, (fetchedRoom) => {
			if (fetchedRoom) {
				room = fetchedRoom;
			} else {
				goto('/');
			}
		});

		socket.emit('getMyRole', { roomId }, (role) => { myRole = role; });

		return () => {
			socket.off('connect');
			socket.off('disconnect');
			socket.off('roomUpdated');
			socket.off('roomClosed');
			socket.off('gameStarted');
		};
	});

	function submitName() {
		if (!nameInput.trim()) return;
		const socket = connectSocket();
		socket.emit('setName', { name: nameInput.trim() });
		nameSet = true;
	}

	function selectColor(colorId: NeonColorId) {
		if (colorId === opponentColor) return;
		const socket = connectSocket();
		socket.emit('setColor', { color: colorId });
	}

	function toggleReady() {
		const socket = connectSocket();
		socket.emit('toggleReady');
	}

	function startMatch() {
		const socket = connectSocket();
		socket.emit('startGame');
	}

	function leaveRoom() {
		const socket = connectSocket();
		socket.emit('leaveRoom');
		goto('/');
	}

	async function copyShareUrl() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		} catch {
			// fallback: select the text
		}
	}

	const canNativeShare = $derived(typeof navigator !== 'undefined' && !!navigator.share);

	async function nativeShare() {
		try {
			await navigator.share({
				title: `Join my Air Hockey match!`,
				text: `Join "${room?.name ?? 'Air Hockey'}" — Room ${roomId}`,
				url: shareUrl
			});
		} catch {
			// user cancelled or not supported
		}
	}

	const gameName = $derived(room?.name ?? 'Loading...');
	const maxScore = $derived(room?.maxScore ?? 7);
	const hostReady = $derived(room?.hostReady ?? false);
	const guestReady = $derived(room?.guestReady ?? false);
	const guestConnected = $derived(!!room?.guestId);
	const canStart = $derived(hostReady && guestReady && guestConnected);
</script>

<div class="page">
	<div class="card">
		<button class="back-link" onclick={leaveRoom}>← Leave Room</button>
		<h2>{gameName}</h2>
		<p class="match-info">First to {maxScore} · Room {roomId}</p>

		<div class="players">
			<div class="player" class:ready={hostReady} style="--player-color: {colorHex(room?.hostColor ?? 'cyan')}">
				<div class="player-avatar" style="background: {colorHex(room?.hostColor ?? 'cyan')}20; color: {colorHex(room?.hostColor ?? 'cyan')}; border-color: {colorHex(room?.hostColor ?? 'cyan')}">
					{(room?.hostName ?? 'P1').charAt(0).toUpperCase()}
				</div>
				<div class="player-info">
					<span class="player-label">{room?.hostName ?? 'Player 1'} {isHost ? '(You)' : ''}</span>
					<span class="player-status connected">Connected</span>
				</div>
				{#if hostReady}
					<span class="ready-badge">Ready</span>
				{/if}
			</div>

			<div class="vs">VS</div>

			<div class="player" class:ready={guestReady} style="--player-color: {colorHex(room?.guestColor ?? 'pink')}">
				{#if guestConnected}
					<div class="player-avatar" style="background: {colorHex(room?.guestColor ?? 'pink')}20; color: {colorHex(room?.guestColor ?? 'pink')}; border-color: {colorHex(room?.guestColor ?? 'pink')}">
						{(room?.guestName ?? 'P2').charAt(0).toUpperCase()}
					</div>
					<div class="player-info">
						<span class="player-label">{room?.guestName ?? 'Player 2'} {!isHost ? '(You)' : ''}</span>
						<span class="player-status connected">Connected</span>
					</div>
					{#if guestReady}
						<span class="ready-badge">Ready</span>
					{/if}
				{:else}
					<div class="player-avatar waiting-avatar">?</div>
					<div class="player-info">
						<span class="player-label">Waiting for player...</span>
						<span class="player-status"><span class="dot-pulse"></span></span>
					</div>
				{/if}
			</div>
		</div>

		{#if isHost && !guestConnected}
			<div class="share-section">
				<span class="share-label">Share this link to invite a player</span>
				<div class="share-row">
					<input type="text" class="share-input" readonly value={shareUrl} />
					<button class="btn-copy" onclick={copyShareUrl}>
						{copied ? '✓' : 'Copy'}
					</button>
				</div>
				{#if canNativeShare}
					<button class="btn-share" onclick={nativeShare}>
						Share via Message
					</button>
				{/if}
				<span class="share-code">Room Code: <strong>{roomId}</strong></span>
			</div>
		{/if}

		<div class="customization">
			<div class="custom-section">
				<label class="custom-label" for="name-input">Your Name</label>
				<div class="name-row">
					<input
						id="name-input"
						type="text"
						class="name-input"
						placeholder="Enter name..."
						maxlength="16"
						bind:value={nameInput}
						onkeydown={(e) => { if (e.key === 'Enter') submitName(); }}
					/>
					<button class="btn-set-name" onclick={submitName} disabled={!nameInput.trim()}>
						{nameSet ? '✓' : 'Set'}
					</button>
				</div>
			</div>

			<div class="custom-section">
				<span class="custom-label">Your Color</span>
				<div class="color-grid">
					{#each NEON_COLORS as color}
						<button
							class="color-swatch"
							class:selected={myColor === color.id}
							class:taken={opponentColor === color.id}
							disabled={opponentColor === color.id}
							style="--swatch-color: {color.hex}"
							title={opponentColor === color.id ? `Taken by opponent` : color.label}
							onclick={() => selectColor(color.id)}
						>
							{#if myColor === color.id}
								<span class="check">✓</span>
							{/if}
							{#if opponentColor === color.id}
								<span class="taken-x">✕</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		</div>

		{#if !isHost && guestConnected && !guestReady}
			<button class="btn-ready" onclick={toggleReady}>Ready Up</button>
		{/if}

		{#if isHost && guestConnected}
			<button class="btn-play" disabled={!canStart} onclick={startMatch}>
				{canStart ? 'Start Match' : 'Waiting for Ready...'}
			</button>
		{/if}

		{#if !connected}
			<div class="connection-bar disconnected">Reconnecting...</div>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		min-height: 100dvh;
		padding: 2rem;
		gap: 2rem;
	}

	@media (max-width: 480px) {
		.page {
			padding: 1rem;
			padding-top: 3rem;
			justify-content: flex-start;
			gap: 1rem;
		}
	}

	.back-link {
		align-self: flex-start;
		color: var(--color-text-muted);
		background: none;
		border: 1px solid transparent;
		font-size: 0.9rem;
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		font-family: inherit;
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
		align-items: center;
		gap: 1.5rem;
	}

	@media (max-width: 480px) {
		.card {
			padding: 1.25rem;
			gap: 1rem;
			border-radius: 12px;
		}
	}

	h2 {
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--color-text);
	}

	.match-info {
		color: var(--color-text-muted);
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.15em;
	}

	.players {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 0.5rem 0;
	}

	.player {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		border-radius: 10px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		transition: border-color 0.3s;
	}

	.player.ready {
		border-color: var(--color-neon-green);
	}

	.player-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: 'Orbitron', sans-serif;
		font-size: 0.85rem;
		font-weight: 700;
		flex-shrink: 0;
		border: 1px solid;
	}

	.waiting-avatar {
		background: rgba(120, 120, 160, 0.1) !important;
		color: var(--color-text-muted) !important;
		border: 1px dashed var(--color-border) !important;
	}

	.player-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex: 1;
	}

	.player-label {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.player-status {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.player-status.connected {
		color: var(--color-neon-green);
	}

	.ready-badge {
		font-family: 'Orbitron', sans-serif;
		font-size: 0.65rem;
		font-weight: 700;
		color: var(--color-neon-green);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--color-neon-green);
		border-radius: 6px;
		background: rgba(0, 255, 136, 0.08);
	}

	.vs {
		text-align: center;
		font-family: 'Orbitron', sans-serif;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--color-text-muted);
		letter-spacing: 0.2em;
		padding: 0.25rem 0;
	}

	.dot-pulse {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-text-muted);
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	.share-section {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: 10px;
		border: 1px dashed var(--color-neon-blue);
		background: rgba(0, 212, 255, 0.03);
	}

	.share-label {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-neon-blue);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		text-align: center;
	}

	.share-row {
		display: flex;
		gap: 0.4rem;
	}

	.share-input {
		flex: 1;
		padding: 0.5rem 0.7rem;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-text);
		font-size: 0.75rem;
		font-family: monospace;
		outline: none;
		min-width: 0;
	}

	.btn-copy {
		padding: 0.5rem 0.9rem;
		border-radius: 6px;
		border: 1px solid var(--color-neon-blue);
		background: rgba(0, 212, 255, 0.1);
		color: var(--color-neon-blue);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.65rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
	}

	.btn-copy:hover {
		background: rgba(0, 212, 255, 0.2);
		box-shadow: var(--glow-blue);
	}

	.btn-share {
		width: 100%;
		padding: 0.6rem;
		border-radius: 8px;
		border: 1px solid var(--color-neon-pink);
		background: rgba(255, 45, 123, 0.1);
		color: var(--color-neon-pink);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-share:hover {
		background: rgba(255, 45, 123, 0.2);
		box-shadow: var(--glow-pink);
	}

	.share-code {
		font-size: 0.7rem;
		color: var(--color-text-muted);
		text-align: center;
		letter-spacing: 0.05em;
	}

	.share-code strong {
		color: var(--color-text);
		font-family: 'Orbitron', sans-serif;
		letter-spacing: 0.15em;
	}

	.customization {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		border-radius: 10px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
	}

	.custom-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.custom-label {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}

	.name-row {
		display: flex;
		gap: 0.5rem;
	}

	.name-input {
		flex: 1;
		padding: 0.55rem 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
		font-family: inherit;
		font-size: 0.9rem;
		outline: none;
		transition: border-color 0.2s;
	}

	.name-input:focus {
		border-color: var(--color-neon-blue);
	}

	.name-input::placeholder {
		color: var(--color-text-muted);
		opacity: 0.5;
	}

	.btn-set-name {
		padding: 0.55rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--color-neon-blue);
		background: rgba(0, 212, 255, 0.1);
		color: var(--color-neon-blue);
		font-family: 'Orbitron', sans-serif;
		font-size: 0.7rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
	}

	.btn-set-name:hover:not(:disabled) {
		background: rgba(0, 212, 255, 0.2);
	}

	.btn-set-name:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.color-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.color-swatch {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 2px solid transparent;
		background: var(--swatch-color);
		cursor: pointer;
		transition: all 0.2s;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.color-swatch:hover:not(:disabled) {
		transform: scale(1.15);
		box-shadow: 0 0 12px var(--swatch-color);
	}

	.color-swatch.selected {
		border-color: #ffffff;
		box-shadow: 0 0 16px var(--swatch-color), 0 0 4px #ffffff;
		transform: scale(1.1);
	}

	.color-swatch.taken {
		opacity: 0.2;
		cursor: not-allowed;
	}

	.check, .taken-x {
		font-size: 0.85rem;
		font-weight: 900;
		color: #fff;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
	}

	.btn-ready {
		width: 100%;
		padding: 0.85rem;
		border-radius: 10px;
		border: 2px solid var(--color-neon-pink);
		background: linear-gradient(135deg, rgba(255, 45, 123, 0.15), rgba(255, 45, 123, 0.05));
		color: var(--color-neon-pink);
		font-family: 'Orbitron', sans-serif;
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.2s;
		box-shadow: var(--glow-pink);
	}

	.btn-ready:hover {
		background: linear-gradient(135deg, rgba(255, 45, 123, 0.3), rgba(255, 45, 123, 0.1));
		transform: translateY(-2px);
	}

	.btn-play {
		width: 100%;
		padding: 1rem;
		border-radius: 12px;
		border: 2px solid var(--color-neon-green);
		background: linear-gradient(135deg, rgba(0, 255, 136, 0.15), rgba(0, 255, 136, 0.05));
		color: var(--color-neon-green);
		font-family: 'Orbitron', sans-serif;
		font-size: 1.05rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.2s;
		box-shadow: 0 0 20px rgba(0, 255, 136, 0.3), 0 0 60px rgba(0, 255, 136, 0.08);
	}

	.btn-play:hover:not(:disabled) {
		background: linear-gradient(135deg, rgba(0, 255, 136, 0.3), rgba(0, 255, 136, 0.1));
		transform: translateY(-2px);
		box-shadow: 0 0 30px rgba(0, 255, 136, 0.5), 0 0 80px rgba(0, 255, 136, 0.15);
	}

	.btn-play:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.connection-bar {
		width: 100%;
		text-align: center;
		padding: 0.4rem;
		border-radius: 6px;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.05em;
	}

	.disconnected {
		background: rgba(255, 68, 68, 0.1);
		color: #ff4444;
		border: 1px solid rgba(255, 68, 68, 0.3);
	}
</style>
