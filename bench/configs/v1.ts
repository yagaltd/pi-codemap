/**
 * pi-codemap v1 — frozen map snapshot in the system prompt +
 * codemap_search / codemap_locate tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemapExtension } from "../../ext/extension.ts";

export default function codemapV1(pi: ExtensionAPI) {
	createCodemapExtension(pi, { editTool: false });
}
