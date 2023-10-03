import { computed, reactive, ref } from "vue";
import { $i } from "./account";
import { search } from "@/scripts/search";
import * as os from "@/os";
import { i18n } from "@/i18n";
import { ui } from "@/config";
import { unisonReload } from "@/scripts/unison-reload";
import { defaultStore } from "@/store";

export const navbarItemDef = reactive({
	notifications: {
		title: "notifications",
		icon: `${defaultStore.state.iconSet} ph-bell ph-lg`,
		show: computed(() => $i != null),
		indicated: computed(() => $i?.hasUnreadNotification),
		to: "/my/notifications",
	},
	messaging: {
		title: "messaging",
		icon: `${defaultStore.state.iconSet} ph-chats-teardrop ph-lg`,
		show: computed(() => $i != null),
		indicated: computed(() => $i?.hasUnreadMessagingMessage),
		to: "/my/messaging",
	},
	drive: {
		title: "drive",
		icon: `${defaultStore.state.iconSet} ph-cloud ph-lg`,
		show: computed(() => $i != null),
		to: "/my/drive",
	},
	followRequests: {
		title: "followRequests",
		icon: `${defaultStore.state.iconSet} ph-hand-waving ph-lg`,
		show: computed(() => $i?.isLocked || $i?.hasPendingReceivedFollowRequest),
		indicated: computed(() => $i?.hasPendingReceivedFollowRequest),
		to: "/my/follow-requests",
	},
	explore: {
		title: "explore",
		icon: `${defaultStore.state.iconSet} ph-compass ph-lg`,
		to: "/explore",
	},
	announcements: {
		title: "announcements",
		icon: `${defaultStore.state.iconSet} ph-megaphone-simple ph-lg`,
		indicated: computed(() => $i?.hasUnreadAnnouncement),
		to: "/announcements",
	},
	search: {
		title: "search",
		icon: `${defaultStore.state.iconSet} ph-magnifying-glass ph-lg`,
		action: () => search(),
	},
	lists: {
		title: "lists",
		icon: `${defaultStore.state.iconSet} ph-list-bullets ph-lg`,
		show: computed(() => $i != null),
		to: "/my/lists",
	},
	antennas: {
		title: "antennas",
		icon: `${defaultStore.state.iconSet} ph-flying-saucer ph-lg`,
		show: computed(() => $i != null),
		to: "/my/antennas",
	},
	favorites: {
		title: "favorites",
		icon: `${defaultStore.state.iconSet} ph-bookmark-simple ph-lg`,
		show: computed(() => $i != null),
		to: "/my/favorites",
	},
	pages: {
		title: "pages",
		icon: `${defaultStore.state.iconSet} ph-file-text ph-lg`,
		to: "/pages",
	},
	gallery: {
		title: "gallery",
		icon: `${defaultStore.state.iconSet} ph-image-square ph-lg`,
		to: "/gallery",
	},
	clips: {
		title: "clips",
		icon: `${defaultStore.state.iconSet} ph-paperclip ph-lg`,
		show: computed(() => $i != null),
		to: "/my/clips",
	},
	channels: {
		title: "channel",
		icon: `${defaultStore.state.iconSet} ph-television ph-lg`,
		to: "/channels",
	},
	groups: {
		title: "groups",
		icon: `${defaultStore.state.iconSet} ph-users-three ph-lg`,
		to: "/my/groups",
	},
	ui: {
		title: "switchUi",
		icon: `${defaultStore.state.iconSet} ph-layout ph-lg`,
		action: (ev) => {
			os.popupMenu(
				[
					{
						text: i18n.ts.default,
						active: ui === "default" || ui === null,
						action: () => {
							localStorage.setItem("ui", "default");
							unisonReload();
						},
					},
					{
						text: i18n.ts.classic,
						active: ui === "classic",
						action: () => {
							localStorage.setItem("ui", "classic");
							unisonReload();
						},
					},
					{
						text: i18n.ts.deck,
						active: ui === "deck",
						action: () => {
							localStorage.setItem("ui", "deck");
							unisonReload();
						},
					},
				],
				ev.currentTarget ?? ev.target,
			);
		},
	},
	reload: {
		title: "reload",
		icon: `${defaultStore.state.iconSet} ph-arrows-clockwise ph-lg`,
		action: (ev) => {
			location.reload();
		},
	},
});
