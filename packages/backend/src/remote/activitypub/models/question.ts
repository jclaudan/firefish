import config from "@/config/index.js";
import Resolver from "../resolver.js";
import type { IObject, IQuestion } from "../type.js";
import { getApId, isQuestion } from "../type.js";
import { apLogger } from "../logger.js";
import { Notes, Polls } from "@/models/index.js";
import type { IPoll, Poll } from "@/models/entities/poll.js";
import {
	parseScyllaNote,
	prepared,
	scyllaClient,
	type ScyllaPoll,
	type ScyllaNote,
	parseScyllaPollVote,
} from "@/db/scylla.js";
import type { Note } from "@/models/entities/note.js";
import { genId } from "@/misc/gen-id.js";

export async function extractPollFromQuestion(
	source: string | IObject,
	resolver?: Resolver,
): Promise<IPoll> {
	if (resolver == null) resolver = new Resolver();

	const question = await resolver.resolve(source);

	if (!isQuestion(question)) {
		throw new Error("invalid type");
	}

	const multiple = !question.oneOf;
	const expiresAt = question.endTime
		? new Date(question.endTime)
		: question.closed
		? new Date(question.closed)
		: null;

	if (multiple && !question.anyOf) {
		throw new Error("invalid question");
	}

	const choices = question[multiple ? "anyOf" : "oneOf"]!.map(
		(x, i) => x.name!,
	);

	const votes = question[multiple ? "anyOf" : "oneOf"]!.map(
		(x, i) => x.replies?.totalItems || x._misskey_votes || 0,
	);

	return {
		choices,
		votes,
		multiple,
		expiresAt,
	};
}

/**
 * Update votes of Question
 * @param value URI of AP Question object or object itself
 * @returns true if updated
 */
export async function updateQuestion(
	value: string | IQuestion,
	resolver?: Resolver,
): Promise<boolean> {
	const uri = typeof value === "string" ? value : getApId(value);

	// Skip if URI points to this server
	if (uri.startsWith(`${config.url}/`)) throw new Error("uri points local");

	//#region Already registered with this server?
	let note: Note | ScyllaNote | null = null;
	if (scyllaClient) {
		const result = await scyllaClient.execute(
			prepared.note.select.byUri,
			[uri],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			note = parseScyllaNote(result.first());
		}
	} else {
		note = await Notes.findOneBy({ uri });
	}
	if (!note) throw new Error("Question is not registed");

	let poll: Poll | ScyllaPoll | null = null;
	if (scyllaClient) {
		const scyllaPoll = (note as ScyllaNote).poll;
		if (note.hasPoll && scyllaPoll) {
			poll = scyllaPoll;
		}
	} else {
		poll = await Polls.findOneBy({ noteId: note.id });
	}
	if (!poll) throw new Error("Question is not registed");
	//#endregion

	// resolve new Question object
	const _resolver = resolver ?? new Resolver();
	const question = (await _resolver.resolve(value)) as IQuestion;
	apLogger.debug(`fetched question: ${JSON.stringify(question, null, 2)}`);

	if (question.type !== "Question") throw new Error("object is not a Question");

	const apChoices = question.oneOf || question.anyOf;
	if (!apChoices) return false;

	let changed = false;

	if (scyllaClient) {
		const votes = await scyllaClient
			.execute(prepared.poll.select, [note.id], { prepare: true })
			.then((result) => result.rows.map(parseScyllaPollVote));
		const scyllaPoll = poll as ScyllaPoll;
		for (const [i, name] of Object.entries(scyllaPoll.choices)) {
			const index = parseInt(i);
			const oldCount = votes.filter((vote) => vote.choice.has(index)).length;
			const newCount = apChoices.filter((ap) => ap.name === name)[0].replies
				?.totalItems;
			// Here, we assume that no implementations allow users to cancel votes.
			if (newCount !== undefined && oldCount < newCount) {
				changed = true;
				for (let i = 0; i < newCount - oldCount; i++) {
					const now = new Date();
					await scyllaClient.execute(
						prepared.poll.insert,
						[note.id, `anonymous-${genId(now)}`, "anonymous", [index], now],
						{ prepare: true },
					);
				}
			}
		}
	} else {
		const dbPoll = poll as Poll;
		for (const choice of dbPoll.choices) {
			const oldCount = dbPoll.votes[dbPoll.choices.indexOf(choice)];
			const newCount = apChoices.filter((ap) => ap.name === choice)[0].replies
				?.totalItems;

			if (newCount !== undefined && oldCount !== newCount) {
				changed = true;
				dbPoll.votes[dbPoll.choices.indexOf(choice)] = newCount;
			}
		}

		await Polls.update(
			{ noteId: note.id },
			{
				votes: dbPoll.votes,
			},
		);
	}

	return changed;
}
