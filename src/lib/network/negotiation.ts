import type { PlayerRole, TransportMode } from './types.js';

export function selectTransportMode(ready: ReadonlySet<PlayerRole>): TransportMode {
	return ready.has('host') && ready.has('guest') ? 'direct' : 'server';
}
