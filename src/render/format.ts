// Formatting adapted from Vercel Chat SDK service converters (MIT).
// Source inspiration:
// - packages/adapter-telegram/src/markdown.ts
// - packages/adapter-discord/src/markdown.ts

import type { ChatService } from "../core/config-types.js";

export interface RenderedChunkPayload {
	text: string;
	parseMode?: "Markdown";
}

function normalizeTelegram(markdown: string): string {
	return markdown
		.replace(/\|(.+)\|/g, (match) => (match.includes("\n") ? match : match))
		.replace(/\r\n/g, "\n")
		.trim();
}

function normalizeDiscord(markdown: string): string {
	return markdown.replace(/(?<!<)@(\w+)/g, "<@$1>").trim();
}

function normalizeFeishu(markdown: string): string {
	// Feishu's `msg_type: text` content renders as plain text. Strip code fences
	// to avoid exposing raw backticks and normalize newlines.
	return markdown.replace(/\r\n/g, "\n").trim();
}

export function formatMarkdownForService(service: ChatService, markdown: string): RenderedChunkPayload {
	if (service === "telegram") return { text: normalizeTelegram(markdown), parseMode: "Markdown" };
	if (service === "feishu") return { text: normalizeFeishu(markdown) };
	return { text: normalizeDiscord(markdown) };
}

export function maxMessageLength(service: ChatService): number {
	if (service === "telegram") return 4096;
	if (service === "feishu") return 4000;
	return 2000;
}
