import { defaultStore } from "@/store";
import {
	ArcElement,
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	DoughnutController,
	Filler,
	Legend,
	LineController,
	LineElement,
	LinearScale,
	PointElement,
	SubTitle,
	TimeScale,
	Title,
	Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import { MatrixController, MatrixElement } from "chartjs-chart-matrix";
import gradient from "chartjs-plugin-gradient";
import zoomPlugin from "chartjs-plugin-zoom";

export function initChart() {
	Chart.register(
		ArcElement,
		LineElement,
		BarElement,
		PointElement,
		BarController,
		LineController,
		DoughnutController,
		CategoryScale,
		LinearScale,
		TimeScale,
		Legend,
		Title,
		Tooltip,
		SubTitle,
		Filler,
		MatrixController,
		MatrixElement,
		zoomPlugin,
		gradient,
	);

	// フォントカラー
	Chart.defaults.color = getComputedStyle(
		document.documentElement,
	).getPropertyValue("--fg");

	Chart.defaults.borderColor = defaultStore.state.darkMode
		? "rgba(255, 255, 255, 0.1)"
		: "rgba(0, 0, 0, 0.1)";

	Chart.defaults.animation = false;
}
