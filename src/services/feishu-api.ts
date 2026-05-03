// Minimal Feishu/Lark Open Platform REST client shared by discovery and live adapter.
// Keeps a per-credential tenant_access_token cache and exposes typed fetch helpers.

import type { FeishuDomain } from "../core/config-types.js";

export function feishuBaseUrl(domain: FeishuDomain): string {
	return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export interface FeishuCredentials {
	appId: string;
	appSecret: string;
	domain: FeishuDomain;
}

interface TokenCacheEntry {
	token: string;
	expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

function credentialsKey(credentials: FeishuCredentials): string {
	return `${credentials.domain}:${credentials.appId}:${credentials.appSecret}`;
}

interface TenantAccessTokenResponse {
	code: number;
	msg?: string;
	tenant_access_token?: string;
	expire?: number;
}

export async function getTenantAccessToken(credentials: FeishuCredentials): Promise<string> {
	const key = credentialsKey(credentials);
	const cached = tokenCache.get(key);
	const now = Date.now();
	if (cached && cached.expiresAt - 60_000 > now) return cached.token;
	const response = await fetch(`${feishuBaseUrl(credentials.domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
	});
	const data = (await response.json()) as TenantAccessTokenResponse;
	if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
		throw new Error(data.msg || `Feishu tenant_access_token failed (code ${data.code})`);
	}
	const expiresAt = now + Math.max(60, data.expire ?? 7200) * 1000;
	tokenCache.set(key, { token: data.tenant_access_token, expiresAt });
	return data.tenant_access_token;
}

export function invalidateFeishuToken(credentials: FeishuCredentials): void {
	tokenCache.delete(credentialsKey(credentials));
}

export interface FeishuResponse<T> {
	code: number;
	msg?: string;
	data?: T;
}

export class FeishuApiError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "FeishuApiError";
	}
}

export async function callFeishu<T>(
	credentials: FeishuCredentials,
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
	path: string,
	options: {
		query?: Record<string, string | number | boolean | undefined>;
		body?: unknown;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	const url = new URL(`${feishuBaseUrl(credentials.domain)}${path}`);
	for (const [name, value] of Object.entries(options.query ?? {})) {
		if (value === undefined) continue;
		url.searchParams.set(name, String(value));
	}
	const doFetch = async (token: string): Promise<Response> =>
		fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/json; charset=utf-8",
			},
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: options.signal,
		});
	let token = await getTenantAccessToken(credentials);
	let response = await doFetch(token);
	if (response.status === 401) {
		invalidateFeishuToken(credentials);
		token = await getTenantAccessToken(credentials);
		response = await doFetch(token);
	}
	const data = (await response.json()) as FeishuResponse<T>;
	if (!response.ok || data.code !== 0) {
		throw new FeishuApiError(data.code, data.msg || `Feishu API ${method} ${path} failed (code ${data.code})`);
	}
	if (data.data === undefined) return undefined as unknown as T;
	return data.data;
}

export async function callFeishuForm<T>(
	credentials: FeishuCredentials,
	path: string,
	form: FormData,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	const url = new URL(`${feishuBaseUrl(credentials.domain)}${path}`);
	const doFetch = async (token: string): Promise<Response> =>
		fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
			signal: options.signal,
		});
	let token = await getTenantAccessToken(credentials);
	let response = await doFetch(token);
	if (response.status === 401) {
		invalidateFeishuToken(credentials);
		token = await getTenantAccessToken(credentials);
		response = await doFetch(token);
	}
	const data = (await response.json()) as FeishuResponse<T>;
	if (!response.ok || data.code !== 0) {
		throw new FeishuApiError(data.code, data.msg || `Feishu API POST ${path} failed (code ${data.code})`);
	}
	if (data.data === undefined) return undefined as unknown as T;
	return data.data;
}

export async function fetchFeishuBinary(
	credentials: FeishuCredentials,
	path: string,
	options: { query?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	const url = new URL(`${feishuBaseUrl(credentials.domain)}${path}`);
	for (const [name, value] of Object.entries(options.query ?? {})) {
		if (value === undefined) continue;
		url.searchParams.set(name, String(value));
	}
	const doFetch = async (token: string): Promise<Response> =>
		fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: options.signal });
	let token = await getTenantAccessToken(credentials);
	let response = await doFetch(token);
	if (response.status === 401) {
		invalidateFeishuToken(credentials);
		token = await getTenantAccessToken(credentials);
		response = await doFetch(token);
	}
	if (!response.ok) throw new Error(`Feishu download failed ${response.status}: ${path}`);
	return new Uint8Array(await response.arrayBuffer());
}

export interface FeishuBotInfo {
	activate_status: number;
	app_name: string;
	avatar_url: string;
	ip_white_list?: string[];
	open_id: string;
}

export async function getFeishuBotInfo(credentials: FeishuCredentials): Promise<FeishuBotInfo> {
	const data = await callFeishu<{ bot: FeishuBotInfo }>(credentials, "GET", "/open-apis/bot/v3/info");
	return data.bot;
}

export interface FeishuChatListItem {
	chat_id: string;
	avatar?: string;
	name: string;
	description?: string;
	owner_id?: string;
	external?: boolean;
	tenant_key?: string;
	chat_status?: string;
}

export async function listFeishuChats(credentials: FeishuCredentials): Promise<FeishuChatListItem[]> {
	const items: FeishuChatListItem[] = [];
	let pageToken: string | undefined;
	for (;;) {
		const data = await callFeishu<{ items?: FeishuChatListItem[]; page_token?: string; has_more?: boolean }>(
			credentials,
			"GET",
			"/open-apis/im/v1/chats",
			{ query: { page_size: 100, page_token: pageToken } },
		);
		for (const item of data.items ?? []) items.push(item);
		if (!data.has_more || !data.page_token) break;
		pageToken = data.page_token;
	}
	return items;
}
