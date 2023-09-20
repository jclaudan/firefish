import define from "../../../define.js";
import { Users } from "@/models/index.js";
import { publishInternalEvent } from "@/services/stream.js";
import {
	localUserByIdCache,
	userByIdCache,
	userDenormalizedCache,
} from "@/services/user-cache.js";

export const meta = {
	tags: ["admin"],

	requireCredential: true,
	requireAdmin: true,
} as const;

export const paramDef = {
	type: "object",
	properties: {
		userId: { type: "string", format: "misskey:id" },
	},
	required: ["userId"],
} as const;

export default define(meta, paramDef, async (ps) => {
	const user = await Users.findOneBy({ id: ps.userId });

	if (user == null) {
		throw new Error("user not found");
	}

	await userDenormalizedCache.delete(user.id);
	await userByIdCache.delete(user.id);
	await localUserByIdCache.delete(user.id);
	await Users.update(user.id, {
		isModerator: false,
	});

	publishInternalEvent("userChangeModeratorState", {
		id: user.id,
		isModerator: false,
	});
});
