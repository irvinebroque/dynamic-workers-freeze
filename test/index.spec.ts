import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const sandboxPayload = {
	entryPoint: "src/index.ts",
	files: {
		"src/index.ts": [
			"export default {",
			"  async fetch() {",
			"    let globalWrite = 'unexpected-success';",
			"    let prototypeWrite = 'unexpected-success';",
			"",
			"    try {",
			"      globalThis.compromised = true;",
			"    } catch (error) {",
			"      globalWrite = error instanceof Error ? error.name : String(error);",
			"    }",
			"",
			"    try {",
			"      Object.prototype.compromised = true;",
			"    } catch (error) {",
			"      prototypeWrite = error instanceof Error ? error.name : String(error);",
			"    }",
			"",
			"    return Response.json({",
			"      globalWrite,",
			"      prototypeWrite,",
			"      hasGlobalFlag: 'compromised' in globalThis,",
			"      objectPrototypeFrozen: Object.isFrozen(Object.prototype),",
			"      objectPrototypePolluted: Object.prototype.compromised === true,",
			"      globalFrozen: Object.isFrozen(globalThis),",
			"    });",
			"  },",
			"};",
		].join("\n"),
	},
};

describe("Dynamic worker sandbox", () => {
	it("builds a SES-locked dynamic worker before executing guest code (unit style)", async () => {
		let capturedWorkerCode: WorkerLoaderWorkerCode | undefined;
		const loader = {
			load(workerCode: WorkerLoaderWorkerCode) {
				capturedWorkerCode = workerCode;

				return {
					getEntrypoint() {
						return {
							fetch: vi.fn(async (sandboxRequest: Request) =>
								Response.json({
									method: sandboxRequest.method,
									url: sandboxRequest.url,
								}),
							),
						};
					},
				};
			},
		} as unknown as WorkerLoader;

		const request = new IncomingRequest("http://example.com/execute", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(sandboxPayload),
		});
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, LOADER: loader } as Env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			method: "GET",
			url: "https://sandbox.example/",
		});

		expect(capturedWorkerCode).toBeDefined();
		expect(capturedWorkerCode?.compatibilityDate).toBe("2026-04-03");
		expect(capturedWorkerCode?.globalOutbound).toBeNull();
		expect(capturedWorkerCode?.mainModule).toBe("__sandbox__/bootstrap.js");
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			'import "/node_modules/ses/index.js";',
		);
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain("lockdown();");
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			"return { source: new ModuleSource(module, specifier) };",
		);
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			"new Compartment({",
		);
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			"Object.freeze(compartment.globalThis);",
		);
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			'headers.set("x-sandbox-isolate-id", getIsolateId());',
		);
		expect(capturedWorkerCode?.modules["node_modules/ses/index.js"]).toBeTypeOf("string");
		expect(
			Object.keys(capturedWorkerCode?.modules ?? {}).some((modulePath) =>
				modulePath.includes("@endo/module-source"),
			),
		).toBe(true);
	});

	it("serves usage instructions from the deployed worker (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("Dynamic Worker Sandbox");
		expect(html).toContain("/run");
	});

	it("runs multiple requests against one loaded dynamic worker", async () => {
		let requestCount = 0;
		const isolateId = "test-isolate";
		const loader = {
			load() {
				return {
					getEntrypoint() {
						return {
							fetch: vi.fn(async () => {
								requestCount += 1;
								return Response.json(
									{ moduleCounter: 1 },
									{
										headers: {
											"x-sandbox-isolate-id": isolateId,
											"x-sandbox-execution-id": String(requestCount),
										},
									},
								);
							}),
						};
					},
				};
			},
		} as unknown as WorkerLoader;

		const formData = new FormData();
		formData.set(
			"code",
			[
				"let moduleCounter = 0;",
				"",
				"export default {",
				"  async fetch() {",
				"    moduleCounter += 1;",
				"    return Response.json({ moduleCounter });",
				"  },",
				"};",
			].join("\n"),
		);

		const request = new IncomingRequest("https://example.com/run", {
			method: "POST",
			body: formData,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, LOADER: loader } as Env, ctx);
		await waitOnExecutionContext(ctx);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("Made 3 requests against one loaded dynamic worker isolate.");
		expect(html).toContain("Request 1");
		expect(html).toContain("Request 2");
		expect(html).toContain("Request 3");
		expect(html.match(/"moduleCounter": 1/g)).toHaveLength(3);

		const isolateIds = [...html.matchAll(/x-sandbox-isolate-id: ([\w-]+)/g)].map(
			(match) => match[1],
		);
		expect(isolateIds).toHaveLength(3);
		expect(new Set(isolateIds).size).toBe(1);
		expect(html).toContain("x-sandbox-execution-id: 1");
		expect(html).toContain("x-sandbox-execution-id: 2");
		expect(html).toContain("x-sandbox-execution-id: 3");
	});
});
