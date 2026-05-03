import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { ChatConfig, FeishuAccountConfig, FeishuDomain } from "../core/config-types.js";
import { makeAccountKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, selectItem, showNotice } from "./dialogs.js";

export async function createFeishuAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const domainChoice = (await selectItem(ctx, "Feishu edition", [
		{ value: "feishu", label: "Feishu (open.feishu.cn)", description: "国内版飞书" },
		{ value: "lark", label: "Lark (open.larksuite.com)", description: "International edition" },
	])) as FeishuDomain | null;
	if (!domainChoice) return undefined;

	const appId = (await ctx.ui.input("Feishu App ID", "cli_xxxxxxxxxxxx"))?.trim();
	if (!appId) return undefined;
	const appSecret = (await ctx.ui.input("Feishu App Secret", ""))?.trim();
	if (!appSecret) return undefined;

	const validation = await runWithLoader(ctx, "Validating Feishu credentials...", () =>
		validateAccountDraft({
			service: "feishu",
			appId,
			appSecret,
			domain: domainChoice,
		}),
	);
	if (validation.error) {
		await showNotice(ctx, "Feishu setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;

	const accountLabel = await ctx.ui.input(
		"Account label",
		validation.value.identity.name || validation.value.identity.userName || "feishu",
	);
	if (accountLabel === undefined) return undefined;

	const baseAccountKey = makeAccountKey(
		"feishu",
		accountLabel.trim() || validation.value.identity.name || validation.value.identity.userName || "feishu",
	);
	const accountKey = ensureUniqueAccountKey(config, baseAccountKey);

	let account: FeishuAccountConfig = {
		service: "feishu",
		name: accountLabel.trim() || undefined,
		appId,
		appSecret,
		domain: domainChoice,
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, "Fetching Feishu bot info and chat list...", () =>
		refreshAccountSnapshot(accountKey, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Feishu setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as FeishuAccountConfig;
	config.accounts[accountKey] = account;
	await saveChatConfig(config);

	const warnings = snapshot.value.warnings ?? [];
	if (warnings.length > 0) {
		await showNotice(ctx, "Feishu warnings", warnings.join("\n"), "warning");
	}
	await showNotice(
		ctx,
		"Feishu account created",
		`Created ${accountKey}. Invite the bot to the target chats, then select them from the account menu.`,
		"info",
	);
	return accountKey;
}

function ensureUniqueAccountKey(config: ChatConfig, base: string): string {
	if (!config.accounts[base]) return base;
	let index = 2;
	while (config.accounts[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}
