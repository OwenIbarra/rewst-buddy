import { getRuntimeHost, log } from '../../packages/mcp-server/src/host';
import { isIP } from 'node:net';

export interface RegionConfig {
	name: string;
	cookieName: string;
	graphqlUrl: string;
	loginUrl: string;
	subscriptionsUrl?: string;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (host === 'localhost') return true;
	const version = isIP(host);
	if (version === 4) return host.split('.')[0] === '127';
	if (version === 6) return host === '::1' || /^::ffff:127\./i.test(host);
	return false;
}

function effectivePort(url: URL): string {
	if (url.port !== '') return url.port;
	return url.protocol === 'wss:' || url.protocol === 'https:' ? '443' : '80';
}

/**
 * An explicit subscriptionsUrl receives the session cookie, so it must stay
 * inside graphqlUrl's trust domain: the mapped websocket scheme (wss for
 * https, ws for http) on the same host and port. Loopback hosts (localhost,
 * 127.x, ::1, ...) are interchangeable with free ports so local development
 * and tests can point at an ephemeral local server; a remote endpoint must
 * match graphqlUrl's origin exactly and can never siphon the cookie elsewhere.
 */
function assertSubscriptionsOrigin(graphqlUrl: string, subscriptionsUrl: string): void {
	const graphql = new URL(graphqlUrl);
	const subscriptions = new URL(subscriptionsUrl);
	if (subscriptions.protocol !== (graphql.protocol === 'https:' ? 'wss:' : 'ws:')) {
		throw new Error(
			'Region subscriptionsUrl must use the websocket scheme matching graphqlUrl (wss for https, ws for http).',
		);
	}
	if (isLoopbackHost(graphql.hostname) && isLoopbackHost(subscriptions.hostname)) return;
	const sameHost = graphql.hostname.toLowerCase() === subscriptions.hostname.toLowerCase();
	if (!sameHost || effectivePort(graphql) !== effectivePort(subscriptions)) {
		throw new Error('Region subscriptionsUrl must share the graphqlUrl origin (same host and port).');
	}
}

function assertSecureEndpoint(value: string, field: string, websocket: boolean): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Region ${field} must be a valid absolute URL.`);
	}
	const secureProtocol = websocket ? 'wss:' : 'https:';
	const loopbackProtocol = websocket ? 'ws:' : 'http:';
	if (url.protocol === secureProtocol) return;
	if (url.protocol === loopbackProtocol && isLoopbackHost(url.hostname)) return;
	throw new Error(
		`Region ${field} must use ${secureProtocol.slice(0, -1)}, except ${loopbackProtocol.slice(0, -1)} is allowed for localhost or a loopback IP address.`,
	);
}

/**
 * Session cookies are sent to each configured endpoint, so remote endpoints
 * must be encrypted. Plaintext HTTP/WS is reserved for literal local test and
 * development hosts and is never accepted for an arbitrary hostname.
 */
export function assertSecureRegionConfig(config: RegionConfig): RegionConfig {
	for (const field of ['name', 'cookieName', 'graphqlUrl', 'loginUrl'] as const) {
		if (typeof config[field] !== 'string' || config[field].trim() === '') {
			throw new Error(`Region ${field} is required.`);
		}
	}
	assertSecureEndpoint(config.graphqlUrl, 'graphqlUrl', false);
	assertSecureEndpoint(config.loginUrl, 'loginUrl', false);
	if (config.subscriptionsUrl !== undefined) {
		if (typeof config.subscriptionsUrl !== 'string' || config.subscriptionsUrl.trim() === '') {
			throw new Error('Region subscriptionsUrl must be a non-empty string when provided.');
		}
		assertSecureEndpoint(config.subscriptionsUrl, 'subscriptionsUrl', true);
		assertSubscriptionsOrigin(config.graphqlUrl, config.subscriptionsUrl);
	}
	return config;
}

// The WS endpoint lives at /subscriptions, not /graphql (a WS upgrade against
// /graphql falls through to Apollo's HTTP handler and returns 400).
export function getSubscriptionsUrl(config: RegionConfig): string {
	assertSecureRegionConfig(config);
	if (config.subscriptionsUrl) return config.subscriptionsUrl;

	const url = new URL(config.graphqlUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/subscriptions';
	url.search = '';
	url.hash = '';
	return url.toString();
}

export function getRegionConfigs(): RegionConfig[] {
	const regions = getRuntimeHost().getSetting<RegionConfig[]>('regions', [
		{
			name: 'North America',
			cookieName: 'appSession',
			graphqlUrl: 'https://api.rewst.io/graphql',
			loginUrl: 'https://app.rewst.io',
		},
		{
			name: 'United Kingdom',
			cookieName: 'euAppSession',
			graphqlUrl: 'https://api.eu.rewst.io/graphql',
			loginUrl: 'https://app.eu.rewst.io',
		},
		{
			name: 'Asia',
			cookieName: 'auAppSession',
			graphqlUrl: 'https://api.rewst.asia/graphql',
			loginUrl: 'https://app.rewst.asia',
		},
		{
			name: 'Europe',
			cookieName: 'deAppSession',
			graphqlUrl: 'https://api.rewst.eu/graphql',
			loginUrl: 'https://app.rewst.eu',
		},
	]);

	if (regions.length === 0)
		throw log.notifyError(
			'No regions were found in runtime host settings. Sessions cannot be created if there are no defined regions',
		);
	return regions.map(assertSecureRegionConfig);
}
