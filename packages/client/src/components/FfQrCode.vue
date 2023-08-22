<template>
	<MkModal ref="modal" :z-priority="'middle'" @closed="$emit('closed')">
		<div :class="$style.root">
			<div :class="$style.title">
				<QRCodeVue3
          :value="qrCode"
        />
			</div>
			<MkButton :class="$style.gotIt" primary full @click="gotIt()">{{
				i18n.ts.gotIt
			}}</MkButton>
		</div>
	</MkModal>
</template>

<script lang="ts" setup>
import { shallowRef } from "vue";
import MkModal from "@/components/MkModal.vue";
import MkButton from "@/components/MkButton.vue";
import { i18n } from "@/i18n";
import QRCodeVue3 from "qrcode-vue3";

// const profileUrl = window.location.href;

const props = defineProps<{
	qrCode: string
}>();

const modal = shallowRef<InstanceType<typeof MkModal>>();

const gotIt = () => {
	modal.value.close();
};
</script>

<style lang="scss" module>
.root {
	margin: auto;
	position: relative;
	padding: 32px;
	min-width: 320px;
	max-width: 480px;
	box-sizing: border-box;
	text-align: center;
	background: var(--panel);
	border-radius: var(--radius);

	> img {
		border-radius: 10px;
		max-height: 100%;
		max-width: 100%;
	}
}

.title {
	font-weight: bold;

	> p {
		margin: 0;
	}
}

.time {
	font-size: 0.8rem;
}

.gotIt {
	margin: 8px 0 0 0;
}
</style>
