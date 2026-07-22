import { describe, expect, it } from 'vitest';
import { selectTransportMode } from './negotiation.js';

describe('transport mode negotiation', () => {
	it('selects direct only after both peers explicitly report ready', () => {
		expect(selectTransportMode(new Set())).toBe('server');
		expect(selectTransportMode(new Set(['host']))).toBe('server');
		expect(selectTransportMode(new Set(['guest']))).toBe('server');
		expect(selectTransportMode(new Set(['host', 'guest']))).toBe('direct');
	});
});
