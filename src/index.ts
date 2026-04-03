import { createWorker } from "@cloudflare/worker-bundler";

const BOOTSTRAP_PATH = "__sandbox__/bootstrap.ts";
const BOOTSTRAP_OUTPUT_PATH = "__sandbox__/bootstrap.js";
const COMPATIBILITY_DATE = "2026-04-03";
const SANDBOX_URL = "https://sandbox.example";

type SandboxFiles = Record<string, string>;

interface SandboxRequestInit {
	body?: string;
	headers?: Record<string, string>;
	method?: string;
	url?: string;
}

interface ExecutePayload {
	entryPoint?: string;
	files?: SandboxFiles;
	request?: SandboxRequestInit;
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(renderHomePage(), {
				headers: {
					"content-type": "text/html; charset=utf-8",
				},
			});
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
				{
					headers: {
						"content-type": "text/html; charset=utf-8",
					},
				},
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

async function executeSandbox(payload: ExecutePayload, env: Env): Promise<Response> {
	const files = payload.files;
	if (!isStringRecord(files) || Object.keys(files).length === 0) {
		return Response.json(
			{ error: "Payload must include a non-empty files object." },
			{ status: 400 },
		);
	}

	let sandboxFiles: SandboxFiles;
	let entryPoint: string;

	try {
		entryPoint = resolveEntryPoint(files, payload.entryPoint);
		sandboxFiles = buildSandboxFiles(files, entryPoint);
	} catch (error) {
		return Response.json({ error: getErrorMessage(error) }, { status: 400 });
	}

	try {
		const bootstrapWorker = await createWorker({
			files: sandboxFiles,
			entryPoint: BOOTSTRAP_PATH,
			bundle: false,
		});

		const guestWorker = await createWorker({
			files: sandboxFiles,
			entryPoint,
			bundle: false,
		});

		const worker = env.LOADER.load({
			compatibilityDate: COMPATIBILITY_DATE,
			globalOutbound: null,
			mainModule: bootstrapWorker.mainModule,
			modules: {
				...guestWorker.modules,
				...bootstrapWorker.modules,
			},
		});

		const sandboxRequest = buildSandboxRequest(payload.request);
		return await worker.getEntrypoint().fetch(sandboxRequest);
	} catch (error) {
		console.error("Sandbox execution failed", error);
		return Response.json({ error: getErrorMessage(error) }, { status: 500 });
	}
}

async function readExecutePayload(request: Request): Promise<ExecutePayload> {
	try {
		return (await request.json()) as ExecutePayload;
	} catch {
		throw new TypeError("Request body must be valid JSON.");
	}
}

function renderHomePage(code = getStarterCode(), output = "Press Run to execute the code."): string {
	const escapedCode = escapeHtml(code);
	const escapedOutput = escapeHtml(output);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dynamic Worker Sandbox</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    body {
      margin: 0;
      padding: 24px;
      background: #f5f5f5;
      color: #111;
    }

    main {
      max-width: 900px;
      margin: 0 auto;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 20px;
    }

    p {
      margin: 0 0 16px;
      color: #555;
      line-height: 1.4;
    }

    textarea,
    pre {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
      background: #fff;
    }

    textarea {
      min-height: 320px;
      resize: vertical;
    }

    button {
      margin: 12px 0 16px;
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      font: inherit;
      background: #111;
      color: #fff;
      cursor: pointer;
    }

    pre {
      min-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <h1>Dynamic Worker Sandbox</h1>
    <p>Paste untrusted Worker code, submit it to <code>/run</code>, and inspect the JSON response.</p>
    <form method="POST" action="/run">
      <textarea id="code" name="code">${escapedCode}</textarea>
      <button type="submit">Run</button>
    </form>
    <pre id="output">${escapedOutput}</pre>
  </main>
</body>
</html>`;
}

function getStarterCode(): string {
	return [
		"export default {",
		"  async fetch() {",
		"    let globalWrite = \"ok\";",
		"    let protoWrite = \"ok\";",
		"",
		"    try {",
		"      globalThis.pwned = true;",
		"    } catch (error) {",
		"      globalWrite = error instanceof Error ? error.name : String(error);",
		"    }",
		"",
		"    try {",
		"      Object.prototype.pwned = true;",
		"    } catch (error) {",
		"      protoWrite = error instanceof Error ? error.name : String(error);",
		"    }",
		"",
		"    return Response.json({",
		"      globalWrite,",
		"      protoWrite,",
		"      globalFrozen: Object.isFrozen(globalThis),",
		"      objectPrototypeFrozen: Object.isFrozen(Object.prototype),",
		"      hasGlobalFlag: \"pwned\" in globalThis,",
		"      objectPrototypePolluted: Object.prototype.pwned === true,",
		"    });",
		"  },",
		"};",
	].join("\n");
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function buildSandboxFiles(files: SandboxFiles, entryPoint: string): SandboxFiles {
	const guestEntrypoint = toOutputPath(entryPoint);
	const guestSpecifier = relativeModuleSpecifier(BOOTSTRAP_OUTPUT_PATH, guestEntrypoint);

	return {
		...files,
		"package.json": mergePackageJson(files["package.json"]),
		[BOOTSTRAP_PATH]: [
			'import "ses";',
			"",
			"let guestModulePromise: Promise<any> | undefined;",
			"",
			"function getGuestModule() {",
			"  if (!guestModulePromise) {",
			"    lockdown();",
			"    Object.freeze(globalThis);",
			`    guestModulePromise = import(${JSON.stringify(guestSpecifier)});`,
			"  }",
			"",
			"  return guestModulePromise;",
			"}",
			"",
			"function getHandler(module: any) {",
			"  const handler = module?.default ?? module;",
			"",
			"  if (!handler || typeof handler.fetch !== \"function\") {",
			"    throw new TypeError(\"Guest module must export a default handler with a fetch() method.\");",
			"  }",
			"",
			"  return handler;",
			"}",
			"",
			"export default {",
			"  async fetch(request: Request) {",
			"    const guestModule = await getGuestModule();",
			"    return getHandler(guestModule).fetch(request);",
			"  },",
			"};",
		].join("\n"),
	};
}

function buildSandboxRequest(request: SandboxRequestInit | undefined): Request {
	return new Request(request?.url ?? SANDBOX_URL, {
		body: request?.body,
		headers: request?.headers,
		method: request?.method ?? (request?.body === undefined ? "GET" : "POST"),
	});
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStringRecord(value: unknown): value is SandboxFiles {
	if (!value || typeof value !== "object") {
		return false;
	}

	return Object.values(value).every((entry) => typeof entry === "string");
}

function mergePackageJson(packageJsonSource: string | undefined): string {
	const packageJson = packageJsonSource === undefined ? {} : JSON.parse(packageJsonSource);
	const dependencies =
		packageJson.dependencies && typeof packageJson.dependencies === "object"
			? packageJson.dependencies
			: {};

	return JSON.stringify(
		{
			...packageJson,
			dependencies: {
				...dependencies,
				ses: dependencies.ses ?? "^1.15.0",
			},
		},
		null,
		2,
	);
}

function relativeModuleSpecifier(fromPath: string, toPath: string): string {
	const fromParts = getDirectory(fromPath).split("/").filter(Boolean);
	const toParts = toPath.split("/");
	const toFile = toParts.pop();

	if (!toFile) {
		throw new TypeError(`Invalid module path: ${toPath}`);
	}

	let sharedParts = 0;
	while (
		sharedParts < fromParts.length &&
		sharedParts < toParts.length &&
		fromParts[sharedParts] === toParts[sharedParts]
	) {
		sharedParts++;
	}

	const upSegments = fromParts.length - sharedParts;
	const downSegments = toParts.slice(sharedParts);
	const relativeParts = [
		...(upSegments === 0 ? ["."] : new Array(upSegments).fill("..")),
		...downSegments,
		toFile,
	];

	return relativeParts.join("/");
}

function getDirectory(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	return lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
}

function resolveEntryPoint(files: SandboxFiles, entryPoint: string | undefined): string {
	if (entryPoint !== undefined) {
		if (!(entryPoint in files)) {
			throw new TypeError(`Entry point \"${entryPoint}\" was not found in files.`);
		}

		return entryPoint;
	}

	const packageJsonSource = files["package.json"];
	if (packageJsonSource !== undefined) {
		const packageJson = JSON.parse(packageJsonSource) as {
			exports?: string;
			main?: string;
			module?: string;
		};

		for (const candidate of [packageJson.exports, packageJson.module, packageJson.main]) {
			if (candidate && candidate in files) {
				return candidate;
			}
		}
	}

	for (const candidate of ["src/index.ts", "src/index.js", "index.ts", "index.js"]) {
		if (candidate in files) {
			return candidate;
		}
	}

	const filePaths = Object.keys(files).filter((filePath) => filePath !== "package.json");
	if (filePaths.length === 1) {
		return filePaths[0]!;
	}

	throw new TypeError("Could not determine entry point. Provide entryPoint explicitly.");
}

function toOutputPath(filePath: string): string {
	if (filePath.endsWith(".mts")) {
		return `${filePath.slice(0, -4)}.mjs`;
	}

	if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
		return `${filePath.replace(/\.tsx?$/, "")}.js`;
	}

	return filePath;
}
