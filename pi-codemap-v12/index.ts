/**
 * pi-codemap v12 — v11 + edit override: pi's `edit` tool is replaced by the
 * codemap-guarded version (parse-safety + symbol-range containment,
 * validate-then-write). Same oldText/newText semantics, so model behavior
 * carries over; every edit now passes our precision guard.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemapExtension } from "../ext/extension.ts";

export default function codemapV12(pi: ExtensionAPI) {
	createCodemapExtension(pi, { editTool: false, jev: true, editOverride: true });
}
