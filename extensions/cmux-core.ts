import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;
const TAB_TITLE_CONTEXT_TIMEOUT_MS = 1000;
const MAX_TAB_TITLE_LENGTH = 48;
const TAB_TITLE_SEPARATOR = " · ";

export type SplitDirection = "right" | "down";

interface CmuxCallerInfo {
	workspace_ref?: string;
	pane_ref?: string;
	surface_ref?: string;
}

interface CmuxCallerContext {
	workspace_ref: string;
	surface_ref: string;
	pane_ref?: string;
}

interface CmuxIdentifyResponse {
	caller?: CmuxCallerInfo;
}

interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

interface CmuxListPanesResponse {
	panes?: CmuxPaneInfo[];
}

interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface OpenCommandInNewSplitOptions {
	tabTitle?: string;
	focus?: boolean;
}

export interface OpenCommandInNewTabOptions {
	tabTitle?: string;
	focus?: boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPiCommand(cwd: string, options?: { sessionFile?: string; prompt?: string }): string {
	// Run pi via a login+interactive zsh so the new cmux surface sources ~/.zprofile/.zshrc.
	// Ghostty executes launch commands through /bin/sh -c, which skips zsh rc files and
	// leaves pi (~/.local/bin) and node (fnm multishell) off PATH -> "command not found: pi".
	const innerParts = ["exec", "pi"];
	if (options?.sessionFile) {
		innerParts.push("--session", shellEscape(options.sessionFile));
	}
	const prompt = options?.prompt?.trim();
	if (prompt) {
		innerParts.push(shellEscape(prompt));
	}
	return ["cd", shellEscape(cwd), "&&", "exec", "zsh", "-l", "-i", "-c", shellEscape(innerParts.join(" "))].join(" ");
}

export function buildShellCommand(cwd: string, command: string): string {
	// Same login+interactive zsh wrap as buildPiCommand: /bin/sh -lc skips zsh rc files,
	// so user PATH tools like pi/node (fnm + ~/.local/bin) are missing in the new surface.
	return ["cd", shellEscape(cwd), "&&", "exec", "zsh", "-l", "-i", "-c", shellEscape(command)].join(" ");
}

function normalizeTabTitle(value: string | undefined, fallback: string): string {
	return (value ?? "").replace(/\s+/g, " ").trim() || fallback.replace(/\s+/g, " ").trim();
}

export function formatTabTitle(value: string | undefined, fallback: string): string {
	const title = normalizeTabTitle(value, fallback);
	if (title.length <= MAX_TAB_TITLE_LENGTH) {
		return title;
	}
	return `${title.slice(0, MAX_TAB_TITLE_LENGTH - 3).trimEnd()}...`;
}

async function getTabTitleContext(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: TAB_TITLE_CONTEXT_TIMEOUT_MS,
		});
		const repoRoot = result.code === 0 && !result.killed ? result.stdout.trim() : "";
		if (repoRoot) {
			return basename(repoRoot) || repoRoot;
		}
	} catch {
		// Fall through to directory basename.
	}

	return basename(cwd) || cwd;
}

export async function buildContextualTabTitle(
	pi: ExtensionAPI,
	cwd: string,
	value: string | undefined,
	fallback: string,
): Promise<string> {
	const title = normalizeTabTitle(value, fallback);
	const context = normalizeTabTitle(await getTabTitleContext(pi, cwd), "");
	return formatTabTitle(context ? `${title}${TAB_TITLE_SEPARATOR}${context}` : title, title);
}

function collectSurfaceRefs(panes: CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) {
			refs.add(pane.selected_surface_ref);
		}
		for (const surfaceRef of pane.surface_refs ?? []) {
			refs.add(surfaceRef);
		}
	}
	return refs;
}

