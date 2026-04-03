import { executeSandbox, readExecutePayload } from "./sandbox";
import { renderHomePage } from "./ui";

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return renderHtml(renderHomePage());
		}

		if (request.method === "POST" && url.pathname === "/run") {
			const formData = await request.formData();
			const code = String(formData.get("code") ?? "");
			const executionResponse = await executeSandbox(
				{
					entryPoint: "src/index.ts",
					files: {
						"src/index.ts": code,
					},
				},
				env,
			);
			const responseBody = await executionResponse.text();
			let formattedBody = responseBody;

			try {
				formattedBody = JSON.stringify(JSON.parse(responseBody), null, 2);
			} catch {}

			return new Response(
				renderHomePage(code, `HTTP ${executionResponse.status}\n\n${formattedBody}`),
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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
