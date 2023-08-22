type URI = {
	scheme: string;
	authority: string | null;
	path: string | null;
	query: string | null;
	fragment: string | null;
}

export function parseUri(uri: string): URI {
	const urlParts = uri.match(
		/^([\w+]+):(\/\/)?([^/?#]*)(\/([^?#]*))?(\?([^#]*))?(#(.*))?$/,
	);

	if (!urlParts) {
		throw new Error("Invalid URL format");
	}

	const [, scheme, withAuthority, authority, path, , query, , fragment] =
		urlParts;

	return {
		scheme,
		authority: withAuthority ? authority : null,
		path: withAuthority ? path ?? null : `${authority}${path ?? ""}`,
		query: query ?? null,
		fragment: fragment || null,
	};
}

export function parsedUriToString(uri: URI): string {
	let result = `${uri.scheme}:`;

	if (uri.authority) {
		result += `//${uri.authority}`;
	}

	if (uri.path) {
		result += uri.path;
	}

	if (uri.query) {
		result += `?${uri.query}`;
	}

	if (uri.fragment) {
		result += `#${uri.fragment}`;
	}

	return result;
}
