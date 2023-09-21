import * as fs from "node:fs";
import superagent from "superagent";
import { httpAgent, httpsAgent, StatusError } from "./fetch.js";
import config from "@/config/index.js";
import chalk from "chalk";
import Logger from "@/services/logger.js";
import IPCIDR from "ip-cidr";
import PrivateIp from "private-ip";

export async function downloadUrl(url: string, path: string): Promise<void> {
	const logger = new Logger("download");

	logger.info(`Downloading ${chalk.cyan(url)} ...`);

	const timeout = 30 * 1000;

	try {
		const response = await superagent
			.get(url)
			.set("User-Agent", config.userAgent)
			.set("Host", new URL(url).hostname)
			.timeout({
				response: timeout, // Wait for server to start sending.
				deadline: timeout * 2, // Time the entire request.
			})
			.agent(new URL(url).protocol === "https:" ? httpsAgent : httpAgent);

		const contentLength = response.headers["content-length"];
		if (
			contentLength &&
			Number(contentLength) > (config.maxFileSize || 262144000)
		) {
			throw new Error(
				`maxSize exceeded: ${contentLength} > ${config.maxFileSize}`,
			);
		}

		fs.writeFileSync(path, response.body);
	} catch (e) {
		if (e.response) {
			throw new StatusError(
				`${e.response.statusCode} ${e.response.text}`,
				e.response.statusCode,
				e.response.text,
			);
		} else {
			throw e;
		}
	}

	logger.succ(`Download finished: ${chalk.cyan(url)}`);
}

export function isPrivateIp(ip: string): boolean {
	for (const net of config.allowedPrivateNetworks || []) {
		const cidr = new IPCIDR(net);
		if (cidr.contains(ip)) {
			return false;
		}
	}

	return PrivateIp(ip) || false;
}
