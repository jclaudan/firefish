<template>
	<MkStickyContainer>
		<template #header
			><MkPageHeader
				:actions="headerActions"
				:tabs="headerTabs"
				:display-back-button="true"
		/></template>
		<MkSpacer :content-max="900" :margin-min="20" :margin-max="32">
			<div ref="el" class="vvcocwet" :class="{ wide: !narrow }">
				<div class="body">
					<div
						v-if="!narrow || currentPage?.route.name == null"
						class="nav"
					>
						<div class="baaadecd">
							<MkInfo v-if="emailNotConfigured" warn class="info"
								>{{ i18n.ts.emailNotConfiguredWarning }}
								<MkA to="/settings/email" class="_link">{{
									i18n.ts.configure
								}}</MkA></MkInfo
							>
							<MkSuperMenu
								:def="menuDef"
								:grid="narrow"
							></MkSuperMenu>
						</div>
					</div>
					<section
						v-if="!(narrow && currentPage?.route.name == null)"
						class="main"
					>
						<div>
							<RouterView />
						</div>
					</section>
				</div>
			</div>
		</MkSpacer>
	</MkStickyContainer>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import { i18n } from "@/i18n";
import MkInfo from "@/components/MkInfo.vue";
import MkSuperMenu from "@/components/MkSuperMenu.vue";
import { $i, signout } from "@/account";
import { unisonReload } from "@/scripts/unison-reload";
import { instance } from "@/instance";
import { useRouter } from "@/router";
import {
	definePageMetadata,
	provideMetadataReceiver,
} from "@/scripts/page-metadata";
import * as os from "@/os";
import { defaultStore } from "@/store";

const indexInfo = {
	title: i18n.ts.settings,
	icon: `${defaultStore.state.iconSet} ph-gear-six ph-lg`,
	hideHeader: true,
};
const INFO = ref(indexInfo);
const el = ref<HTMLElement | null>(null);
const childInfo = ref(null);

const router = useRouter();

const narrow = ref(false);
const NARROW_THRESHOLD = 600;

const currentPage = computed(() => router.currentRef.value.child);

const ro = new ResizeObserver((entries, observer) => {
	if (entries.length === 0) return;
	narrow.value = entries[0].borderBoxSize[0].inlineSize < NARROW_THRESHOLD;
});

