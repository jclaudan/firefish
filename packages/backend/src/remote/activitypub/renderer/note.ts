import { In, IsNull } from "typeorm";
import config from "@/config/index.js";
import type { Note, IMentionedRemoteUsers } from "@/models/entities/note.js";
import type { DriveFile } from "@/models/entities/drive-file.js";
import { DriveFiles, Notes, Users, Emojis, Polls } from "@/models/index.js";
import type { Emoji } from "@/models/entities/emoji.js";
import type { Poll } from "@/models/entities/poll.js";
import toHtml from "@/remote/activitypub/misc/get-note-html.js";
import detectLanguage from "@/misc/detect-language.js";
import renderEmoji from "./emoji.js";
import renderMention from "./mention.js";
import renderHashtag from "./hashtag.js";
import renderDocument from "./document.js";
import {
	type ScyllaPoll,
	type ScyllaNote,
	parseScyllaNote,
	prepared,
	scyllaClient,
	parseScyllaPollVote,
} from "@/db/scylla.js";
import { userByIdCache } from "@/services/user-cache.js";
import { EmojiCache } from "@/misc/populate-emojis.js";

export default async function renderNote(
	note: Note,
	dive = true,
	isTalk = false,
): Promise<Record<string, unknown>> {
	const getPromisedFiles = async (ids: string[]) => {
		if (!ids || ids.length === 0) return [];
		const items = await DriveFiles.findBy({ id: In(ids) });
		return ids
			.map((id) => items.find((item) => item.id === id))
			.filter((item) => item != null) as DriveFile[];
	};

	let inReplyTo;
	let inReplyToNote: Note | null = null;

	if (note.replyId) {
		if (scyllaClient) {
			const result = await scyllaClient.execute(
				prepared.note.select.byId,
				[note.replyId],
				{ prepare: true },
			);
			if (result.rowLength > 0) {
				inReplyToNote = parseScyllaNote(result.first());
			}
		} else {
			inReplyToNote = await Notes.findOneBy({ id: note.replyId });
		}

		if (inReplyToNote) {
			const inReplyToUser = await userByIdCache.fetchMaybe(
				inReplyToNote.userId,
				() =>
					Users.findOneBy({ id: (inReplyToNote as Note).userId }).then(
						(user) => user ?? undefined,
					),
			);

			if (inReplyToUser) {
				if (inReplyToNote.uri) {
					inReplyTo = inReplyToNote.uri;
				} else {
					if (dive) {
						inReplyTo = await renderNote(inReplyToNote, false);
					} else {
						inReplyTo = `${config.url}/notes/${inReplyToNote.id}`;
					}
				}
			}
		}
	} else {
		inReplyTo = null;
	}

	let quote;

	if (note.renoteId) {
		let renote: Note | null = null;
		if (scyllaClient) {
			const result = await scyllaClient.execute(
				prepared.note.select.byId,
				[note.renoteId],
				{ prepare: true },
			);
			if (result.rowLength > 0) {
				renote = parseScyllaNote(result.first());
			}
		} else {
			renote = await Notes.findOneBy({ id: note.renoteId });
		}

		if (renote) {
			quote = renote.uri ? renote.uri : `${config.url}/notes/${renote.id}`;
		}
	}

	const attributedTo = `${config.url}/users/${note.userId}`;

	const mentions = (
		JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers
	).map((x) => x.uri);

	let to: string[] = [];
	let cc: string[] = [];

	if (note.visibility === "public") {
		to = ["https://www.w3.org/ns/activitystreams#Public"];
		cc = [`${attributedTo}/followers`].concat(mentions);
	} else if (note.visibility === "home") {
		to = [`${attributedTo}/followers`];
		cc = ["https://www.w3.org/ns/activitystreams#Public"].concat(mentions);
	} else if (note.visibility === "followers") {
		to = [`${attributedTo}/followers`];
		cc = mentions;
	} else {
		to = mentions;
	}

	const mentionedUsers =
		note.mentions.length > 0
			? await Users.findBy({
					id: In(note.mentions),
			  })
			: [];

	const hashtagTags = (note.tags || []).map((tag) => renderHashtag(tag));
	const mentionTags = mentionedUsers.map((u) => renderMention(u));

	const files = await getPromisedFiles(note.fileIds);

	const text = note.text ?? "";
	let poll: Poll | ScyllaPoll | null = null;

	if (note.hasPoll) {
		if (scyllaClient) {
			poll = (note as ScyllaNote).poll;
		} else {
			poll = await Polls.findOneBy({ noteId: note.id });
		}
	}

	let apText = text;

	if (quote) {
		apText += `\n\nRE: ${quote}`;
	}

	const summary = note.cw === "" ? String.fromCharCode(0x200b) : note.cw;

	const content = toHtml(
		Object.assign({}, note, {
			text: apText,
		}),
	);

	const lang = note.lang ?? detectLanguage(text);
	const contentMap = lang
		? {
				[lang]: content,
		  }
		: null;

	const emojis = await getEmojis(note.emojis);
	const apemojis = emojis.map((emoji) => renderEmoji(emoji));

	const tag = [...hashtagTags, ...mentionTags, ...apemojis];

	let choices: {
		type: "Note";
		name: string;
		replies: { type: "Collection"; totalItems: number };
	}[] = [];
	if (poll) {
		if (scyllaClient) {
			const votes = await scyllaClient
				.execute(prepared.poll.select, [note.id], { prepare: true })
				.then((result) => result.rows.map(parseScyllaPollVote));
			choices = Object.entries((poll as ScyllaPoll).choices).map(
				([index, text]) => ({
					type: "Note",
					name: text,
					replies: {
						type: "Collection",
						totalItems: votes.filter((vote) => vote.choice.has(parseInt(index)))
							.length,
					},
				}),
			);
		} else {
			choices = (poll as Poll).choices.map((text, i) => ({
				type: "Note",
				name: text,
				replies: {
					type: "Collection",
					totalItems: (poll as Poll).votes[i],
				},
			}));
		}
	}

	const asPoll = poll
		? {
				type: "Question",
				content: toHtml(
					Object.assign({}, note, {
						text: text,
					}),
				),
				[poll.expiresAt && poll.expiresAt < new Date() ? "closed" : "endTime"]:
					poll.expiresAt,
				[poll.multiple ? "anyOf" : "oneOf"]: choices,
		  }
		: {};

	const asTalk = isTalk
		? {
				_misskey_talk: true,
		  }
		: {};

	return {
		id: `${config.url}/notes/${note.id}`,
		type: "Note",
		attributedTo,
		summary,
		content,
		contentMap,
		source: {
			content: text,
			mediaType: "text/x.misskeymarkdown",
		},
		quoteUri: quote,
		quoteUrl: quote,
		published: note.createdAt.toISOString(),
		to,
		cc,
		inReplyTo,
		attachment: files.map(renderDocument),
		sensitive: note.cw != null || files.some((file) => file.isSensitive),
		tag,
		...asPoll,
		...asTalk,
	};
}

export async function getEmojis(names: string[]): Promise<Emoji[]> {
	if (names == null || names.length === 0) return [];

	const emojis = await Promise.all(
		names.map((name) =>
			EmojiCache.fetch(`${name} null`, () =>
				Emojis.findOneBy({
					name,
					host: IsNull(),
				}),
			),
		),
	);

	return emojis.filter((emoji) => !!emoji) as Emoji[];
}
