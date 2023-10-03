import XTutorial from "../components/MkTutorialDialog.vue";
import { defaultStore } from "@/store";
import { instance } from "@/instance";
import { host } from "@/config";
import * as os from "@/os";
import { i18n } from "@/i18n";

export function openHelpMenu_(ev: MouseEvent) {
	os.popupMenu(
		[
			{
				text: instance.name ?? host,
				type: "label",
			},
			{
				type: "link",
				text: i18n.ts.instanceInfo,
				icon: `${defaultStore.state.iconSet} ph-info ph-lg`,
				to: "/about",
			},
			{
				type: "link",
				text: i18n.ts.aboutFirefish,
				icon: `${defaultStore.state.iconSet} ph-lightbulb ph-lg`,
				to: "/about-firefish",
			},
			instance.tosUrl
				? {
						type: "button",
						text: i18n.ts.tos,
						icon: `${defaultStore.state.iconSet} ph-scroll ph-lg`,
						action: () => {
							window.open(instance.tosUrl, "_blank");
						},
				  }
				: null,
			{
				type: "button",
				text: i18n.ts.apps,
				icon: `${defaultStore.state.iconSet} ph-device-mobile ph-lg`,
				action: () => {
					window.open("https://joinfirefish.org/apps", "_blank");
				},
			},
			{
				type: "button",
				action: async () => {
					defaultStore.set("tutorial", 0);
					os.popup(XTutorial, {}, {}, "closed");
				},
				text: i18n.ts.replayTutorial,
				icon: `${defaultStore.state.iconSet} ph-circle-wavy-question ph-lg`,
			},
			null,
			{
				type: "parent",
				text: i18n.ts.developer,
				icon: `${defaultStore.state.iconSet} ph-code ph-lg`,
				children: [
					{
						type: "link",
						to: "/api-console",
						text: "API Console",
						icon: `${defaultStore.state.iconSet} ph-terminal-window ph-lg`,
					},
					{
						text: i18n.ts.document,
						icon: `${defaultStore.state.iconSet} ph-file-doc ph-lg`,
						action: () => {
							window.open("/api-doc", "_blank");
						},
					},
					{
						type: "link",
						to: "/scratchpad",
						text: "AiScript Scratchpad",
						icon: `${defaultStore.state.iconSet} ph-scribble-loop ph-lg`,
					},
				],
			},
		],
		ev.currentTarget ?? ev.target,
	);
}
