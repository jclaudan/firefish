import config from "@/config/index.js";
import type { Note } from "@/models/entities/note.js";
import type { IRemoteUser, User } from "@/models/entities/user.js";
import type { PollVote } from "@/models/entities/poll-vote.js";
import type { Poll } from "@/models/entities/poll.js";
import { ScyllaNote, ScyllaPollVote } from "@/db/scylla";

export default async function renderVote(
	user: { id: User["id"] },
	vote: PollVote,
	note: Note,
	poll: Poll,
	pollOwner: IRemoteUser,
): Promise<any> {
	return {
		id: `${config.url}/users/${user.id}#votes/${vote.id}/activity`,
		actor: `${config.url}/users/${user.id}`,
		type: "Create",
		to: [pollOwner.uri],
		published: new Date().toISOString(),
		object: {
			id: `${config.url}/users/${user.id}#votes/${vote.id}`,
			type: "Note",
			attributedTo: `${config.url}/users/${user.id}`,
			to: [pollOwner.uri],
			inReplyTo: note.uri,
			name: poll.choices[vote.choice],
		},
	};
}

export async function renderScyllaPollVote(
	user: { id: User["id"] },
	note: ScyllaNote,
	choice: number,
	pollOwner: IRemoteUser,
): Promise<any> {
	if (!note.poll) throw new Error("note has no poll");

	return {
		id: `${config.url}/users/${user.id}#votes/${note.id}/activity`,
		actor: `${config.url}/users/${user.id}`,
		type: "Create",
		to: [pollOwner.uri],
		published: new Date().toISOString(),
		object: {
			id: `${config.url}/users/${user.id}#votes/${note.id}`,
			type: "Note",
			attributedTo: `${config.url}/users/${user.id}`,
			to: [pollOwner.uri],
			inReplyTo: note.uri,
			name: note.poll.choices.get(choice),
		},
	};
}
