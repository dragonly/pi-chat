import type { FeishuAccountConfig } from "../core/config-types.js";
import type { AccountValidationResult, DiscoveredChannel, DiscoverySnapshot } from "../core/discovery-types.js";
import { getFeishuBotInfo, listFeishuChats } from "./feishu-api.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

function credentialsFromDraft(draft: AccountDraft): { appId: string; appSecret: string; domain: "feishu" | "lark" } {
	if (draft.service !== "feishu") throw new Error("Expected feishu draft");
	return { appId: draft.appId, appSecret: draft.appSecret, domain: draft.domain };
}

function credentialsFromAccount(account: FeishuAccountConfig): {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
} {
	return { appId: account.appId, appSecret: account.appSecret, domain: account.domain };
}

export const feishuDiscoveryProvider: DiscoveryProvider = {
	service: "feishu",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		const credentials = credentialsFromDraft(draft);
		const bot = await getFeishuBotInfo(credentials);
		return {
			identity: {
				id: bot.open_id,
				name: bot.app_name,
				userName: bot.app_name,
			},
			warnings:
				bot.activate_status === 2
					? undefined
					: [
							"Feishu bot is not activated. Publish the app version and enable the bot capability in the developer console before connecting.",
						],
		};
	},
	async fetchSnapshot(accountId: string, account: FeishuAccountConfig): Promise<DiscoverySnapshot> {
		const credentials = credentialsFromAccount(account);
		const bot = await getFeishuBotInfo(credentials);
		let chats: Awaited<ReturnType<typeof listFeishuChats>> = [];
		const warnings: string[] = [];
		try {
			chats = await listFeishuChats(credentials);
		} catch (error) {
			warnings.push(
				`Failed to list chats: ${error instanceof Error ? error.message : String(error)}. Grant the im:chat scope to the app and invite the bot into target chats.`,
			);
		}
		const channels: DiscoveredChannel[] = chats
			.map((chat) => ({ id: chat.chat_id, name: chat.name || chat.chat_id }))
			.sort((a, b) => a.name.localeCompare(b.name));
		return {
			accountId,
			service: "feishu",
			fetchedAt: new Date().toISOString(),
			identity: {
				id: bot.open_id,
				name: bot.app_name,
				userName: bot.app_name,
			},
			channels,
			users: [],
			roles: [],
			warnings: warnings.length > 0 ? warnings : undefined,
			capabilities: {
				canListChannels: channels.length > 0,
				canListUsers: false,
				canListRoles: false,
			},
		};
	},
};
