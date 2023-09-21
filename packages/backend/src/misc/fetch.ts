import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import request from "superagent";
import superagent from "superagent";
import { HttpProxyAgent, HttpsProxyAgent } from "hpagent";
import config from "@/config/index.js";

export async function getJson(
	url: string,
	accept = "application/json, */*",
	timeout = 10000,
	headers?: Record<string, string>,
) {
	const response = await request
		.get(url)
		.set("User-Agent", config.userAgent)
		.set("Accept", accept)
		.set(headers || {})
		.timeout(timeout)
		.agent(getAgentByUrl(new URL(url)));

	return response.body;
}

export async function getResponse(args: {
	url: string;
	method: string;
	body?: string;
	headers: Record<string, string>;
	timeout?: number;
	size?: number;
}): Promise<superagent.Response> {
	const timeout = args.timeout || 10 * 1000;
	const method = args.method.toUpperCase();
	const request = superagent(method, args.url);
	if (args.headers)
		request.set(args.headers);
	if (args.body)
		request.send(args.body);
	const urlObj = new URL(args.url);
	if (urlObj.protocol === "http:") {
		request.agent(httpAgent);
	} else if (urlObj.protocol === "https:") {
		request.agent(httpsAgent);
	}

	request.timeout({
		response: timeout,
		deadline: timeout * 6,
	});
	request.on("response", (res) => {
		const contentLength = parseInt(res.header["content-length"] || "0", 10);
		if (contentLength > (args.size || 10 * 1024 * 1024)) {
			throw new StatusError(
				`Response size exceeded: ${contentLength}`,
				413,
				"Payload Too Large",
			);
		}
	});

	try {
		const response = await request;
		if (!response.ok) {
			throw new StatusError(
				`${response.status} ${response.status}`,
				response.status,
			);
		}
		return response;
	} catch (error) {
		if (error.response) {
			throw new StatusError(
				`${error.response.status} ${error.response.status}`,
				error.response.status,
			);
		}
		throw error;
	}
}

export async function getHtml(
	url: string,
	accept = "text/html, */*",
	timeout = 10000,
	headers?: Record<string, string>,
) {
	const response = await request
		.get(url)
		.set("User-Agent", config.userAgent)
		.set("Accept", accept)
		.set(headers || {})
		.timeout(timeout)
		.agent(getAgentByUrl(new URL(url)));

	return response.text;
}
const _http = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	localAddress: config.outgoingAddress,
} as http.AgentOptions);

/**
 * Get https non-proxy agent
 */
const _https = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	localAddress: config.outgoingAddress,
} as https.AgentOptions);

const maxSockets = Math.max(256, config.deliverJobConcurrency || 128);

/**
 * Get http proxy or non-proxy agent
 */
export const httpAgent = config.proxy
	? new HttpProxyAgent({
			keepAlive: true,
			keepAliveMsecs: 30 * 1000,
			maxSockets,
			maxFreeSockets: 256,
			scheduling: "lifo",
			proxy: config.proxy,
			localAddress: config.outgoingAddress,
	  })
	: _http;

/**
 * Get https proxy or non-proxy agent
 */
export const httpsAgent = config.proxy
	? new HttpsProxyAgent({
			keepAlive: true,
			keepAliveMsecs: 30 * 1000,
			maxSockets,
			maxFreeSockets: 256,
			scheduling: "lifo",
			proxy: config.proxy,
			localAddress: config.outgoingAddress,
	  })
	: _https;

/**
 * Get agent by URL
 * @param url URL
 * @param bypassProxy Allways bypass proxy
 */
export function getAgentByUrl(url: URL, bypassProxy = false) {
	if (bypassProxy || (config.proxyBypassHosts || []).includes(url.hostname)) {
		return url.protocol === "http:" ? _http : _https;
	} else {
		return url.protocol === "http:" ? httpAgent : httpsAgent;
	}
}

export class StatusError extends Error {
	public statusCode: number;
	public statusMessage?: string;
	public isClientError: boolean;

	constructor(message: string, statusCode: number, statusMessage?: string) {
		super(message);
		this.name = "StatusError";
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.isClientError = this.statusCode >= 400 && this.statusCode < 500;
	}
}
