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

export interface ExecutePayload {
	entryPoint?: string;
	files?: SandboxFiles;
	request?: SandboxRequestInit;
}

export async function executeSandbox(payload: ExecutePayload, env: Env): Promise<Response> {
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

export async function readExecutePayload(request: Request): Promise<ExecutePayload> {
	try {
		return (await request.json()) as ExecutePayload;
	} catch {
		throw new TypeError("Request body must be valid JSON.");
	}
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
