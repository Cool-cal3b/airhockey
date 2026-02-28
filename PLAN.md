# Air Hockey LAN Game — Project Plan

**Stack:** SvelteKit (Svelte 5) · TypeScript · Phaser 3.88 · Socket.io 4.8

---

## 1. Project Scaffolding

- [x] Initialize SvelteKit project with TypeScript
- [x] Install Phaser 3.88 (`phaser`)
- [x] Install Socket.io server (`socket.io`) and client (`socket.io-client`)
- [x] Configure Vite to handle Phaser's global imports
- [x] Set up project folder structure:
  - `src/lib/game/` — Phaser scenes, physics, entities
  - `src/lib/server/` — Socket.io server logic
  - `src/lib/network/` — shared types, protocol, message definitions
  - `src/routes/` — SvelteKit pages (lobby, game)

---

## 2. Core Game Engine (Phaser — Server Authoritative)

- [x] Create the `PlayScene` Phaser scene
- [x] Draw the rink (table surface, center line, goals, rounded corners)
- [x] Implement the puck entity with physics body (circle, bounce, friction)
- [x] Implement paddle entities (player 1 and player 2) with physics bodies
- [x] Paddle movement follows mouse/touch input (clamped to player's half)
- [x] Puck-paddle collision with velocity transfer
- [x] Puck-wall collision (bounce off sides, pass through goals)
- [x] Goal detection (puck fully crosses goal line)
- [x] Score tracking and reset after a goal (puck returns to center)
- [x] Win condition (first to N, configurable)
- [x] Puck speed cap to prevent tunneling through walls

---

## 3. Networking — Socket.io Server

- [x] Integrate Socket.io server with SvelteKit's dev server (Vite plugin)
- [x] Define the network protocol (TypeScript types shared between client/server):
  - `PlayerJoin`, `PlayerReady`
  - `PaddleMove` (position update from client)
  - `GameState` (authoritative puck position, paddle positions, score)
  - `GoalScored`, `GameOver`
- [x] Room / lobby system:
  - Host creates a room, gets a room code
  - Client joins with the room code or auto-discovers on LAN
- [x] Server-authoritative game loop:
  - Server runs physics simulation for the puck at a fixed tick rate (~60 Hz)
  - Clients send only their paddle position
  - Server broadcasts `GameState` snapshots to both clients
- [x] Handle player disconnect and reconnect gracefully

---

## 4. Networking — Client Side

- [x] Connect to Socket.io server on game start
- [x] Send local paddle position to server on each frame
- [x] Receive and apply authoritative `GameState` updates:
  - Snap puck position from server state
  - Snap opponent paddle to server-reported position
- [x] Handle latency: client-side prediction for local paddle (no delay on own input)
- [x] Display connection status indicator (connected / reconnecting / lost)

---

## 5. LAN Discovery

- Display the host machine's local IP address so the second player can connect
- Provide a simple "Enter Host IP" input for the joining player
- (Stretch) mDNS or UDP broadcast for automatic LAN host discovery

---

## 6. UI / UX — SvelteKit Pages

- [x] **Home / Landing page** — Title, "Host Game" and "Join Game" buttons
- [x] **Host Game page** — Game name input, score picker, create & start
- [x] **Join Game page** — LAN game scanner, manual IP connect
- [x] **Waiting Room page** — Player cards, ready status, host IP share, start match
- [x] **Game page** — Phaser canvas rink, paddles, puck, HUD score overlay
- [x] **Game Over overlay** — Winner announcement, "Back to Menu" button
- [ ] Responsive layout — works on desktop browsers and tablets on the same LAN
- [x] Clean, modern visual design (dark theme, neon accents to match air hockey aesthetic)

---

## 7. Game Polish

- Sound effects (puck hit, wall bounce, goal scored, game over)
- Visual effects:
  - Puck trail / glow
  - Goal flash animation
  - Paddle hit particle burst
- Countdown (3-2-1) before round starts
- Smooth camera shake on goal
- Animate score changes

---

## 8. Configuration & Settings

- Configurable match length (first to 5 / 7 / 10)
- Configurable puck speed and paddle size (host sets before starting)
- Option to toggle sound on/off

---

## 9. Testing & QA

- Test on two devices on the same Wi-Fi network
- Measure and optimize input-to-display latency (target < 50ms on LAN)
- Stress test: fast paddle movements, rapid collisions, edge cases (puck stuck in corner)
- Test reconnection behavior (player drops and rejoins)
- Cross-browser testing (Chrome, Firefox, Safari)

---

## 10. Docker & Deployment

- [x] Create a `Dockerfile` (multi-stage: build SvelteKit, then run with Node)
- [x] Create a `docker-compose.yml` for one-command startup
- [x] Configure SvelteKit adapter-node for production
- [ ] Expose the game port (e.g. 3000) and ensure Socket.io works through Docker networking
- [ ] Build production bundle and verify Phaser tree-shaking / bundle size
- [ ] Write a README with setup instructions:
  - `docker compose up` to launch
  - How to find the host IP for LAN players to connect

---

### Tech Versions (as of Feb 2026)

| Package    | Version          |
| ---------- | ---------------- |
| SvelteKit  | 2.53.x           |
| Svelte     | 5.x (runes)      |
| Phaser     | 3.88.2           |
| Socket.io  | 4.8.3            |
| TypeScript | 5.x              |
| Docker     | multi-stage Node 22 |

---

## 11. Game Logic Architecture

### Data Flow

- Both clients send `paddleMove(x, y)` to the server each frame
- Server runs physics at 60Hz via `GameSession` class (setInterval)
- Server broadcasts `gameState` to both clients each tick
- Clients render server state; local paddle follows pointer directly for zero-latency feel

### File Map

| File | Purpose |
| --- | --- |
| `src/lib/game/constants.ts` | Shared dimensions, speeds, tick rate |
| `src/lib/game/physics.ts` | Pure collision math (circle-circle, containment, clamping) |
| `src/lib/game/input.ts` | PointerInput class (mouse + touch via Pointer Events API) |
| `src/lib/game/scenes/PlayScene.ts` | Phaser scene: renders server state, sends paddle input |
| `src/lib/game/PhaserGame.svelte` | Svelte wrapper: mounts/destroys Phaser lifecycle |
| `src/lib/server/game-loop.ts` | GameSession class: server-side physics loop per room |
| `src/lib/network/types.ts` | GameState, paddleMove, countdown, goalScored, gameOver events |

### Server GameSession Lifecycle

1. Host clicks "Start Match" -> server creates `GameSession`
2. 3-2-1 countdown (server emits `countdown` events)
3. Physics loop starts at 60Hz
4. On goal: pause, reset puck, resume (or end if maxScore reached)
5. On game over: emit `gameOver`, destroy session
6. On disconnect: stop session, close room

### Mobile Future-Proofing

- Pointer Events API (one code path for mouse + touch)
- Logical 400x700 coordinate system, Phaser `Scale.FIT` for any screen
- Vertical rink orientation (portrait-friendly)
- No hover-dependent interactions
