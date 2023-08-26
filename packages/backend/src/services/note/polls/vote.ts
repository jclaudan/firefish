import { publishNoteStream } from "@/services/stream.js";
import type { CacheableUser } from "@/models/entities/user.js";
import type { Note } from "@/models/entities/note.js";
import { PollVotes, NoteWatchings, Polls, Blockings } from "@/models/index.js";
import { Not } from "typeorm";
import { genId } from "@/misc/gen-id.js";
import { createNotification } from "../../create-notification.js";
import {
	type ScyllaNote,
	type ScyllaPollVote,
	scyllaClient,
	prepared,
	parseScyllaPollVote,
} from "@/db/scylla.js";
import { UserBlockingCache } from "@/misc/cache.js";

export default async function (
	user: CacheableUser,
	note: Note | ScyllaNote,
	choice: number,
) {
	if (scyllaClient) {
		const scyllaNote = note as ScyllaNote;
		if (!scyllaNote.hasPoll || !scyllaNote.poll) {
			throw new Error("poll not found");
		}

		if (!Object.keys(scyllaNote.poll.choices).includes(choice.toString())) {
			throw new Error("invalid choice param");
		}

		if (scyllaNote.userId !== user.id) {
			const isBlocking = await UserBlockingCache.init(scyllaNote.userId).then(
				(cache) => cache.has(user.id),
			);
			if (isBlocking) {
				throw new Error("blocked");
			}
		}

		let newChoice: ScyllaPollVote["choice"] = new Set();
		const result = await scyllaClient.execute(
			`${prepared.poll.select} AND "userId" = ?`,
			[scyllaNote.id, user.id],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			const vote = parseScyllaPollVote(result.first());
			if (scyllaNote.poll.multiple && !vote.choice.has(choice)) {
				newChoice = vote.choice.add(choice);
			} else {
				throw new Error("already voted");
			}
		} else {
			newChoice.add(choice);
		}

		await scyllaClient.execute(
			prepared.poll.insert,
			[scyllaNote.id, user.id, user.host, Array.from(newChoice), new Date()],
			{ prepare: true },
		);
	} else {
		const poll = await Polls.findOneBy({ noteId: note.id });
		if (!poll) throw new Error("poll not found");

		// Check whether is valid choice
		if (poll.choices[choice] == null) throw new Error("invalid choice param");

		// Check blocking
		if (note.userId !== user.id) {
			const block = await Blockings.findOneBy({
				blockerId: note.userId,
				blockeeId: user.id,
			});
			if (block) {
				throw new Error("blocked");
			}
		}

		// if already voted
		const exist = await PollVotes.findBy({
			noteId: note.id,
			userId: user.id,
		});

		if (poll.multiple) {
			if (exist.some((x) => x.choice === choice)) {
				throw new Error("already voted");
			}
		} else if (exist.length !== 0) {
			throw new Error("already voted");
		}

		// Create vote
		await PollVotes.insert({
			id: genId(),
			createdAt: new Date(),
			noteId: note.id,
			userId: user.id,
			choice: choice,
		});

		// Increment votes count
		const index = choice + 1; // In SQL, array index is 1 based
		await Polls.query(
			`UPDATE poll SET votes[${index}] = votes[${index}] + 1 WHERE "noteId" = '${poll.noteId}'`,
		);
	}

	publishNoteStream(note.id, "pollVoted", {
		choice: choice,
		userId: user.id,
	});

	// Notify
	createNotification(note.userId, "pollVote", {
		notifierId: user.id,
		noteId: note.id,
		choice: choice,
	});

	// Fetch watchers
	NoteWatchings.findBy({
		noteId: note.id,
		userId: Not(user.id),
	}).then((watchers) => {
		for (const watcher of watchers) {
			createNotification(watcher.userId, "pollVote", {
				notifierId: user.id,
				noteId: note.id,
				choice: choice,
			});
		}
	});
}
