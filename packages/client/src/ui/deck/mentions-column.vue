<template>
	<XColumn
		:column="column"
		:is-stacked="isStacked"
		@parent-focus="($event) => emit('parent-focus', $event)"
	>
		<template #header
			><i class="ph-at ph-bold ph-lg" style="margin-right: 8px"></i
			>{{ column.name }}</template
		>

		<XNotifications
			:include-types="['mention', 'reply']"
			:unread-only="false"
			:direct-only="false"
		/>
	</XColumn>
</template>

<script lang="ts" setup>
import {} from "vue";
import XColumn from "./column.vue";
import XNotifications from "@/components/MkNotifications.vue";
import type { Column } from "./deck-store";

defineProps<{
	column: Column;
	isStacked: boolean;
}>();

const emit = defineEmits<{
	(ev: "parent-focus", direction: "up" | "down" | "left" | "right"): void;
}>();
</script>
