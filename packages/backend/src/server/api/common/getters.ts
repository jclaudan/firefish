import { IdentifiableError } from "@/misc/identifiable-error.js";
import type { User } from "@/models/entities/user.js";
import type { Note } from "@/models/entities/note.js";
import { Notes, Users } from "@/models/index.js";
import { generateVisibilityQuery } from "./generate-visibility-query.js";
import {
	filterVisibility,
	parseScyllaNote,
	prepared,
	scyllaClient,
} from "@/db/scylla.js";
import { userByIdCache } from "@/services/user-cache.js";

/**
 * Get note for API processing, taking into account visibility.
 */
export async function getNote(
	noteId: Note["id"],
	me: { id: User["id"] } | null,
	followingIds?: User["id"][],
) {
	let note: Note | null = null;
	if (scyllaClient) {
		const result = await scyllaClient.execute(
			prepared.note.select.byId,
			[[noteId]],
			{ prepare: true },
		);
		if (result.rowLength > 0) {
			const candidate = parseScyllaNote(result.first());
			const filtered = await filterVisibility([candidate], me, followingIds);
			if (filtered.length > 0) {
				note = filtered[0];
			}
		}
	} else {
		const query = Notes.createQueryBuilder("note").where("note.id = :id", {
			id: noteId,
		});

		generateVisibilityQuery(query, me);

		note = await query.getOne();
	}

	if (!note) {
		throw new IdentifiableError(
			"9725d0ce-ba28-4dde-95a7-2cbb2c15de24",
			"No such note.",
		);
	}

	return note;
}

/**
 * Get user for API processing
 */
export async function getUser(userId: User["id"]) {
	const user = await userByIdCache.fetchMaybe(userId, () =>
		Users.findOneBy({ id: userId }).then((u) => u ?? undefined),
	);

	if (!user) {
		throw new IdentifiableError(
			"15348ddd-432d-49c2-8a5a-8069753becff",
			"No such user.",
		);
	}

	return user;
}

/**
 * Get remote user for API processing
 */
export async function getRemoteUser(userId: User["id"]) {
	const user = await getUser(userId);

	if (!Users.isRemoteUser(user)) {
		throw new Error("user is not a remote user");
	}

	return user;
}

/**
 * Get local user for API processing
 */
export async function getLocalUser(userId: User["id"]) {
	const user = await getUser(userId);

	if (!Users.isLocalUser(user)) {
		throw new Error("user is not a local user");
	}

	return user;
}
