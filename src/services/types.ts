import type { ChatAccountConfig, ChatService, FeishuDomain } from "../core/config-types.js";
import type { AccountValidationResult, DiscoverySnapshot } from "../core/discovery-types.js";

export interface TelegramAccountDraft {
	service: "telegram";
	botToken: string;
	name?: string;
}

export interface DiscordAccountDraft {
	service: "discord";
	botToken: string;
	name?: string;
}

export interface FeishuAccountDraft {
	service: "feishu";
	appId: string;
	appSecret: string;
	domain: FeishuDomain;
	name?: string;
}

export type AccountDraft = TelegramAccountDraft | DiscordAccountDraft | FeishuAccountDraft;

export interface DiscoveryProvider {
	service: ChatService;
	validate(draft: AccountDraft): Promise<AccountValidationResult>;
	fetchSnapshot(accountId: string, account: ChatAccountConfig): Promise<DiscoverySnapshot>;
}
