<template>
	<XModalWindow
		ref="dialogEl"
		:width="800"
		:height="500"
		:scroll="false"
		:with-ok-button="true"
		@close="cancel()"
		@ok="ok()"
		@closed="$emit('closed')"
	>
		<template #header>{{ i18n.ts.cropImage }}</template>
		<template #default="{ width, height }">
			<div
				class="mk-cropper-dialog"
				:style="`--vw: ${width ? `${width}px` : '100%'}; --vh: ${
					height ? `${height}px` : '100%'
				};`"
			>
				<div class="container">
					<VuePictureCropper
						ref="cropper"
						:img="imgUrl"
						:options="{
							aspectRatio: aspectRatio ? aspectRatio[0] / aspectRatio[1] : null,
							dragMode: "crop",
							viewMode: 1,
						}"
					></VuePictureCropper>
				</div>
			</div>
		</template>
	</XModalWindow>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import type * as firefish from "firefish-js";
import VuePictureCropper, { cropper } from "vue-picture-cropper";
import XModalWindow from "@/components/MkModalWindow.vue";
import * as os from "@/os";
import { $i } from "@/account";
import { defaultStore } from "@/store";
import { apiUrl, url } from "@/config";
import { query } from "@/scripts/url";
import { i18n } from "@/i18n";

const emit = defineEmits<{
	(ev: "ok", cropped: firefish.entities.DriveFile): void;
	(ev: "cancel"): void;
	(ev: "closed"): void;
}>();

const props = defineProps<{
	file: firefish.entities.DriveFile;
	aspectRatio?: Array<number>;
}>();

const imgUrl = `${url}/proxy/image.webp?${query({
	url: props.file.url,
})}`;
const dialogEl = ref<InstanceType<typeof XModalWindow>>();

const ok = async () => {
	const promise = new Promise<firefish.entities.DriveFile>(async (res) => {
		await cropper?.getBlob((blob) => {
			const formData = new FormData();
			formData.append("file", blob);
			if (defaultStore.state.uploadFolder) {
				formData.append("folderId", defaultStore.state.uploadFolder);
			}

			fetch(apiUrl + "/drive/files/create", {
				method: "POST",
				body: formData,
				headers: {
					authorization: `Bearer ${$i.token}`,
				},
			})
				.then((response) => response.json())
				.then((f) => {
					res(f);
				});
		});
	});

	os.promiseDialog(promise);

	const f = await promise;

	emit("ok", f);
	dialogEl.value.close();
};

const cancel = () => {
	emit("cancel");
	dialogEl.value.close();
};
</script>

<style lang="scss" scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.5s ease 0.5s;
}
.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

.mk-cropper-dialog {
	display: flex;
	flex-direction: column;
	width: var(--vw);
	height: var(--vh);
	position: relative;

	> .container {
		flex: 1;
		width: 100%;
		height: 100%;
	}
}
</style>