async function execCmux(pi: ExtensionAPI, args: string[]): Promise<CmuxExecResult> {
	const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
	if (result.killed) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: "cmux command timed out",
		};
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`,
		};
	}
	return {
		ok: true,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

async function getCallerInfo(pi: ExtensionAPI): Promise<{ ok: true; caller: CmuxCallerContext } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "identify"]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to identify cmux caller" };
	}

	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) {
		return { ok: false, error: "This command must be run from inside a cmux surface" };
	}

	return {
		ok: true,
		caller: {
			workspace_ref: workspaceRef,
			surface_ref: surfaceRef,
			pane_ref: parsed?.caller?.pane_ref,
		},
	};
}

async function listPanes(pi: ExtensionAPI, workspaceRef: string): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to list cmux panes" };
	}

	const parsed = parseJson<CmuxListPanesResponse>(result.stdout);
	return { ok: true, panes: parsed?.panes ?? [] };
}

async function waitForNewSurface(pi: ExtensionAPI, workspaceRef: string, previousPanes: CmuxPaneInfo[]): Promise<string | undefined> {
	const previousPaneRefs = new Set(previousPanes.map((pane) => pane.ref).filter((ref): ref is string => Boolean(ref)));
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < SPLIT_READY_ATTEMPTS; attempt += 1) {
		const panesResult = await listPanes(pi, workspaceRef);
		if (!panesResult.ok) {
			return undefined;
		}

		for (const pane of panesResult.panes) {
			if (pane.ref && !previousPaneRefs.has(pane.ref)) {
				if (pane.selected_surface_ref) {
					return pane.selected_surface_ref;
				}
				const firstSurfaceRef = pane.surface_refs?.find((ref) => !previousSurfaceRefs.has(ref));
				if (firstSurfaceRef) {
					return firstSurfaceRef;
				}
			}
		}

		for (const pane of panesResult.panes) {
			for (const surfaceRef of pane.surface_refs ?? []) {
				if (!previousSurfaceRefs.has(surfaceRef)) {
					return surfaceRef;
				}
			}
		}

		await delay(SPLIT_READY_DELAY_MS);
	}

	return undefined;
}

async function renameSurfaceTab(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, title: string | undefined): Promise<void> {
	const tabTitle = formatTabTitle(title, "");
	if (!tabTitle) {
		return;
	}

	try {
		await execCmux(pi, [
			"rename-tab",
			"--workspace",
			workspaceRef,
			"--surface",
			surfaceRef,
			"--title",
			tabTitle,
		]);
	} catch {
		// Tab naming is best-effort; the spawned split is still useful if rename fails.
	}
}

async function respawnSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	surfaceRef: string,
	command: string,
	failureMessage: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const respawnResult = await execCmux(pi, [
		"respawn-pane",
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
		"--command",
		command,
	]);
	if (!respawnResult.ok) {
		return { ok: false, error: respawnResult.error || failureMessage };
	}

	return { ok: true };
}

export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
	options: OpenCommandInNewSplitOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	const beforePanesResult = await listPanes(pi, workspaceRef);
	if (!beforePanesResult.ok) {
		return beforePanesResult;
	}

	const splitArgs = [
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
	];
	if (options.focus !== undefined) {
		splitArgs.push("--focus", String(options.focus));
	}

	const splitResult = await execCmux(pi, splitArgs);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error || "Failed to create cmux split" };
	}

	const newSurfaceRef = await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created split, but could not find the new cmux surface" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start pi in the new split");
	if (!respawnResult.ok) {
		return respawnResult;
	}

	await renameSurfaceTab(pi, workspaceRef, newSurfaceRef, options.tabTitle);

	return { ok: true };
}

export async function openCommandInNewTab(
	pi: ExtensionAPI,
	command: string,
	options: OpenCommandInNewTabOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspace_ref: workspaceRef, pane_ref: paneRef } = callerResult.caller;
	if (!paneRef) {
		return { ok: false, error: "This command must be run from inside a cmux pane" };
	}

	const beforePanesResult = await listPanes(pi, workspaceRef);
	if (!beforePanesResult.ok) {
		return beforePanesResult;
	}

	const newSurfaceResult = await execCmux(pi, [
		"new-surface",
		"--type",
		"terminal",
		"--workspace",
		workspaceRef,
		"--pane",
		paneRef,
		"--focus",
		String(options.focus ?? true),
	]);
	if (!newSurfaceResult.ok) {
		return { ok: false, error: newSurfaceResult.error || "Failed to create cmux tab" };
	}

	const newSurfaceRef = await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created tab, but could not find the new cmux surface" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start command in the new tab");
	if (!respawnResult.ok) {
		return respawnResult;
	}

	await renameSurfaceTab(pi, workspaceRef, newSurfaceRef, options.tabTitle);

	return { ok: true };
}
