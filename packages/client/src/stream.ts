import * as Firefish from "firefish-js";
import { markRaw } from "vue";
import { $i } from "@/account";
import { url } from "@/config";

export const stream = markRaw(
	new Firefish.Stream(
		url,
		$i
			? {
					token: $i.token,
			  }
			: null,
	),
);

window.setTimeout(heartbeat, 1000 * 60);

function heartbeat(): void {
	if (stream != null && document.visibilityState === "visible") {
		stream.send("ping");
	}
	window.setTimeout(heartbeat, 1000 * 60);
}
