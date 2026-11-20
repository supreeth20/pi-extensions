import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Snapshot labels in models.json because Pi's built-in model picker has no decoration hook.
const provider = "github-copilot";
const marker = / \[AIC([+*]) ([^\]]+)\]$/;
type Prices = { input_price?: unknown; output_price?: unknown; cache_read_price?: unknown; cache_price?: unknown; cache_write_price?: unknown; max_prompt_tokens?: unknown; context_max?: unknown };
type CatalogModel = { id?: unknown; billing?: { token_prices?: { batch_size?: unknown; default?: Prices; long_context?: Prices } } };

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function compact(value: number): string {
	return value >= 1000 ? `${Number((value / 1000).toPrecision(5))}k` : String(Number(value.toPrecision(5)));
}
function contextSize(value: number): string {
	return value >= 1_000_000 ? `${Number((value / 1_000_000).toPrecision(6))}M` : compact(value);
}
function tier(prices: Prices | undefined, batch: number): string {
	if (!prices || batch <= 0) return "?";
	return [prices.input_price, prices.output_price, prices.cache_read_price ?? prices.cache_price, prices.cache_write_price]
		.map((x) => { const n = number(x); return n === undefined ? "?" : compact(n * 1_000_000 / batch); }).join("/");
}

export function priceLabels(payload: unknown): Map<string, string> {
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) throw new Error("Invalid Copilot model catalog.");
	const labels = new Map<string, string>();
	for (const item of (payload as { data: CatalogModel[] }).data) {
		const prices = item?.billing?.token_prices;
		if (typeof item?.id !== "string" || !prices?.default) continue;
		const batch = number(prices.batch_size) ?? 0;
		const limit = number(prices.default.max_prompt_tokens ?? prices.default.context_max);
		const longLimit = number(prices.long_context?.max_prompt_tokens ?? prices.long_context?.context_max);
		const def = `D${limit ? `≤${contextSize(limit)}` : ""}:${tier(prices.default, batch)}`;
		const long = prices.long_context ? ` L${longLimit ? `≤${contextSize(longLimit)}` : ""}:${tier(prices.long_context, batch)}` : "";
		labels.set(item.id, `${def}${long}`);
	}
	return labels;
}

function object(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Preserve unrelated settings and any pre-existing custom model names.
export function updateNames(config: unknown, labels: Map<string, string>, names: Map<string, string>, clear = false): { count: number; config: Record<string, any> } {
	if (!object(config)) throw new Error("models.json must contain an object.");
	const root = structuredClone(config);
	if (root.providers === undefined) root.providers = {};
	if (!object(root.providers)) throw new Error("models.json providers must be an object.");
	if (root.providers[provider] === undefined) root.providers[provider] = {};
	const p = root.providers[provider];
	if (!object(p)) throw new Error("Copilot provider configuration must be an object.");
	if (p.modelOverrides === undefined) p.modelOverrides = {};
	if (!object(p.modelOverrides)) throw new Error("Copilot modelOverrides must be an object.");
	let count = 0;
	for (const id of clear ? Object.keys(p.modelOverrides) : labels.keys()) {
		if (!clear && !names.has(id)) continue;
		const old = Object.hasOwn(p.modelOverrides, id) ? p.modelOverrides[id] : undefined;
		if (old !== undefined && !object(old)) throw new Error(`Invalid model override for ${id}.`);
		const override = old ?? {};
		const previous = typeof override.name === "string" ? override.name : undefined;
		const match = previous?.match(marker);
		if (clear) {
			if (!match) continue;
			if (match[1] === "*") delete override.name;
			else override.name = previous!.replace(marker, "");
			if (Object.keys(override).length) p.modelOverrides[id] = override;
			else delete p.modelOverrides[id];
			count++;
			continue;
		}
		const name = match ? previous!.replace(marker, "") : previous ?? names.get(id);
		if (!name) continue; // Only label models already known to Pi.
		const provenance = match?.[1] ?? (previous === undefined ? "*" : "+");
		const nextName = `${name} [AIC${provenance} ${labels.get(id)}]`;
		if (nextName === previous) continue;
		override.name = nextName;
		p.modelOverrides[id] = override;
		count++;
	}
	return { count, config: root };
}

async function updateFile(path: string, labels: Map<string, string>, names: Map<string, string>, clear: boolean): Promise<number> {
	let raw: string | undefined;
	try { raw = await readFile(path, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	let config: unknown;
	try { config = raw === undefined ? { providers: {} } : JSON.parse(raw); }
	catch { throw new Error("models.json is not strict JSON; no changes made (JSON comments are not rewritten)."); }
	const updated = updateNames(config, labels, names, clear);
	if (!updated.count) return 0;
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(updated.config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		let current: string | undefined;
		try { current = await readFile(path, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
		if (current !== raw) throw new Error("models.json changed during update; no changes made.");
		await rename(temp, path);
	} finally { await unlink(temp).catch(() => {}); }
	return updated.count;
}

export default function (pi: ExtensionAPI) {
	const unsubscribe = pi.events.on("copilot-context:catalog", (data) => {
		const event = data as { payload: unknown; ctx: ExtensionContext; done?: Promise<number> };
		const names = new Map(event.ctx.modelRegistry.getAll().filter((m) => m.provider === provider).map((m) => [m.id, m.name]));
		event.done = updateFile(join(getAgentDir(), "models.json"), priceLabels(event.payload), names, false);
	});
	pi.on("session_shutdown", () => { unsubscribe(); });
}
