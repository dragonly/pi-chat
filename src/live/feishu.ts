// Feishu (Lark) live adapter. Uses the official @larksuiteoapi/node-sdk
// WebSocket long-connection client for event delivery, and the open platform
// REST API for sending.
//
// Unlike Telegram long-polling, Feishu's WS stream does not replay messages
// that arrived while the bot was offline. When a previous checkpoint is
// available we perform a best-effort catch-up via /open-apis/im/v1/messages.
// That endpoint requires an im:message.* scope and, depending on the tenant
// policy, may only return messages that mention the bot. Missing scopes are
// downgraded to a non-fatal warning so the live connection still comes up.

import * as lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccountConfig, ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import {
	callFeishu,
	callFeishuForm,
	FeishuApiError,
	type FeishuCredentials,
	fetchFeishuBinary,
	getTenantAccessToken,
} from "../services/feishu-api.js";
import { guessAttachmentKind, readLocalAttachment, storeDownloadedAttachment } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

// Both the WS event and the REST history payload describe a message, but they
// spell the sender id and mentions differently. We normalize to this shape and
// let eventToInput drive both paths.
interface FeishuSenderId {
	open_id?: string;
	user_id?: string;
	union_id?: string;
}

interface FeishuMention {
	key: string;
	id: FeishuSenderId;
	name: string;
}

interface FeishuNormalizedEvent {
	sender: { sender_id: FeishuSenderId; sender_type: string };
	message: {
		message_id: string;
		chat_id: string;
		message_type: string;
		content: string;
		create_time: string;
		mentions?: FeishuMention[];
	};
}

function normalizeId(id: string | undefined, idType: string | undefined): FeishuSenderId {
	if (!id) return {};
	if (idType === "user_id") return { user_id: id };
	if (idType === "union_id") return { union_id: id };
	return { open_id: id };
}

