import * as mfm from "ffm-js";
import { unique } from "@/prelude/array.js";

export function extractHashtags(nodes: mfm.MfmNode[]): string[] {
	const hashtagNodes = mfm.extract(nodes, (node) => node.type === "hashtag");
	const hashtags = unique(hashtagNodes.map((x) => x.props.hashtag));

	return hashtags;
}
