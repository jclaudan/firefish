import define from "../../define.js";
import { ApiError } from "../../error.js";
import { getUser } from "../../common/getters.js";
import { Mutings } from "@/models/index.js";
import { publishUserEvent } from "@/services/stream.js";
import { UserMutingsCache } from "@/misc/cache.js";

export const meta = {
	tags: ["account"],

	requireCredential: true,

	kind: "write:mutes",

	errors: {
		noSuchUser: {
			message: "No such user.",
			code: "NO_SUCH_USER",
			id: "b851d00b-8ab1-4a56-8b1b-e24187cb48ef",
		},

		muteeIsYourself: {
			message: "Mutee is yourself.",
			code: "MUTEE_IS_YOURSELF",
			id: "f428b029-6b39-4d48-a1d2-cc1ae6dd5cf9",
		},

		notMuting: {
			message: "You are not muting that user.",
			code: "NOT_MUTING",
			id: "5467d020-daa9-4553-81e1-135c0c35a96d",
		},
	},
} as const;

export const paramDef = {
	type: "object",
	properties: {
		userId: { type: "string", format: "misskey:id" },
	},
	required: ["userId"],
} as const;

export default define(meta, paramDef, async (ps, user) => {
	const muter = user;

	// Check if the mutee is yourself
	if (user.id === ps.userId) {
		throw new ApiError(meta.errors.muteeIsYourself);
	}

	// Get mutee
	const mutee = await getUser(ps.userId).catch((e) => {
		if (e.id === "15348ddd-432d-49c2-8a5a-8069753becff")
			throw new ApiError(meta.errors.noSuchUser);
		throw e;
	});

	// Check not muting
	const cache = await UserMutingsCache.init(muter.id);
	const muting = await cache.isMuting(mutee.id);

	if (!muting) {
		throw new ApiError(meta.errors.notMuting);
	}

	// Delete mute
	await Mutings.delete({
		muterId: muter.id,
		muteeId: mutee.id,
	});
	await cache.unmute(mutee.id);

	publishUserEvent(user.id, "unmute", mutee);
});
