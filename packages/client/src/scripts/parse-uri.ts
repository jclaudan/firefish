export function parseUri(uri: string): {
	scheme: string;
	authority: string | null;
	path: string | null;
	query: string | null;
	fragment: string | null;
} {
	const urlParts = uri.match(
		/^(\w+):(\/\/)?([^/?#]*)(\/([^?#]*))?(\?([^#]*))?(#(.*))?$/,
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
