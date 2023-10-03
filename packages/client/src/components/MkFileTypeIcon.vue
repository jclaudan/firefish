<template>
	<span class="mk-file-type-icon">
		<template v-if="kind == 'image'"
			><i
				:class="defaultStore.state.iconSet"
				class="ph-file-image ph-lg"
			></i
		></template>
	</span>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { defaultStore } from "@/store";

const props = defineProps<{
	type: string;
}>();

const kind = computed(() => props.type.split("/")[0]);
</script>
