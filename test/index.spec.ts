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
			"Object.freeze(globalThis);",
		);
		expect(capturedWorkerCode?.modules["__sandbox__/bootstrap.js"]).toContain(
			'guestModulePromise = import("../src/index.js")',
		);
		expect(capturedWorkerCode?.modules["node_modules/ses/index.js"]).toBeTypeOf("string");
	});

	it("serves usage instructions from the deployed worker (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("Dynamic Worker Sandbox");
		expect(html).toContain("/run");
	});
});
