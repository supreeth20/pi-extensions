import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// This only adjusts Pi's compaction budget; it does not select a Copilot SDK tier.
const PROVIDER = "github-copilot";
const ENTRY = "copilot-context-mode";
type Mode = "default" | "long";

type CatalogEntry = {
	id?: unknown;
	billing?: { token_prices?: {
		default?: { max_prompt_tokens?: unknown; context_max?: unknown };
		long_context?: { max_prompt_tokens?: unknown; context_max?: unknown };
	} };
};

type TierLimits = { default: number; long?: number };

export function liveBoundaries(payload: unknown): Map<string, TierLimits> {
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
		throw new Error("Copilot returned an invalid model catalog.");
	}
	const result = new Map<string, TierLimits>();
	for (const item of (payload as { data: CatalogEntry[] }).data) {
		const prices = item?.billing?.token_prices;
		const limit = prices?.default?.max_prompt_tokens ?? prices?.default?.context_max;
		const long = prices?.long_context?.max_prompt_tokens ?? prices?.long_context?.context_max;
		if (typeof item?.id === "string" && prices?.long_context &&
			typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
			result.set(item.id, {
				default: limit,
				...(typeof long === "number" && Number.isSafeInteger(long) && long > 0 ? { long } : {}),
			});
		}
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "long";
	let applying = false;
	let cache: { key: string; expires: number; boundaries: Map<string, TierLimits> } | undefined;

	async function boundary(ctx: ExtensionContext, model: Model<Api>, refresh = false): Promise<TierLimits | undefined> {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error("Copilot authentication could not be resolved.");
		if (!auth.apiKey) throw new Error("No Copilot API token is available.");
		const base = new URL(auth.baseUrl ?? model.baseUrl);
		if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
			throw new Error("Copilot catalog endpoint must use HTTPS or a local HTTP endpoint.");
		}
		const url = new URL(`${base.pathname.replace(/\/$/, "")}/models`, base.origin);
		const key = createHash("sha256").update(url.href).update("\0").update(auth.apiKey)
			.update("\0").update(JSON.stringify(auth.headers ?? {})).digest("hex");
		if (!refresh && cache?.key === key && cache.expires > Date.now()) return cache.boundaries.get(model.id);
		const headers = new Headers({
			Accept: "application/json",
			"User-Agent": "GitHubCopilotChat/0.35.0",
			"Editor-Version": "vscode/1.107.0",
			"Editor-Plugin-Version": "copilot-chat/0.35.0",
			"Copilot-Integration-Id": "vscode-chat",
			"X-GitHub-Api-Version": "2026-08-01",
		});
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headers.set(name, value);
		}
		headers.set("Authorization", `Bearer ${auth.apiKey}`);
		const timeout = AbortSignal.timeout(10_000);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(url, { headers, signal, redirect: "error" });
		} catch {
			throw new Error("Could not reach the Copilot model catalog (network error, redirect, or timeout).");
		}
		if (!response.ok) throw new Error(`Copilot model catalog returned HTTP ${response.status}.`);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("Copilot model catalog did not return valid JSON.");
		}
		const boundaries = liveBoundaries(payload);
		cache = { key, expires: Date.now() + 5 * 60_000, boundaries };
		return boundaries.get(model.id);
	}

	function restoreMode(ctx: ExtensionContext) {
		mode = "long";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data = entry.data as { mode?: unknown } | undefined;
			if (data?.mode === "default" || data?.mode === "long") mode = data.mode;
		}
	}

	async function apply(ctx: ExtensionContext, refresh = false): Promise<string> {
		const current = ctx.model;
		if (!current || current.provider !== PROVIDER) {
			return "Select a GitHub Copilot model first.";
		}
		const original = ctx.modelRegistry.find(PROVIDER, current.id);
		if (!original || original.api === "pi-virtual") {
			return "The selected model is not a physical Copilot catalog model.";
		}
		const liveLimits = mode === "default" ? await boundary(ctx, original, refresh) : undefined;
		if (mode === "default" && liveLimits === undefined) {
			return `No live default-tier boundary is available for ${original.id}; the model limit was not changed.`;
		}
		const limit = mode === "default" ? Math.min(original.contextWindow, liveLimits!.default) : original.contextWindow;
		if (current.contextWindow !== limit) {
			applying = true;
			try {
				if (!(await pi.setModel({ ...original, contextWindow: limit }))) {
					throw new Error(`Authentication unavailable for ${PROVIDER}/${original.id}`);
				}
			} finally {
				applying = false;
			}
		}
		const label = mode === "default" ? `default ${limit.toLocaleString()}` : `long ${limit.toLocaleString()}`;
		return `Copilot ${original.id}: ${label} tokens (local compaction budget${mode === "default" ? "; live Copilot catalog boundary" : ""}; actual pricing depends on prompt size).`;
	}

	async function applyFromEvent(ctx: ExtensionContext) {
		try {
			const message = await apply(ctx);
			if (ctx.hasUI && message.includes("not changed")) ctx.ui.notify(message, "warning");
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Copilot context budget not updated: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("copilot-context", undefined);
		restoreMode(ctx);
		if (mode === "default") await applyFromEvent(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!applying) await applyFromEvent(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreMode(ctx);
		await applyFromEvent(ctx);
	});

	pi.registerCommand("copilot-context", {
		description: "Choose Copilot local compaction budget: default or long",
		getArgumentCompletions: (prefix) => {
			const matches = ["default", "long", "status", "refresh"].filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let choice = args.trim().toLowerCase();
			if (!choice && ctx.hasUI) {
				choice = (await ctx.ui.select("Copilot local context budget", ["default", "long", "status", "refresh"])) ?? "";
			}
			if (!choice) return;
			if (choice === "status" || choice === "refresh") {
				const current = ctx.model;
				const original = current?.provider === PROVIDER ? ctx.modelRegistry.find(PROVIDER, current.id) : undefined;
				if (!original || original.api === "pi-virtual") {
					ctx.ui.notify("Select a physical GitHub Copilot model first.", "warning");
					return;
				}
				try {
					const liveLimits = await boundary(ctx, original, choice === "refresh");
					if (choice === "refresh" && mode === "default") await apply(ctx);
					ctx.ui.notify(`Mode: ${mode}; live Copilot prompt boundaries: default ${liveLimits?.default.toLocaleString() ?? "unavailable"}, long ${liveLimits?.long?.toLocaleString() ?? "unavailable"}. This is not a server-side tier selector.`, liveLimits ? "info" : "warning");
				} catch (error) {
					ctx.ui.notify(`Copilot catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (choice !== "default" && choice !== "long") {
				ctx.ui.notify("Usage: /copilot-context [default|long|status|refresh]", "error");
				return;
			}
			await ctx.waitForIdle();
			const previous = mode;
			mode = choice;
			try {
				const message = await apply(ctx, choice === "default");
				if (message.includes("not changed") || message.startsWith("Select ") || message.includes("not a physical")) {
					mode = previous;
					await apply(ctx);
					ctx.ui.notify(message, "warning");
					return;
				}
				pi.appendEntry(ENTRY, { mode });
				const disabled = mode === "default" && pi.getSettings().compaction?.enabled === false;
				ctx.ui.notify(
					`${message} ${disabled ? "Automatic compaction is disabled. " : ""}Pi's token estimate and compaction can exceed the boundary; no billing guarantee.`,
					disabled ? "warning" : "info",
				);
			} catch (error) {
				mode = previous;
				ctx.ui.notify(`Could not change Copilot context budget: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
