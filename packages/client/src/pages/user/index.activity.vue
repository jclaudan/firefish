<template>
	<MkContainer>
		<template #header
			><i
				:class="defaultStore.state.iconSet"
				class="ph-chart-bar ph-lg"
				style="margin-right: 0.5em"
			></i
			>{{ i18n.ts.activity }}</template
		>
		<template #func>
			<button class="_button" @click="showMenu">
				<i
					:class="defaultStore.state.iconSet"
					class="ph-dots-three-outline ph-lg"
				></i>
			</button>
		</template>

		<div style="padding: 8px">
			<MkChart
				:src="chartSrc"
				:args="{ user, withoutAll: true }"
				span="day"
				:limit="limit"
				:bar="true"
				:stacked="true"
				:detailed="false"
				:aspect-ratio="5"
			/>
		</div>
	</MkContainer>
</template>

<script lang="ts" setup>
import { ref } from "vue";

import type * as firefish from "firefish-js";
import MkContainer from "@/components/MkContainer.vue";
import MkChart from "@/components/MkChart.vue";
import * as os from "@/os";
import { i18n } from "@/i18n";
import { defaultStore } from "@/store";

const props = withDefaults(
	defineProps<{
		user: firefish.entities.User;
		limit?: number;
	}>(),
	{
		limit: 50,
	},
);

const chartSrc = ref("per-user-notes");

function showMenu(ev: MouseEvent) {
	os.popupMenu(
		[
			{
				text: i18n.ts.notes,
				active: true,
				action: () => {
					chartSrc.value = "per-user-notes";
				},
			} /*, {
		text: i18n.ts.following,
		action: () => {
			chartSrc = 'per-user-following';
		}
	}, {
		text: i18n.ts.followers,
		action: () => {
			chartSrc = 'per-user-followers';
		}
	} */,
		],
		ev.currentTarget ?? ev.target,
	);
}
</script>
