import type { CacheableRemoteUser } from "@/models/entities/user.js";
import { toArray } from "@/prelude/array.js";
import * as activityTypes from "../type.js";
import { apLogger } from "../logger.js";
import Resolver from "../resolver.js";
import create from "./create/index.js";
import performDeleteActivity from "./delete/index.js";
import performUpdateActivity from "./update/index.js";
import { performReadActivity } from "./read.js";
import follow from "./follow.js";
import undo from "./undo/index.js";
import like from "./like.js";
import announce from "./announce/index.js";
import accept from "./accept/index.js";
import reject from "./reject/index.js";
import add from "./add/index.js";
import remove from "./remove/index.js";
import block from "./block/index.js";
import flag from "./flag/index.js";
import move from "./move/index.js";
import type { IObject } from "../type.js";
import { extractDbHost } from "@/misc/convert-host.js";
import { shouldBlockInstance } from "@/misc/should-block-instance.js";

const activityHandlers: { [key: string]: Function } = {
	Create: create,
	Delete: performDeleteActivity,
	Update: performUpdateActivity,
	Read: performReadActivity,
	Follow: follow,
	Accept: accept,
	Reject: reject,
	Add: add,
	Remove: remove,
	Announce: announce,
	Like: like,
	Undo: undo,
	Block: block,
	Flag: flag,
	Move: move,
};

export async function performActivity(
	actor: CacheableRemoteUser,
	activity: IObject,
) {
	if (activityTypes.isCollectionOrOrderedCollection(activity)) {
		const resolver = new Resolver();
		for (const item of toArray(
			activityTypes.isCollection(activity)
				? activity.items
				: activity.orderedItems,
		)) {
			const act = await resolver.resolve(item);
			try {
				await performOneActivity(actor, act);
			} catch (err) {
				if (err instanceof Error || typeof err === "string") {
					apLogger.error(err);
				}
			}
		}
	} else {
		await performOneActivity(actor, activity);
	}
}

async function performOneActivity(
	actor: CacheableRemoteUser,
	activity: IObject,
): Promise<void> {
	if (actor.isSuspended) return;

	if (typeof activity.id !== "undefined") {
		const host = extractDbHost(activityTypes.getApId(activity));
		if (await shouldBlockInstance(host)) return;
	}

	const handler = activityHandlers[activityTypes.getApType(activity)];

	if (handler) {
		await handler(actor, activity);
	} else {
		apLogger.warn(
			`Unrecognized activity type: ${
				(activity as activityTypes.IActivity).type
			}`,
		);
	}
}