function sdkDomain(account: FeishuAccountConfig): lark.Domain {
	return account.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

function credentialsOf(account: FeishuAccountConfig): FeishuCredentials {
	return { appId: account.appId, appSecret: account.appSecret, domain: account.domain };
}

function stripMentions(text: string, botOpenId: string | undefined, mentions: FeishuMention[] | undefined): string {
	if (!mentions?.length) return text;
	let out = text;
	for (const mention of mentions) {
		// Replace "@_user_N" placeholders with the human-readable name, or drop
		// the bot's own mention to reduce prompt noise.
		if (botOpenId && mention.id.open_id === botOpenId) {
			out = out.split(mention.key).join("").trim();
			continue;
		}
		out = out.split(mention.key).join(`@${mention.name}`);
	}
	return out;
}

function mentionsBot(botOpenId: string | undefined, mentions: FeishuMention[] | undefined): boolean {
	if (!botOpenId || !mentions) return false;
	return mentions.some((mention) => mention.id.open_id === botOpenId);
}

async function downloadMessageResource(
	conversation: ResolvedConversation,
	credentials: FeishuCredentials,
	messageId: string,
	index: number,
	fileKey: string,
	fileName: string,
	type: "image" | "file",
	mimeType?: string,
) {
	const data = await fetchFeishuBinary(credentials, `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`, {
		query: { type },
	});
	return storeDownloadedAttachment(conversation, messageId, index, fileName, data, mimeType);
}

async function eventToInput(
	conversation: ResolvedConversation,
	account: FeishuAccountConfig,
	event: FeishuNormalizedEvent,
): Promise<InboundMessageInput | undefined> {
	const message = event.message;
	if (message.chat_id !== conversation.channel.id) return undefined;
	const senderOpenId = event.sender.sender_id.open_id;
	if (account.botOpenId && senderOpenId === account.botOpenId) return undefined;

	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(message.content) as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	const credentials = credentialsOf(account);
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	const remoteMessageId = message.message_id;
	let text = "";
	let attachmentIndex = 0;

	switch (message.message_type) {
		case "text": {
			text = typeof parsed.text === "string" ? parsed.text : "";
			break;
		}
		case "post": {
			// Rich post: flatten to plain text so the agent gets something legible
			// without maintaining a Feishu-specific renderer in the prompt.
			text = flattenPostContent(parsed);
			break;
		}
		case "image": {
			const imageKey = typeof parsed.image_key === "string" ? parsed.image_key : undefined;
			if (imageKey) {
				attachments.push(
					await downloadMessageResource(
						conversation,
						credentials,
						remoteMessageId,
						++attachmentIndex,
						imageKey,
						`image-${remoteMessageId}`,
						"image",
					),
				);
			}
			break;
		}
		case "file":
		case "audio":
		case "media": {
			const fileKey = typeof parsed.file_key === "string" ? parsed.file_key : undefined;
			const fileName = typeof parsed.file_name === "string" ? parsed.file_name : `file-${remoteMessageId}`;
			if (fileKey) {
				attachments.push(
					await downloadMessageResource(
						conversation,
						credentials,
						remoteMessageId,
						++attachmentIndex,
						fileKey,
						fileName,
						"file",
					),
				);
			}
			break;
		}
		default: {
			// Unsupported types (sticker, system, share_chat, ...) are surfaced as
			// a descriptive placeholder so the agent can at least observe them.
			text = `[feishu unsupported message_type=${message.message_type}]`;
		}
	}

	return {
		messageId: remoteMessageId,
		userId: senderOpenId || event.sender.sender_id.user_id || event.sender.sender_id.union_id || "unknown",
		userName: undefined,
		text: stripMentions(text, account.botOpenId, message.mentions),
		mentionedBot: mentionsBot(account.botOpenId, message.mentions),
		isBot: event.sender.sender_type === "bot" || event.sender.sender_type === "app",
		attachments,
	};
}

function flattenPostContent(parsed: Record<string, unknown>): string {
	const title = typeof parsed.title === "string" ? parsed.title : "";
	const blocks = Array.isArray(parsed.content) ? (parsed.content as Array<Array<Record<string, unknown>>>) : [];
	const lines: string[] = [];
	if (title) lines.push(title);
	for (const block of blocks) {
		const parts = block
			.map((element) => {
				const tag = typeof element.tag === "string" ? element.tag : "";
				if (tag === "text" || tag === "md") return typeof element.text === "string" ? element.text : "";
				if (tag === "a") return typeof element.href === "string" ? element.href : "";
				if (tag === "at") return typeof element.user_name === "string" ? `@${element.user_name}` : "";
				return "";
			})
			.filter(Boolean);
		if (parts.length > 0) lines.push(parts.join(""));
	}
	return lines.join("\n");
}

async function uploadImage(
	credentials: FeishuCredentials,
	name: string,
	data: Uint8Array,
	mimeType?: string,
	signal?: AbortSignal,
): Promise<string> {
	const form = new FormData();
	form.set("image_type", "message");
	form.set("image", new Blob([Buffer.from(data)], { type: mimeType || "image/png" }), name);
	const result = await callFeishuForm<{ image_key: string }>(credentials, "/open-apis/im/v1/images", form, { signal });
	return result.image_key;
}

async function uploadFile(
	credentials: FeishuCredentials,
	name: string,
	kind: "image" | "audio" | "video" | "file",
	data: Uint8Array,
	mimeType?: string,
	signal?: AbortSignal,
): Promise<string> {
	// file_type drives server-side categorization. Feishu enforces concrete
	// codecs for opus/mp4; for arbitrary binaries "stream" is the safe bucket.
	const fileType = kind === "audio" ? "opus" : kind === "video" ? "mp4" : "stream";
	const form = new FormData();
	form.set("file_type", fileType);
	form.set("file_name", name);
	form.set("file", new Blob([Buffer.from(data)], { type: mimeType || "application/octet-stream" }), name);
	const result = await callFeishuForm<{ file_key: string }>(credentials, "/open-apis/im/v1/files", form, { signal });
	return result.file_key;
}

async function sendMessage(
	credentials: FeishuCredentials,
	chatId: string,
	messageType: "text" | "image" | "file" | "audio" | "media",
	content: Record<string, unknown>,
	replyToMessageId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const body = { msg_type: messageType, content: JSON.stringify(content) };
	if (replyToMessageId) {
		const data = await callFeishu<{ message_id: string }>(
			credentials,
			"POST",
			`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`,
			{ body, signal },
		);
		return data.message_id;
	}
	const data = await callFeishu<{ message_id: string }>(credentials, "POST", "/open-apis/im/v1/messages", {
		query: { receive_id_type: "chat_id" },
		body: { receive_id: chatId, ...body },
		signal,
	});
	return data.message_id;
}

async function editTextMessage(
	credentials: FeishuCredentials,
	messageId: string,
	text: string,
	signal?: AbortSignal,
): Promise<void> {
	await callFeishu(credentials, "PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
		body: { msg_type: "text", content: JSON.stringify({ text }) },
		signal,
	});
}

