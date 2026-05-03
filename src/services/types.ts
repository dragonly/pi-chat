import type { ChatAccountConfig, ChatService, FeishuDomain } from "../core/config-types.js";
import type { AccountValidationResult, DiscoverySnapshot } from "../core/discovery-types.js";

export interface FeishuAccountDraft {
	appId: string;
	appSecret: string;
	domain: FeishuDomain;
}

export interface AccountDraft {
	service: ChatService;
	botToken: string;
	name?: string;
	feishu?: FeishuAccountDraft;
}

export interface DiscoveryProvider {
	service: ChatService;
	validate(draft: AccountDraft): Promise<AccountValidationResult>;
	fetchSnapshot(accountId: string, account: ChatAccountConfig): Promise<DiscoverySnapshot>;
}
