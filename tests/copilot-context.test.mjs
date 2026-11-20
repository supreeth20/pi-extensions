import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { liveBoundaries } from "../extensions/copilot-context.ts";

const model = {
	id: "test-model",
	provider: "github-copilot",
	api: "openai-responses",
	baseUrl: "https://copilot.test",
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: {},
};

function catalog(id = model.id) {
	return { data: [{ id, billing: { token_prices: {
		default: { max_prompt_tokens: 272_000 },
		long_context: { max_prompt_tokens: 1_000_000 },
	} } }] };
}

function setup() {
	const events = {};
	const commands = {};
	const entries = [];
	const notices = [];
	const catalogEvents = [];
	const ctx = {
		hasUI: true,
		model,
		waitForIdle: async () => {},
		ui: { setStatus() {}, notify: (...args) => notices.push(args) },
		sessionManager: { getBranch: () => entries },
		modelRegistry: {
			find: (_provider, id) => id === model.id ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-secret", baseUrl: model.baseUrl }),
		},
	};
	const pi = {
		events: { emit: (name, event) => { catalogEvents.push({ name, event }); event.done = Promise.resolve(0); } },
		on: (name, handler) => { events[name] = handler; },
		registerCommand: (name, command) => { commands[name] = command; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		setModel: async (selected) => { ctx.model = selected; return true; },
		getSettings: () => ({}),
	};
	extension(pi);
	return { ctx, events, command: commands["copilot-context"], entries, notices, catalogEvents };
}

test("parse current and legacy tier metadata and reject unusable entries", () => {
	assert.throws(() => liveBoundaries({ data: {} }), /invalid model catalog/);
	const limits = liveBoundaries({ data: [
		...catalog().data,
		{ id: "legacy", billing: { token_prices: { default: { context_max: 200_000 }, long_context: { context_max: 900_000 } } } },
		{ id: "no-tier", billing: { token_prices: { default: { max_prompt_tokens: 100 } } } },
		{ id: "bad", billing: { token_prices: { default: { max_prompt_tokens: "100" }, long_context: {} } } },
		null,
	] });
	assert.deepEqual(limits.get("test-model"), { default: 272_000, long: 1_000_000 });
	assert.deepEqual(limits.get("legacy"), { default: 200_000, long: 900_000 });
	assert.equal(limits.size, 2);
});

test("fetch, cache, refresh, resume, and restore the original model window", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		calls++;
		assert.equal(url.href, "https://copilot.test/models");
		assert.equal(options.redirect, "error");
		assert.equal(options.headers.get("x-github-api-version"), "2026-08-01");
		return Response.json(catalog());
	});
	const { ctx, events, command, entries, catalogEvents } = setup();
	await command.handler("default", ctx);
	assert.equal(ctx.model.contextWindow, 272_000);
	assert.equal(entries.at(-1).data.mode, "default");
	assert.equal(catalogEvents.length, 1);
	assert.equal(catalogEvents[0].name, "copilot-context:catalog");
	await command.handler("status", ctx);
	assert.equal(calls, 1);
	assert.equal(catalogEvents.length, 1);
	await command.handler("refresh", ctx);
	assert.equal(calls, 2);
	assert.equal(catalogEvents.length, 2);
	ctx.model = model;
	await events.session_start({}, ctx);
	assert.equal(ctx.model.contextWindow, 272_000);
	await command.handler("long", ctx);
	assert.equal(ctx.model.contextWindow, 1_000_000);
	assert.equal(entries.at(-1).data.mode, "long");
});

test("failed fetch leaves the model unchanged and never reports secret error text", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("test-secret"); });
	const { ctx, command, entries, notices } = setup();
	await command.handler("default", ctx);
	assert.equal(ctx.model.contextWindow, model.contextWindow);
	assert.equal(entries.length, 0);
	assert.match(notices.at(-1)[0], /network error/);
	assert.doesNotMatch(notices.at(-1)[0], /test-secret/);
});

test("missing tier metadata does not change the model", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
	const { ctx, command, entries, notices } = setup();
	await command.handler("default", ctx);
	assert.equal(ctx.model.contextWindow, model.contextWindow);
	assert.equal(entries.length, 0);
	assert.match(notices.at(-1)[0], /No live default-tier boundary/);
});