async function deleteMessage(credentials: FeishuCredentials, messageId: string, signal?: AbortSignal): Promise<void> {
	await callFeishu(credentials, "DELETE", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { signal });
}

// A "benign" edit failure is one where refreshing the preview target is
// unnecessary (content unchanged) or impossible (edit window expired). Codes
// taken from Feishu open platform error reference.
const BENIGN_EDIT_ERROR_CODES = new Set<number>([
	230020, // edit-in-place same content
	230021, // edit window expired
	230022, // message already recalled
]);

function isBenignEditError(error: unknown): boolean {
	return error instanceof FeishuApiError && BENIGN_EDIT_ERROR_CODES.has(error.code);
}

interface FeishuHistoryMessageItem {
	message_id: string;
	msg_type: string;
	create_time: string;
	deleted?: boolean;
	chat_id: string;
	sender?: { id: string; id_type: string; sender_type: string };
	body?: { content: string };
	mentions?: Array<{ key: string; id: string; id_type: string; name: string }>;
}

function historyMessageToEvent(item: FeishuHistoryMessageItem): FeishuNormalizedEvent | undefined {
	if (!item.sender || !item.body) return undefined;
	return {
		sender: { sender_id: normalizeId(item.sender.id, item.sender.id_type), sender_type: item.sender.sender_type },
		message: {
			message_id: item.message_id,
			chat_id: item.chat_id,
			message_type: item.msg_type,
			content: item.body.content,
			create_time: item.create_time,
			mentions: item.mentions?.map((mention) => ({
				key: mention.key,
				id: normalizeId(mention.id, mention.id_type),
				name: mention.name,
			})),
		},
	};
}

async function catchUpFeishuMessages(
	conversation: ResolvedConversation,
	account: FeishuAccountConfig,
	handlers: LiveConnectionHandlers,
	resumeCursorMs: string,
): Promise<void> {
	const credentials = credentialsOf(account);
	const startMs = Number.parseInt(resumeCursorMs, 10);
	if (!Number.isFinite(startMs) || startMs <= 0) return;
	// The REST endpoint uses second precision and start_time is inclusive, so
	// step back to the same-second boundary and filter by create_time in ms to
	// avoid re-delivering the last-seen event.
	const startSec = Math.floor(startMs / 1000);
	let pageToken: string | undefined;
	try {
		for (;;) {
			const data = await callFeishu<{
				items?: FeishuHistoryMessageItem[];
				page_token?: string;
				has_more?: boolean;
			}>(credentials, "GET", "/open-apis/im/v1/messages", {
				query: {
					container_id_type: "chat",
					container_id: conversation.channel.id,
					start_time: startSec,
					sort_type: "ByCreateTimeAsc",
					page_size: 50,
					page_token: pageToken,
				},
			});
			for (const item of data.items ?? []) {
				if (item.deleted) continue;
				const createdMs = Number.parseInt(item.create_time, 10);
				if (Number.isFinite(createdMs) && createdMs <= startMs) continue;
				if (account.botOpenId && item.sender?.id_type === "open_id" && item.sender.id === account.botOpenId) continue;
				const event = historyMessageToEvent(item);
				if (!event) continue;
				const input = await eventToInput(conversation, account, event).catch(() => undefined);
				if (!input) continue;
				await handlers.onMessage(input, { messageId: input.messageId, cursor: item.create_time });
			}
			if (!data.has_more || !data.page_token) break;
			pageToken = data.page_token;
		}
	} catch (error) {
		// Scope denial or an invalid chat id should not block the live connection
		// from coming up; surface as a non-fatal warning instead.
		const message = error instanceof Error ? error.message : String(error);
		await handlers.onError(new Error(`Feishu catch-up skipped: ${message}`));
	}
}

