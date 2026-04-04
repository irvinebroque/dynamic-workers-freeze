import {
	createInlineSandboxSession,
	executeSandbox,
	readExecutePayload,
} from "./sandbox";
import { renderHomePage } from "./ui";

const RUN_REQUEST_COUNT = 3;

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return renderHtml(renderHomePage());
		}

		if (request.method === "POST" && url.pathname === "/run") {
			const formData = await request.formData();
			const code = String(formData.get("code") ?? "");
			const executionOutput = await runDemo(code, env);

			return new Response(
				renderHomePage(code, executionOutput),
				htmlResponseInit,
			);
		}

		if (request.method !== "POST" || url.pathname !== "/execute") {
			return new Response("Not found", { status: 404 });
		}

		try {
			return executeSandbox(await readExecutePayload(request), env);
		} catch (error) {
			return Response.json({ error: getErrorMessage(error) }, { status: 400 });
		}
	},
} satisfies ExportedHandler<Env>;

const htmlResponseInit = {
	headers: {
		"content-type": "text/html; charset=utf-8",
	},
};

function renderHtml(body: string): Response {
	return new Response(body, htmlResponseInit);
}

async function runDemo(code: string, env: Env): Promise<string> {
	try {
		const session = await createInlineSandboxSession(code, env);
		const results = [];

		for (let requestNumber = 1; requestNumber <= RUN_REQUEST_COUNT; requestNumber++) {
			results.push(
				await formatRunResult(
					requestNumber,
					await session.fetch({
						headers: {
							"x-demo-request-number": String(requestNumber),
						},
					}),
				),
			);
		}

		const isolateIds = new Set(results.map((result) => result.isolateId));
		const summary =
			isolateIds.size === 1
				? `Made ${RUN_REQUEST_COUNT} requests against one loaded dynamic worker isolate.`
				: `Expected one isolate, but saw ${isolateIds.size}.`;

		return [
			summary,
			"Top-level let state should reset for every response below.",
			"",
			...results.map((result) => result.formatted),
		].join("\n");
	} catch (error) {
		const status = error instanceof TypeError ? 400 : 500;
		return `HTTP ${status}\n\n${getErrorMessage(error)}`;
	}
}

async function formatRunResult(
	requestNumber: number,
	response: Response,
): Promise<{ formatted: string; isolateId: string }> {
	const responseBody = await response.text();
	let formattedBody = responseBody;

	try {
		formattedBody = JSON.stringify(JSON.parse(responseBody), null, 2);
	} catch {}

	const isolateId = response.headers.get("x-sandbox-isolate-id") ?? "missing";
	const executionId = response.headers.get("x-sandbox-execution-id") ?? "missing";

	return {
		formatted: [
			`Request ${requestNumber}`,
			`x-sandbox-isolate-id: ${isolateId}`,
			`x-sandbox-execution-id: ${executionId}`,
			`HTTP ${response.status}`,
			"",
			formattedBody,
			"",
		].join("\n"),
		isolateId,
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
