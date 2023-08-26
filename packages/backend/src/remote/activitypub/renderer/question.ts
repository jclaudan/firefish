import config from "@/config/index.js";
import type { User } from "@/models/entities/user.js";
import type { Note } from "@/models/entities/note.js";
import type { Poll } from "@/models/entities/poll.js";
import { type ScyllaPoll, parseScyllaPollVote, prepared, scyllaClient } from "@/db/scylla.js";

export default async function renderQuestion(
	user: { id: User["id"] },
	note: Note,
	poll: Poll | ScyllaPoll,
) {
	let choices: {
		type: "Note";
		name: string;
		replies: { type: "Collection"; totalItems: number };
	}[] = [];
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
	const question = {
		type: "Question",
		id: `${config.url}/questions/${note.id}`,
		actor: `${config.url}/users/${user.id}`,
		content: note.text || "",
		[poll.multiple ? "anyOf" : "oneOf"]: choices,
	};

	return question;
}
