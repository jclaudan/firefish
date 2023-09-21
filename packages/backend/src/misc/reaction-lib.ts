import { emojiRegex } from "./emoji-regex.js";
import { fetchMeta } from "./fetch-meta.js";
import { Emojis } from "@/models/index.js";
import { toPunyNullable } from "./convert-host.js";
import { IsNull } from "typeorm";
import { EmojiCache } from "@/misc/populate-emojis.js";
import type { Emoji } from "@/models/entities/emoji.js";

export async function getFallbackReaction() {
	const meta = await fetchMeta();
	const name = meta.defaultReaction;

	const match = emojiRegex.exec(name);
	if (match) {
		const unicode = match[0];
		return { name: unicode, emoji: null };
	}

	const emoji = await EmojiCache.fetch(`${name} ${null}`, () =>
		Emojis.findOneBy({
			name,
			host: IsNull(),
		}),
	);

	return { name, emoji };
}

export function convertReactions(reactions: Record<string, number>) {
	const result = new Map();

	for (const reaction in reactions) {
		if (reactions[reaction] <= 0) continue;

		const decoded = decodeReaction(reaction).reaction;
		result.set(decoded, (result.get(decoded) || 0) + reactions[reaction]);
	}

	return Object.fromEntries(result);
}

export async function toDbReaction(
	reaction?: string | null,
	reacterHost?: string | null,
): Promise<{ name: string; emoji: Emoji | null }> {
	if (!reaction) return await getFallbackReaction();

	const _reacterHost = toPunyNullable(reacterHost);

	if (reaction === "♥️") return { name: "❤️", emoji: null };

	// Allow unicode reactions
	const match = emojiRegex.exec(reaction);
	if (match) {
		const unicode = match[0];
		return { name: unicode, emoji: null };
	}

	const custom = reaction.match(/^:([\w+-]+)(?:@\.)?:$/);
	if (custom) {
		const name = custom[1];
		const emoji = await EmojiCache.fetch(`${name} ${_reacterHost}`, () =>
			Emojis.findOneBy({
				name,
				host: _reacterHost || IsNull(),
			}),
		);

		if (emoji) {
			const emojiName = _reacterHost
				? `:${name}@${_reacterHost}:`
				: `:${name}:`;
			return { name: emojiName, emoji };
		}
	}

	return await getFallbackReaction();
}

type DecodedReaction = {
	/**
	 * リアクション名 (Unicode Emoji or ':name@hostname' or ':name@.:')
	 */
	reaction: string;

	/**
	 * name (カスタム絵文字の場合name, Emojiクエリに使う)
	 */
	name?: string;

	/**
	 * host (カスタム絵文字の場合host, Emojiクエリに使う)
	 */
	host?: string | null;
};

export function decodeReaction(str: string): DecodedReaction {
	const custom = str.match(/^:([\w+-]+)(?:@([\w.-]+))?:$/);

	if (custom) {
		const name = custom[1];
		const host = custom[2] || null;

		return {
			reaction: `:${name}@${host || "."}:`, // ローカル分は@以降を省略するのではなく.にする
			name,
			host,
		};
	}

	return {
		reaction: str,
		name: undefined,
		host: undefined,
	};
}
