import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from 'graphql-ws';
import { runExportObjects } from '../src/export/exportClient';
import { EXPORT_OBJECTS_SUBSCRIPTION } from '../src/export/exportObjects';
import { createAuthenticatedWebSocketTransport } from '../src/sessions/graphqlWsTransport';
import type Session from '../src/sessions/Session';

const mocks = vi.hoisted(() => ({ socket: vi.fn(), iterate: vi.fn(), dispose: vi.fn() }));
vi.mock('ws', () => ({
	default: class MockWebSocket {
		constructor(...args: unknown[]) {
			mocks.socket(...args);
		}
	},
}));
vi.mock('graphql-ws', () => ({ createClient: vi.fn(() => ({ iterate: mocks.iterate, dispose: mocks.dispose })) }));
vi.mock('../src/host', () => ({ log: { debug: vi.fn() } }));

const region = {
	name: 'fixture',
	cookieName: 'appSession',
	graphqlUrl: 'https://api.rewst.io/graphql',
	loginUrl: 'https://app.rewst.io',
};
const bundle = { version: 2, exportedAt: 'fixture-date', signing: { signature: 'untouched' }, objects: [] };
const success = {
	data: {
		exportObjects: {
			__typename: 'ExportObjectsStreamSuccessResponse',
			isFinished: true,
			didSucceed: true,
			bundle,
			recommendedFilename: 'fixture.bundle.json',
		},
	},
};

function session(cookie = 'fixture-token') {
	return { profile: { region }, getCookies: vi.fn(async () => cookie) } as unknown as Session;
}

async function* results(...values: unknown[]) {
	for (const value of values) yield value;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.iterate.mockReset().mockReturnValue(results(success));
	mocks.dispose.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('cookie-authenticated export websocket', () => {
	it.each([
		['fixture-token', 'appSession=fixture-token'],
		['padded-token==', 'appSession=padded-token=='],
		['other=value; appSession=fixture-token', 'other=value; appSession=fixture-token'],
	])('sets the Cookie header for %s without opening a real socket', async (stored, expected) => {
		const transport = await createAuthenticatedWebSocketTransport(session(stored));
		expect(transport.url).toBe('wss://api.rewst.io/subscriptions');
		const Socket = transport.webSocketImpl as new (url: string, protocols: string[]) => unknown;
		new Socket(transport.url, ['graphql-transport-ws']);
		expect(mocks.socket).toHaveBeenCalledExactlyOnceWith(transport.url, ['graphql-transport-ws'], {
			headers: { cookie: expected },
		});
		expect(transport.redactionSecrets).toContain(stored);
	});

	it('uses the exact subscription and workflow variables, then disposes on success', async () => {
		const result = await runExportObjects({ session: session(), workflowIds: ['wf-1', 'wf-2'] });
		expect(result.bundle).toBe(bundle);
		expect(createClient).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'wss://api.rewst.io/subscriptions',
				retryAttempts: 0,
				lazy: true,
				webSocketImpl: expect.any(Function),
			}),
		);
		expect(mocks.iterate).toHaveBeenCalledExactlyOnceWith({
			query: EXPORT_OBJECTS_SUBSCRIPTION,
			variables: {
				objects: [
					{ type: 'workflow', id: 'wf-1' },
					{ type: 'workflow', id: 'wf-2' },
				],
			},
		});
		expect(mocks.dispose).toHaveBeenCalled();
	});

	it('redacts GraphQL errors and disposes without retaining a partial bundle', async () => {
		mocks.iterate.mockReturnValue(results({ errors: [{ message: 'Rejected fixture-token' }] }));
		await expect(runExportObjects({ session: session(), workflowIds: ['wf'] })).rejects.toThrow(
			'GraphQL error: Rejected [REDACTED]',
		);
		expect(mocks.dispose).toHaveBeenCalled();
	});

	it('does not read credentials or create a client when already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		const current = session();
		await expect(
			runExportObjects({ session: current, workflowIds: ['wf'], signal: controller.signal }),
		).rejects.toThrow('cancelled before it started');
		expect(current.getCookies).not.toHaveBeenCalled();
		expect(createClient).not.toHaveBeenCalled();
	});

	it('observes cancellation while credentials are being read before constructing a socket', async () => {
		const controller = new AbortController();
		const current = session();
		vi.mocked(current.getCookies).mockImplementation(async () => {
			controller.abort();
			return 'fixture-token';
		});
		await expect(
			runExportObjects({ session: current, workflowIds: ['wf'], signal: controller.signal }),
		).rejects.toThrow('cancelled');
		expect(createClient).not.toHaveBeenCalled();
	});

	it('disposes a blocked subscription when its caller cancels', async () => {
		const controller = new AbortController();
		let started!: () => void;
		const subscribed = new Promise<void>(resolve => {
			started = resolve;
		});
		mocks.iterate.mockImplementation(() => {
			started();
			return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
		});
		const pending = runExportObjects({ session: session(), workflowIds: ['wf'], signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow('cancelled');
		await subscribed;
		controller.abort();
		await rejected;
		expect(mocks.dispose).toHaveBeenCalled();
	});
});
