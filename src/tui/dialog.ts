import { compositeTuiLine, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, dim } from "./format.ts";

/** A content-sized dialog composited over a dashboard frame, without owning input. */
export function overlayDialog(frame: readonly string[], width: number, title: string, body: string, hint: string): string[] {
	if (frame.length === 0 || width < 1) return [...frame];
	const boxWidth = Math.min(60, width >= 24 ? width - 4 : width);
	if (boxWidth < 5 || frame.length < 4) {
		return frame.map((line, index) => index === 0 ? truncateToWidth(`${title} ${hint}`, width, "", true) : line);
	}
	const inner = boxWidth - 4;
	const footer = wrapTextWithAnsi(dim(hint), inner).slice(0, frame.length - 3);
	const available = frame.length - 3 - footer.length;
	const gaps = available >= 4;
	const details = wrapTextWithAnsi(body, inner);
	const capacity = Math.max(0, available - (gaps ? 2 : 0));
	const shown = details.slice(0, capacity);
	if (details.length > capacity && shown.length > 0) {
		shown[shown.length - 1] = `${truncateToWidth(shown[shown.length - 1]!, inner - 1, "", true)}…`;
	}
	const content = [
		bold(title),
		...(gaps ? [""] : []),
		...shown,
		...(gaps ? [""] : []),
		...footer,
	];
	const dialog = [
		dim(`┌${"─".repeat(boxWidth - 2)}┐`),
		...content.map((line) => `${dim("│")} ${truncateToWidth(line, inner, "", true)} ${dim("│")}`),
		dim(`└${"─".repeat(boxWidth - 2)}┘`),
	];
	const left = Math.floor((width - boxWidth) / 2);
	const top = Math.floor((frame.length - dialog.length) / 2);
	return frame.map((line, index) => {
		const overlay = dialog[index - top];
		return overlay === undefined ? line : compositeTuiLine(line, overlay, left, boxWidth, width);
	});
}
