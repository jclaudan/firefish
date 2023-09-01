import type { App } from "vue";

import MkA from "./global/MkA.vue";
import MkAcct from "./global/MkAcct.vue";
import MkAd from "./global/MkAd.vue";
import MkAvatar from "./global/MkAvatar.vue";
import MkEllipsis from "./global/MkEllipsis.vue";
import MkEmoji from "./global/MkEmoji.vue";
import MkError from "./global/MkError.vue";
import MkLoading from "./global/MkLoading.vue";
import Mfm from "./global/MkMisskeyFlavoredMarkdown.vue";
import MkPageHeader from "./global/MkPageHeader.vue";
import MkSpacer from "./global/MkSpacer.vue";
import MkStickyContainer from "./global/MkStickyContainer.vue";
import MkTime from "./global/MkTime.vue";
import MkUrl from "./global/MkUrl.vue";
import MkUserName from "./global/MkUserName.vue";
import RouterView from "./global/RouterView.vue";
import I18n from "./global/i18n";

export default function (app: App) {
	app.component("I18n", I18n);
	app.component("RouterView", RouterView);
	app.component("Mfm", Mfm);
	app.component("MkA", MkA);
	app.component("MkAcct", MkAcct);
	app.component("MkAvatar", MkAvatar);
	app.component("MkEmoji", MkEmoji);
	app.component("MkUserName", MkUserName);
	app.component("MkEllipsis", MkEllipsis);
	app.component("MkTime", MkTime);
	app.component("MkUrl", MkUrl);
	app.component("MkLoading", MkLoading);
	app.component("MkError", MkError);
	app.component("MkAd", MkAd);
	app.component("MkPageHeader", MkPageHeader);
	app.component("MkSpacer", MkSpacer);
	app.component("MkStickyContainer", MkStickyContainer);
}

declare module "@vue/runtime-core" {
	export interface GlobalComponents {
		I18n: typeof I18n;
		RouterView: typeof RouterView;
		Mfm: typeof Mfm;
		MkA: typeof MkA;
		MkAcct: typeof MkAcct;
		MkAvatar: typeof MkAvatar;
		MkEmoji: typeof MkEmoji;
		MkUserName: typeof MkUserName;
		MkEllipsis: typeof MkEllipsis;
		MkTime: typeof MkTime;
		MkUrl: typeof MkUrl;
		MkLoading: typeof MkLoading;
		MkError: typeof MkError;
		MkAd: typeof MkAd;
		MkPageHeader: typeof MkPageHeader;
		MkSpacer: typeof MkSpacer;
		MkStickyContainer: typeof MkStickyContainer;
	}
}
