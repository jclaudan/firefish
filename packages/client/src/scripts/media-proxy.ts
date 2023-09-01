import { url } from "@/config";
import { query } from "@/scripts/url";

export function getProxiedImageUrl(imageUrl: string, type?: "preview"): string {
	return `${url}/proxy/image.webp?${query({
		url: imageUrl,
		fallback: "1",
		...(type ? { [type]: "1" } : {}),
	})}`;
}

export function getProxiedImageUrlNullable(
	imageUrl: string | null | undefined,
	type?: "preview",
): string | null {
	if (imageUrl == null) return null;
	return getProxiedImageUrl(imageUrl, type);
}
