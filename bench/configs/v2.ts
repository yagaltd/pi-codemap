/**
 * pi-codemap v2 — v1 plus codemap_edit_symbol: edit-by-name with fresh-parse
 * locate, Buffer-domain splice, reparse validation, and rollback.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemapExtension } from "../../ext/extension.ts";

export default function codemapV2(pi: ExtensionAPI) {
	createCodemapExtension(pi, { editTool: true });
}
