import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { JobHandoffDoc } from "./tasks.ts";

const handoffTool = defineTool({
	name: "handoff",
	description:
		"Hand this job's remaining work to a new job or back to the coordinator (main). Provide a self-contained " +
		"brief and a short summary of verified progress. The handoff ends this job after the current tool round.",
	parameters: obj({
		target: oneOf(["job", "main"]),
		brief: str({ minLength: 1, maxLength: 2000 }),
		summary: str({ minLength: 1, maxLength: 4000 }),
	}),
	// Recording a handoff changes control flow; do not rerun it after a cut.
	replay: "unsafe",
	execute: async (args, api, context) => {
		const target = args.target;
		const brief = args.brief.trim();
		const summary = args.summary.trim();
		if (brief.length === 0 || summary.length === 0) {
			return { isError: true, output: [{ type: "text" as const, text: "A handoff needs a brief and a summary." }] };
		}
		const existing = await api.snapshot(JobHandoffDoc, api.conversationId, context);
		if (existing !== undefined && existing.brief.length > 0) {
			if (existing.target === target && existing.brief === brief && existing.summary === summary) {
				return {
					output: [{ type: "text" as const, text: "This handoff was already recorded; the job ends here." }],
					control: { terminate: true },
				};
			}
			return {
				isError: true,
				output: [{ type: "text" as const, text: "A different handoff is already recorded for this job." }],
			};
		}
		await api.commit(async (tx) => {
			const doc = await tx.doc(JobHandoffDoc, api.conversationId);
			doc.target = target;
			doc.brief = brief;
			doc.summary = summary;
			doc.at = Date.now();
		}, context);
		return {
			output: [{
				type: "text" as const,
				text: target === "main"
					? "Handoff to main recorded. The coordinator receives the summary and continuation brief; this job ends."
					: "Handoff to a successor job recorded. The successor receives the summary and continuation brief; this job ends.",
			}],
			control: { terminate: true },
		};
	},
});

export const JobHandoffTools = defineExtension({
	name: "durable-chat.handoff",
	tools: [handoffTool],
});
