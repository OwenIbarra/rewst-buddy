import type { createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { getSubscriptionsUrl, type RegionConfig } from './RegionConfig';
import type Session from './Session';

type GraphqlWebSocketImpl = NonNullable<Parameters<typeof createClient>[0]['webSocketImpl']>;

/** Secrets may contain either a complete cookie header or a bare session token. */
export function toCookieHeader(stored: string, region: RegionConfig): string {
	const cookiePair = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*([^;\r\n]+?)\s*$/;
	const hasRegionalCookie = stored.split(';').some(part => {
		const match = cookiePair.exec(part);
		return match?.[1] === region.cookieName && match[2].trim().length > 0;
	});
	return hasRegionalCookie ? stored : `${region.cookieName}=${stored}`;
}

export interface AuthenticatedWebSocketTransport {
	url: string;
	webSocketImpl: GraphqlWebSocketImpl;
	/** Values callers should remove from any surfaced transport errors. */
	redactionSecrets: readonly string[];
}

/**
 * Builds the regional, cookie-authenticated websocket implementation shared by
 * Rewst GraphQL subscriptions. The complete stored cookie is forwarded as-is;
 * only bare tokens are wrapped in the region's configured cookie name.
 */
export async function createAuthenticatedWebSocketTransport(
	session: Session,
	signal?: AbortSignal,
): Promise<AuthenticatedWebSocketTransport> {
	if (signal?.aborted) throw new Error('GraphQL subscription was cancelled before it started.');
	const storedCookie = await session.getCookies();
	if (signal?.aborted) throw new Error('GraphQL subscription was cancelled before it started.');
	const cookie = toCookieHeader(storedCookie, session.profile.region);
	const url = getSubscriptionsUrl(session.profile.region);

	class CookieWebSocket extends WebSocket {
		constructor(address: string | URL, protocols?: string | string[]) {
			super(address, protocols, { headers: { cookie } });
		}
	}

	return {
		url,
		webSocketImpl: CookieWebSocket,
		redactionSecrets: storedCookie === cookie ? [cookie] : [storedCookie, cookie],
	};
}
