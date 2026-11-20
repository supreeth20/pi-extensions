import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Pi resolves its own runtime package for extensions. The pure helpers under test
// do not need that runtime; replace only its getAgentDir import in a temporary copy.
const dir = await mkdtemp(join(tmpdir(), "pi-prices-test-"));
const source = await readFile(new URL("../extensions/copilot-prices.ts", import.meta.url), "utf8");
const testFile = join(dir, "copilot-prices.ts");
await writeFile(testFile, source.replace('import { getAgentDir } from "@earendil-works/pi-coding-agent";', 'const getAgentDir = () => ".";'));
const { default: extension, priceLabels, updateNames } = await import(pathToFileURL(testFile).href);
await rm(dir, { recursive: true, force: true });

const catalog = { data: [
	{ id: "model", billing: { token_prices: { batch_size: 1_000_000,
		default: { max_prompt_tokens: 272_000, input_price: 1000, output_price: 5000, cache_read_price: 100, cache_write_price: 1250 },
		long_context: { max_prompt_tokens: 1_050_000, input_price: 2000, output_price: 7500, cache_read_price: 200, cache_write_price: 2500 },
	} } },
	{ id: "missing", billing: { token_prices: { batch_size: 0, default: { input_price: 0 } } } },
] };

test("unsubscribes from the catalog event on shutdown or reload", () => {
	let unsubscribed = false;
	let shutdown;
	extension({
		events: { on: () => () => { unsubscribed = true; } },
		on: (name, handler) => { if (name === "session_shutdown") shutdown = handler; },
	});
	shutdown({ reason: "reload" });
	assert.equal(unsubscribed, true);
});

test("format both tiers with input, output, cache read and cache write rates", () => {
	const labels = priceLabels(catalog);
	assert.equal(labels.get("model"), "D≤272k:1k/5k/100/1.25k L≤1.05M:2k/7.5k/200/2.5k");
	assert.equal(labels.get("missing"), "D:?");
	assert.throws(() => priceLabels({ data: {} }), /Invalid/);
});

test("preserve unrelated model overrides and restore custom names on clear", () => {
	const initial = { providers: { "github-copilot": { modelOverrides: {
		model: { name: "Custom", contextWindow: 123 }, other: { maxTokens: 42 },
	} }, other: { baseUrl: "https://example.test" } } };
	const names = new Map([["model", "Base"], ["missing", "Missing"]]);
	const applied = updateNames(initial, priceLabels(catalog), names);
	assert.equal(applied.count, 2);
	assert.equal(updateNames(applied.config, priceLabels(catalog), names).count, 0);
	assert.match(applied.config.providers["github-copilot"].modelOverrides.model.name, /^Custom \[AIC\+/);
	assert.equal(initial.providers["github-copilot"].modelOverrides.model.name, "Custom");
	const cleared = updateNames(applied.config, new Map(), names, true);
	assert.equal(cleared.config.providers["github-copilot"].modelOverrides.model.name, "Custom");
	assert.equal(cleared.config.providers["github-copilot"].modelOverrides.model.contextWindow, 123);
	assert.equal(cleared.config.providers["github-copilot"].modelOverrides.missing, undefined);
	assert.deepEqual(cleared.config.providers.other, initial.providers.other);
});
