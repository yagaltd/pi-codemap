/**
 * pi-codemap — map + codemap_search / codemap_locate + guarded `edit` +
 * Jev router/gate/rescue. This is the entry `pi install` loads.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemapExtension } from "./ext/extension.ts";

export default function piCodemap(pi: ExtensionAPI) {
	createCodemapExtension(pi, { editTool: false, jev: true, editOverride: true });
}