const menuDef = computed(() => [
	{
		title: i18n.ts.basicSettings,
		items: [
			{
				icon: `${defaultStore.state.iconSet} ph-user ph-lg`,
				text: i18n.ts.profile,
				to: "/settings/profile",
				active: currentPage.value?.route.name === "profile",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-keyhole ph-lg`,
				text: i18n.ts.privacy,
				to: "/settings/privacy",
				active: currentPage.value?.route.name === "privacy",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-smiley ph-lg`,
				text: i18n.ts.reaction,
				to: "/settings/reaction",
				active: currentPage.value?.route.name === "reaction",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-cloud ph-lg`,
				text: i18n.ts.drive,
				to: "/settings/drive",
				active: currentPage.value?.route.name === "drive",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-bell ph-lg`,
				text: i18n.ts.notifications,
				to: "/settings/notifications",
				active: currentPage.value?.route.name === "notifications",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-envelope-simple-open ph-lg`,
				text: i18n.ts.email,
				to: "/settings/email",
				active: currentPage.value?.route.name === "email",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-share-network ph-lg`,
				text: i18n.ts.integration,
				to: "/settings/integration",
				active: currentPage.value?.route.name === "integration",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-lock ph-lg`,
				text: i18n.ts.security,
				to: "/settings/security",
				active: currentPage.value?.route.name === "security",
			},
		],
	},
	{
		title: i18n.ts.clientSettings,
		items: [
			{
				icon: `${defaultStore.state.iconSet} ph-gear-six ph-lg`,
				text: i18n.ts.general,
				to: "/settings/general",
				active: currentPage.value?.route.name === "general",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-palette ph-lg`,
				text: i18n.ts.theme,
				to: "/settings/theme",
				active: currentPage.value?.route.name === "theme",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-list ph-lg`,
				text: i18n.ts.navbar,
				to: "/settings/navbar",
				active: currentPage.value?.route.name === "navbar",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-traffic-signal ph-lg`,
				text: i18n.ts.statusbar,
				to: "/settings/statusbar",
				active: currentPage.value?.route.name === "statusbar",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-speaker-high ph-lg`,
				text: i18n.ts.sounds,
				to: "/settings/sounds",
				active: currentPage.value?.route.name === "sounds",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-plug ph-lg`,
				text: i18n.ts.plugins,
				to: "/settings/plugin",
				active: currentPage.value?.route.name === "plugin",
			},
		],
	},
	{
		title: i18n.ts.otherSettings,
		items: [
			{
				icon: `${defaultStore.state.iconSet} ph-airplane-takeoff ph-lg`,
				text: i18n.ts.migration,
				to: "/settings/migration",
				active: currentPage.value?.route.name === "migration",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-package ph-lg`,
				text: i18n.ts.importAndExport,
				to: "/settings/import-export",
				active: currentPage.value?.route.name === "import-export",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-speaker-none ph-lg`,
				text: i18n.ts.instanceMute,
				to: "/settings/instance-mute",
				active: currentPage.value?.route.name === "instance-mute",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-prohibit ph-lg`,
				text: i18n.ts.muteAndBlock,
				to: "/settings/mute-block",
				active: currentPage.value?.route.name === "mute-block",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-speaker-x ph-lg`,
				text: i18n.ts.wordMute,
				to: "/settings/word-mute",
				active: currentPage.value?.route.name === "word-mute",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-key ph-lg`,
				text: "API",
				to: "/settings/api",
				active: currentPage.value?.route.name === "api",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-webhooks-logo ph-lg`,
				text: "Webhook",
				to: "/settings/webhook",
				active: currentPage.value?.route.name === "webhook",
			},
			{
				icon: `${defaultStore.state.iconSet} ph-dots-three-outline ph-lg`,
				text: i18n.ts.other,
				to: "/settings/other",
				active: currentPage.value?.route.name === "other",
			},
		],
	},
	{
		items: [
			{
				icon: `${defaultStore.state.iconSet} ph-floppy-disk ph-lg`,
				text: i18n.ts.preferencesBackups,
				to: "/settings/preferences-backups",
				active: currentPage.value?.route.name === "preferences-backups",
			},
			{
				type: "button",
				icon: `${defaultStore.state.iconSet} ph-trash ph-lg`,
				text: i18n.ts.clearCache,
				action: () => {
					localStorage.removeItem("locale");
					localStorage.removeItem("theme");
					unisonReload();
				},
			},
			{
				type: "button",
				icon: `${defaultStore.state.iconSet} ph-sign-in ph-lg fa-flip-horizontal`,
				text: i18n.ts.logout,
				action: async () => {
					const { canceled } = await os.confirm({
						type: "warning",
						text: i18n.ts.logoutConfirm,
					});
					if (canceled) return;
					signout();
				},
				danger: true,
			},
		],
	},
]);

watch(narrow, () => {});

onMounted(() => {
	ro.observe(el.value);

	narrow.value = el.value.offsetWidth < NARROW_THRESHOLD;

	if (!narrow.value && currentPage.value?.route.name == null) {
		router.replace("/settings/profile");
	}
});

onActivated(() => {
	narrow.value = el.value.offsetWidth < NARROW_THRESHOLD;

	if (!narrow.value && currentPage.value?.route.name == null) {
		router.replace("/settings/profile");
	}
});

onUnmounted(() => {
	ro.disconnect();
});

watch(router.currentRef, (to) => {
	if (
		to.route.name === "settings" &&
		to.child?.route.name == null &&
		!narrow.value
	) {
		router.replace("/settings/profile");
	}
});

const emailNotConfigured = computed(
	() => instance.enableEmail && ($i.email == null || !$i.emailVerified),
);

provideMetadataReceiver((info) => {
	if (info == null) {
		childInfo.value = null;
	} else {
		childInfo.value = info;
	}
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePageMetadata(INFO);
// w 890
// h 700
</script>

<style lang="scss" scoped>
.vvcocwet {
	> .body {
		.wallpaper & {
			background: var(--bg);
			padding: var(--margin);
			border-radius: var(--radius);
		}
		> .nav {
			.baaadecd {
				> .info {
					margin: 16px 0;
				}

				> .accounts {
					> .avatar {
						display: block;
						width: 50px;
						height: 50px;
						margin: 8px auto 16px auto;
					}
				}
			}
		}
	}

	&.wide {
		> .body {
			display: flex;
			height: 100%;

			> .nav {
				width: 34%;
				padding-right: 32px;
				box-sizing: border-box;
			}

			> .main {
				flex: 1;
				min-width: 0;
			}
		}
	}
}
</style>
