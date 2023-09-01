import type { App } from "vue";

import adaptiveBorder from "./adaptive-border";
import anim from "./anim";
import appear from "./appear";
import clickAnime from "./click-anime";
import focus from "./focus";
import getSize from "./get-size";
import hotkey from "./hotkey";
import panel from "./panel";
import ripple from "./ripple";
import size from "./size";
import tooltip from "./tooltip";
import userPreview from "./user-preview";

export default function (app: App) {
	app.directive("userPreview", userPreview);
	app.directive("user-preview", userPreview);
	app.directive("size", size);
	app.directive("get-size", getSize);
	app.directive("ripple", ripple);
	app.directive("tooltip", tooltip);
	app.directive("hotkey", hotkey);
	app.directive("appear", appear);
	app.directive("anim", anim);
	app.directive("click-anime", clickAnime);
	app.directive("panel", panel);
	app.directive("adaptive-border", adaptiveBorder);
	app.directive("focus", focus);
}