export async function connectFeishuLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as FeishuAccountConfig;
	const credentials = credentialsOf(account);
	// Prewarm the token cache so the first outbound send does not race against
	// an incoming event that also needs the token.
	await getTenantAccessToken(credentials);

	// Best-effort replay of messages delivered while the bot was offline. Done
	// before the WS handshake so catch-up records are strictly ordered before
	// any new live events.
	if (resumeState?.cursor) {
		await catchUpFeishuMessages(conversation, account, handlers, resumeState.cursor);
	}

	let disconnectFired = false;
	const fireDisconnect = () => {
		if (disconnectFired) return;
		disconnectFired = true;
		void handlers.onDisconnect?.();
	};

	const wsClient = new lark.WSClient({
		appId: account.appId,
		appSecret: account.appSecret,
		domain: sdkDomain(account),
		loggerLevel: lark.LoggerLevel.error,
		autoReconnect: true,
		onError: (err) => {
			// The SDK exhausts its internal reconnect budget before invoking this;
			// surface a terminal error so pi-chat's outer onDisconnect flow kicks
			// in and establishes a fresh connection. Intermediate reconnect
			// attempts are left silent to match the Discord/Telegram adapters.
			void handlers.onError(err instanceof Error ? err : new Error(String(err)));
			fireDisconnect();
		},
	});

	const dispatcher = new lark.EventDispatcher({}).register({
		"im.message.receive_v1": async (data) => {
			try {
				const event: FeishuNormalizedEvent = {
					sender: {
						sender_id: {
							open_id: data.sender.sender_id?.open_id,
							user_id: data.sender.sender_id?.user_id,
							union_id: data.sender.sender_id?.union_id,
						},
						sender_type: data.sender.sender_type,
					},
					message: {
						message_id: data.message.message_id,
						chat_id: data.message.chat_id,
						message_type: data.message.message_type,
						content: data.message.content,
						create_time: data.message.create_time,
						mentions: data.message.mentions?.map((mention) => ({
							key: mention.key,
							id: {
								open_id: mention.id.open_id,
								user_id: mention.id.user_id,
								union_id: mention.id.union_id,
							},
							name: mention.name,
						})),
					},
				};
				const input = await eventToInput(conversation, account, event);
				if (!input) return "";
				// create_time (ms) drives catch-up on the next reconnect.
				await handlers.onMessage(input, { messageId: input.messageId, cursor: event.message.create_time });
			} catch (error) {
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			}
			return "";
		},
	});

	await wsClient.start({ eventDispatcher: dispatcher });
	// Feishu does not replay missed messages over the WS; the caught-up state
	// is reached immediately once the handshake completes.
	await handlers.onCaughtUp();

	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) =>
			sendMessage(credentials, conversation.channel.id, "text", { text }, replyToMessageId, undefined),
		edit: async (id, text) => {
			try {
				await editTextMessage(credentials, id, text);
			} catch (error) {
				if (isBenignEditError(error)) return;
				throw error;
			}
		},
		delete: async (id) => {
			await deleteMessage(credentials, id).catch(() => undefined);
		},
	});

	return {
		conversation,
		disconnect: async () => {
			try {
				wsClient.close();
			} catch {
				// best effort; SDK may already be closed
			}
		},
		sendImmediate: async (text, replyToMessageId) =>
			sendMessage(credentials, conversation.channel.id, "text", { text }, replyToMessageId, undefined),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) => {
			const rendered = formatMarkdownForService("feishu", text);
			const chunks = rendered.text.length > 0 ? chunkText(rendered.text, maxMessageLength("feishu")) : [];
			let firstId: string | undefined;
			for (let i = 0; i < chunks.length; i++) {
				if (chunks[i].length === 0) continue;
				const reply = i === 0 ? replyToMessageId : undefined;
				const id = await sendMessage(credentials, conversation.channel.id, "text", { text: chunks[i] }, reply, signal);
				firstId ??= id;
			}
			for (const path of attachmentPaths) {
				const file = await readLocalAttachment(path);
				const kind = guessAttachmentKind(file.name, file.mimeType);
				const reply = firstId ? undefined : replyToMessageId;
				let id: string;
				if (kind === "image") {
					const imageKey = await uploadImage(credentials, file.name, file.data, file.mimeType, signal);
					id = await sendMessage(credentials, conversation.channel.id, "image", { image_key: imageKey }, reply, signal);
				} else {
					const fileKey = await uploadFile(credentials, file.name, kind, file.data, file.mimeType, signal);
					const messageType = kind === "audio" ? "audio" : kind === "video" ? "media" : "file";
					id = await sendMessage(
						credentials,
						conversation.channel.id,
						messageType,
						{ file_key: fileKey },
						reply,
						signal,
					);
				}
				firstId ??= id;
			}
			return firstId || "";
		},
		startTyping: async () => {
			// Feishu does not expose a bot-initiated typing indicator in the
			// public API; intentionally left as a no-op so the shared typing
			// loop stays cheap.
		},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
