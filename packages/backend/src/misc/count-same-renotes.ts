import { prepared, scyllaClient } from "@/db/scylla";
import { Notes } from "@/models/index.js";

/**
 * Sum of notes that have the given userId and renoteId
 */
export async function countSameRenotes(
	userId: string,
	renoteId: string,
	excludeNoteId: string | undefined,
): Promise<number> {
	if (scyllaClient) {
		const result = await scyllaClient.execute(
			`SELECT "renoteId","userId","createdAt","id" FROM note_by_renote_id_and_user_id WHERE "renoteId" = ? AND "userId" = ?`,
			[renoteId, userId],
			{ prepare: true },
		);
		if (excludeNoteId) {
			const renotes = result.rows
				.map((row) => row.get("id") as string)
				.filter((id) => id !== excludeNoteId);

			return renotes.length;
		}

		return result.rowLength;
	}

	const query = Notes.createQueryBuilder("note")
		.where("note.userId = :userId", { userId })
		.andWhere("note.renoteId = :renoteId", { renoteId });

	// Exclude if specified
	if (excludeNoteId) {
		query.andWhere("note.id != :excludeNoteId", { excludeNoteId });
	}

	return await query.getCount();
}
