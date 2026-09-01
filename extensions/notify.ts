/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 * - notify-send (mako) + niri window urgency (Waybar `.urgent` style)
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

function desktopNotify(title: string, body: string): void {
	// Best-effort mako notification; ignore missing notify-send / errors.
	execFile("notify-send", [title, body], { timeout: 5000, killSignal: "SIGKILL" }, () => {});
}

interface NiriWindow {
	id?: unknown;
	pid?: unknown;
	app_id?: unknown;
}

function setNiriUrgent(urgent: boolean): void {
	// Best-effort: mark this Pi terminal window urgent in niri so Waybar's
	// `.urgent` workspace style highlights it. Silently no-op without niri.
	execFile("niri", ["msg", "-j", "windows"], { timeout: 5000, killSignal: "SIGKILL" }, (err, stdout) => {
		if (err) return;
		let windows: unknown;
		try {
			windows = JSON.parse(stdout);
		} catch {
			return;
		}
		if (!Array.isArray(windows)) return;
		const piWindows = windows.filter(
			(w): w is NiriWindow => typeof w === "object" && w !== null && (w as NiriWindow).app_id === "ProjectPi",
		);
		const win = piWindows.find((w) => w.pid === process.pid) ?? piWindows[0];
		const id = typeof win?.id === "number" && Number.isInteger(win.id) ? win.id : undefined;
		if (id === undefined) return;
		const action = urgent ? "set-window-urgent" : "unset-window-urgent";
		execFile("niri", ["msg", "action", action, "--id", String(id)], { timeout: 5000, killSignal: "SIGKILL" }, () => {});
	});
}

function emit(title: string, body: string): void {
	notify(title, body);
	desktopNotify(title, body);
	setNiriUrgent(true);
}

export default function (pi: ExtensionAPI) {
	let uiPromptActive = false;

	pi.on("ui_prompt_start", async (event) => {
		uiPromptActive = true;
		if (event.kind === "custom") {
			const workspace = basename(process.cwd()) || process.cwd();
			emit(`Pi — ${workspace}`, "Questionnaire waiting for input");
		}
	});

	pi.on("ui_prompt_end", async () => {
		uiPromptActive = false;
		setNiriUrgent(false);
	});

	pi.on("agent_start", async () => {
		setNiriUrgent(false);
	});

	// `agent_end` fires after each low-level run; Pi may still retry, compact,
	// or continue with queued follow-ups. Notify only after the full run settles.
	pi.on("agent_settled", async () => {
		if (uiPromptActive) return;
		const workspace = basename(process.cwd()) || process.cwd();
		emit(`Pi — ${workspace}`, "Ready for input");
	});
}
