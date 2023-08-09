import { db } from "@/db/postgre.js";
import { Meta } from "@/models/entities/meta.js";
import { Cache } from "@/misc/cache.js";

export const metaCache = new Cache<Meta>("meta", 10);

export function metaToPugArgs(meta: Meta): object {
	let motd = ["Loading..."];
	if (meta.customMOTD.length > 0) {
		motd = meta.customMOTD;
	}
	let splashIconUrl = meta.iconUrl;
	if (meta.customSplashIcons.length > 0) {
		splashIconUrl =
			meta.customSplashIcons[
				Math.floor(Math.random() * meta.customSplashIcons.length)
			];
	}

	return {
		img: meta.bannerUrl,
		title: meta.name || "Firefish",
		instanceName: meta.name || "Firefish",
		desc: meta.description,
		icon: meta.iconUrl,
		splashIcon: splashIconUrl,
		themeColor: meta.themeColor,
		randomMOTD: motd[Math.floor(Math.random() * motd.length)],
		privateMode: meta.privateMode,
	};
}

export async function fetchMeta(noCache = false): Promise<Meta> {
	const fetcher = () =>
		db.transaction(async (transactionalEntityManager) => {
			// New IDs are prioritized because multiple records may have been created due to past bugs.
			const metas = await transactionalEntityManager.find(Meta, {
				order: {
					id: "DESC",
				},
			});

			if (metas.length > 0) {
				return metas[0];
			} else {
				// If fetchMeta is called at the same time when meta is empty, this part may be called at the same time, so use fail-safe upsert.
				const saved = await transactionalEntityManager
					.upsert(
						Meta,
						{
							id: "x",
						},
						["id"],
					)
					.then((x) =>
						transactionalEntityManager.findOneByOrFail(Meta, x.identifiers[0]),
					);

				return saved;
			}
		});

	if (noCache) {
		return await fetcher();
	}

	return await metaCache.fetch(null, fetcher);
}
