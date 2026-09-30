/**
 * pi-codemap v1.1 — v1 + Jev add-ons:
 *  - router: skip the map section on confident non-code sessions
 *  - gate:   Jev re-ranks only doubtful codemap_search shortlists
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemapExtension } from "../ext/extension.ts";

export default function codemapV11(pi: ExtensionAPI) {
	createCodemapExtension(pi, { editTool: false, jev: true });
}
