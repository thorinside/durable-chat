import childProcess from "node:child_process";

/** Open an explicitly activated web link without passing transcript content through a shell. */
export async function openBrowser(address: string, platform: NodeJS.Platform = process.platform): Promise<void> {
	if (/[\u0000-\u001f\u007f]/.test(address)) throw new Error("Invalid web link.");
	const url = new URL(address);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS links can be opened.");
	const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32.exe" : "xdg-open";
	const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
	await new Promise<void>((resolve, reject) => {
		childProcess.execFile(command, args, { windowsHide: true }, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
