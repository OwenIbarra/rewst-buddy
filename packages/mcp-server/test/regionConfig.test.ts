import { describe, expect, it } from 'vitest';
import { assertSecureRegionConfig, getSubscriptionsUrl, type RegionConfig } from '../src/sessions/RegionConfig';

function region(overrides: Partial<RegionConfig> = {}): RegionConfig {
	return {
		name: 'Test',
		cookieName: 'appSession',
		graphqlUrl: 'https://api.example.test/graphql',
		loginUrl: 'https://app.example.test',
		...overrides,
	};
}

describe('region subscriptions origin binding', () => {
	it('rejects an explicit subscriptionsUrl on a different remote host', () => {
		expect(() =>
			assertSecureRegionConfig(region({ subscriptionsUrl: 'wss://events.example.test/custom' })),
		).toThrow('must share the graphqlUrl origin');
	});

	it('rejects a remote subscriptionsUrl on the same host but a different port', () => {
		expect(() =>
			assertSecureRegionConfig(region({ subscriptionsUrl: 'wss://api.example.test:8443/subscriptions' })),
		).toThrow('must share the graphqlUrl origin');
	});

	it('rejects a websocket scheme that does not map from the GraphQL scheme', () => {
		expect(() =>
			assertSecureRegionConfig(
				region({
					graphqlUrl: 'http://localhost:9999/graphql',
					subscriptionsUrl: 'wss://localhost:9999/subscriptions',
				}),
			),
		).toThrow('must use the websocket scheme matching graphqlUrl');
	});

	it('accepts a same-origin explicit subscriptionsUrl with the mapped scheme, verbatim', () => {
		const config = region({ subscriptionsUrl: 'wss://api.example.test/custom' });
		expect(assertSecureRegionConfig(config)).toBe(config);
		expect(getSubscriptionsUrl(config)).toBe('wss://api.example.test/custom');
	});

	it('accepts loopback-equivalent hosts with the mapped scheme and free ports', () => {
		// Local dev/test shape: graphql on localhost:9999, subscriptions on an
		// ephemeral 127.0.0.1 port. The cookie never leaves the machine.
		const config = region({
			graphqlUrl: 'http://localhost:9999/graphql',
			loginUrl: 'http://localhost:9999/login',
			subscriptionsUrl: 'ws://127.0.0.1:4567/subscriptions',
		});
		expect(getSubscriptionsUrl(config)).toBe('ws://127.0.0.1:4567/subscriptions');
	});

	it('still derives the subscriptions endpoint from graphqlUrl when omitted', () => {
		expect(getSubscriptionsUrl(region())).toBe('wss://api.example.test/subscriptions');
	});
});
