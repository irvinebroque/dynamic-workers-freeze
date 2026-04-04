import { createWorker } from "@cloudflare/worker-bundler";

const BOOTSTRAP_PATH = "__sandbox__/bootstrap.ts";
const COMPATIBILITY_DATE = "2026-04-03";
const GUEST_MODULE_SPECIFIER = "guest";
const MODULE_SOURCE_VERSION = "^1.4.0";
const SES_VERSION = "^1.15.0";
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

export interface SandboxSession {
	fetch(request?: SandboxRequestInit): Promise<Response>;
}

export async function createInlineSandboxSession(code: string, env: Env): Promise<SandboxSession> {
	const guestWorker = await createWorker({
		files: {
			"src/index.ts": code,
		},
		entryPoint: "src/index.ts",
		bundle: false,
	});
	const guestSource = guestWorker.modules[guestWorker.mainModule];
	if (typeof guestSource !== "string") {
		throw new TypeError("Guest entrypoint must compile to a JavaScript module.");
	}

	const bootstrapWorker = await createWorker({
		files: buildInlineBootstrapFiles(buildInlineGuestModuleSource(guestSource)),
		entryPoint: BOOTSTRAP_PATH,
		bundle: false,
	});

	const worker = env.LOADER.load({
		compatibilityDate: COMPATIBILITY_DATE,
		globalOutbound: null,
		mainModule: bootstrapWorker.mainModule,
		modules: bootstrapWorker.modules,
	});
	const entrypoint = worker.getEntrypoint();

	return {
		fetch(request) {
			return entrypoint.fetch(buildSandboxRequest(request));
		},
	};
}

export async function executeSandbox(payload: ExecutePayload, env: Env): Promise<Response> {
	try {
		const session = await createSandboxSession(payload, env);
		return await session.fetch(payload.request);
	} catch (error) {
		if (error instanceof SandboxPayloadError) {
			return Response.json({ error: error.message }, { status: 400 });
		}

		console.error("Sandbox execution failed", error);
		return Response.json({ error: getErrorMessage(error) }, { status: 500 });
	}
}

export async function createSandboxSession(
	payload: ExecutePayload,
	env: Env,
): Promise<SandboxSession> {
	const files = payload.files;
	if (!isStringRecord(files) || Object.keys(files).length === 0) {
		throw new SandboxPayloadError("Payload must include a non-empty files object.");
	}

	let entryPoint: string;

	try {
		entryPoint = resolveEntryPoint(files, payload.entryPoint);
	} catch (error) {
		throw new SandboxPayloadError(getErrorMessage(error));
	}

	const guestWorker = await createWorker({
		files,
		entryPoint,
		bundle: false,
	});

	const bootstrapWorker = await createWorker({
		files: buildBootstrapFiles(guestWorker.mainModule, guestWorker.modules),
		entryPoint: BOOTSTRAP_PATH,
		bundle: false,
	});

	const worker = env.LOADER.load({
		compatibilityDate: COMPATIBILITY_DATE,
		globalOutbound: null,
		mainModule: bootstrapWorker.mainModule,
		modules: bootstrapWorker.modules,
	});
	const entrypoint = worker.getEntrypoint();

	return {
		fetch(request) {
			return entrypoint.fetch(buildSandboxRequest(request));
		},
	};
}

export async function readExecutePayload(request: Request): Promise<ExecutePayload> {
	try {
		return (await request.json()) as ExecutePayload;
	} catch {
		throw new TypeError("Request body must be valid JSON.");
	}
}

function buildBootstrapFiles(
	guestMainModule: string,
	guestModules: WorkerLoaderWorkerCode["modules"],
): SandboxFiles {
	return {
		"package.json": JSON.stringify(
			{
				private: true,
				dependencies: {
					"@endo/module-source": MODULE_SOURCE_VERSION,
					ses: SES_VERSION,
				},
			},
			null,
			2,
		),
		[BOOTSTRAP_PATH]: [
			'import "ses";',
			'import { ModuleSource } from "@endo/module-source";',
			"",
			"lockdown();",
			"Object.freeze(globalThis);",
			"",
			`const GUEST_MAIN_MODULE = ${JSON.stringify(guestMainModule)};`,
			`const GUEST_MODULES = ${JSON.stringify(guestModules)};`,
			"let isolateId: string | undefined;",
			"let executionCount = 0;",
			"",
			"function getIsolateId(): string {",
			"  isolateId ??= crypto.randomUUID();",
			"  return isolateId;",
			"}",
			"",
			"function createConsole() {",
			"  return harden({",
			"    log: (...args: unknown[]) => console.log(...args),",
			"    info: (...args: unknown[]) => console.info(...args),",
			"    warn: (...args: unknown[]) => console.warn(...args),",
			"    error: (...args: unknown[]) => console.error(...args),",
			"    debug: (...args: unknown[]) => console.debug(...args),",
			"  });",
			"}",
			"",
			"function resolveGuestSpecifier(specifier: string, referrer: string = GUEST_MAIN_MODULE): string {",
			"  if (specifier.startsWith(\"/\")) {",
			"    return specifier.slice(1);",
			"  }",
			"",
			"  if (!specifier.startsWith(\".\")) {",
			"    return specifier;",
			"  }",
			"",
			"  const referrerParts = referrer.split(\"/\");",
			"  referrerParts.pop();",
			"",
			"  for (const segment of specifier.split(\"/\")) {",
			"    if (segment === \".\" || segment === \"\") {",
			"      continue;",
			"    }",
			"",
			"    if (segment === \"..\") {",
			"      referrerParts.pop();",
			"      continue;",
			"    }",
			"",
			"    referrerParts.push(segment);",
			"  }",
			"",
			"  return referrerParts.join(\"/\");",
			"}",
			"",
			"function createValueModule(value: unknown) {",
			"  return {",
			"    imports: [],",
			"    exports: [\"default\"],",
			"    execute(exports: Record<string, unknown>) {",
			"      exports.default = value;",
			"    },",
			"  };",
			"}",
			"",
			"function loadGuestModule(specifier: string) {",
			"  const module = GUEST_MODULES[specifier];",
			"",
			"  if (typeof module === \"string\") {",
			"    return { source: new ModuleSource(module, specifier) };",
			"  }",
			"",
			"  if (module && typeof module === \"object\") {",
			"    if (\"text\" in module) {",
			"      return { source: createValueModule(module.text) };",
			"    }",
			"",
			"    if (\"json\" in module) {",
			"      return { source: createValueModule(module.json) };",
			"    }",
			"  }",
			"",
			"  throw new TypeError(`Guest module not found: ${specifier}`);",
			"}",
			"",
			"function createGuestCompartment() {",
			"  const SandboxHeaders = class SandboxHeaders extends Headers {};",
			"  const SandboxRequest = class SandboxRequest extends Request {};",
			"  const SandboxResponse = class SandboxResponse extends Response {};",
			"  const SandboxURL = class SandboxURL extends URL {};",
			"  const SandboxURLSearchParams = class SandboxURLSearchParams extends URLSearchParams {};",
			"",
			"  const compartment = new Compartment({",
			"    globals: {",
			"      console: createConsole(),",
			"      Headers: SandboxHeaders,",
			"      Request: SandboxRequest,",
			"      Response: SandboxResponse,",
			"      URL: SandboxURL,",
			"      URLSearchParams: SandboxURLSearchParams,",
			"    },",
			"    resolveHook: (specifier: string, referrer: string) =>",
			"      resolveGuestSpecifier(specifier, referrer),",
			"    importHook: async (specifier: string) => loadGuestModule(specifier),",
			"    __options__: true,",
			"  });",
			"",
			"  Object.freeze(compartment.globalThis);",
			"",
			"  return { compartment, SandboxRequest, SandboxResponse };",
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
			"function withSandboxHeaders(response: Response, requestNumber: number): Response {",
			"  const headers = new Headers(response.headers);",
			"  headers.set(\"x-sandbox-isolate-id\", getIsolateId());",
			"  headers.set(\"x-sandbox-execution-id\", String(requestNumber));",
			"  return new Response(response.body, {",
			"    status: response.status,",
			"    statusText: response.statusText,",
			"    headers,",
			"  });",
			"}",
			"",
			"export default {",
			"  async fetch(request: Request) {",
			"    const requestNumber = ++executionCount;",
			"",
			"    try {",
			"      const { compartment, SandboxRequest, SandboxResponse } = createGuestCompartment();",
			"      const guestModule = await compartment.import(GUEST_MAIN_MODULE);",
			"      const response = await getHandler(guestModule).fetch(new SandboxRequest(request));",
			"",
			"      if (!(response instanceof SandboxResponse) && !(response instanceof Response)) {",
			"        throw new TypeError(\"Guest fetch() must return a Response.\");",
			"      }",
			"",
			"      return withSandboxHeaders(response, requestNumber);",
			"    } catch (error) {",
			"      const message = error instanceof Error ? error.message : String(error);",
			"      return withSandboxHeaders(Response.json({ error: message }, { status: 500 }), requestNumber);",
			"    }",
			"  },",
			"};",
		].join("\n"),
	};
}

function buildInlineBootstrapFiles(guestModuleSource: string): SandboxFiles {
	return {
		"package.json": JSON.stringify(
			{
				private: true,
				dependencies: {
					ses: SES_VERSION,
				},
			},
			null,
			2,
		),
		[BOOTSTRAP_PATH]: [
			'import "ses";',
			"",
			"lockdown();",
			"Object.freeze(globalThis);",
			"",
			"let isolateId: string | undefined;",
			"let executionCount = 0;",
			"",
			guestModuleSource,
			"",
			"function getIsolateId(): string {",
			"  isolateId ??= crypto.randomUUID();",
			"  return isolateId;",
			"}",
			"",
			"function createConsole() {",
			"  return harden({",
			"    log: (...args: unknown[]) => console.log(...args),",
			"    info: (...args: unknown[]) => console.info(...args),",
			"    warn: (...args: unknown[]) => console.warn(...args),",
			"    error: (...args: unknown[]) => console.error(...args),",
			"    debug: (...args: unknown[]) => console.debug(...args),",
			"  });",
			"}",
			"",
			"function createGuestCompartment() {",
			"  const SandboxHeaders = class SandboxHeaders extends Headers {};",
			"  const SandboxRequest = class SandboxRequest extends Request {};",
			"  const SandboxResponse = class SandboxResponse extends Response {};",
			"  const SandboxURL = class SandboxURL extends URL {};",
			"  const SandboxURLSearchParams = class SandboxURLSearchParams extends URLSearchParams {};",
			"",
			"  const compartment = new Compartment({",
			"    globals: {",
			"      console: createConsole(),",
			"      Headers: SandboxHeaders,",
			"      Request: SandboxRequest,",
			"      Response: SandboxResponse,",
			"      URL: SandboxURL,",
			"      URLSearchParams: SandboxURLSearchParams,",
			"    },",
			"    modules: {",
			"      guest: { source: guestModuleSource },",
			"    },",
			"    __options__: true,",
			"  });",
			"",
			"  Object.freeze(compartment.globalThis);",
			"",
			"  return { compartment, SandboxRequest, SandboxResponse };",
			"}",
			"",
			"function describeValue(value: unknown): string {",
			"  if (value === null) {",
			"    return \"null\";",
			"  }",
			"",
			"  if (value === undefined) {",
			"    return \"undefined\";",
			"  }",
			"",
			"  if (typeof value !== \"object\") {",
			"    return typeof value;",
			"  }",
			"",
			"  return `object keys=[${Object.keys(value).join(\", \")}]`;",
			"}",
			"",
			"function getHandler(candidate: any) {",
			"  let current = candidate;",
			"",
			"  for (let depth = 0; depth < 3; depth++) {",
			"    if (current && typeof current.fetch === \"function\") {",
			"      return current;",
			"    }",
			"",
			"    if (!current || typeof current !== \"object\" || !(\"default\" in current)) {",
			"      break;",
			"    }",
			"",
			"    current = current.default;",
			"  }",
			"",
			"  throw new TypeError(`Guest code must evaluate to a handler with a fetch() method. Received ${describeValue(candidate)}.`);",
			"}",
			"",
			"function withSandboxHeaders(response: Response, requestNumber: number): Response {",
			"  const headers = new Headers(response.headers);",
			"  headers.set(\"x-sandbox-isolate-id\", getIsolateId());",
			"  headers.set(\"x-sandbox-execution-id\", String(requestNumber));",
			"  return new Response(response.body, {",
			"    status: response.status,",
			"    statusText: response.statusText,",
			"    headers,",
			"  });",
			"}",
			"",
			"export default {",
			"  async fetch(request: Request) {",
			"    const requestNumber = ++executionCount;",
			"",
			"    try {",
			"      const { compartment, SandboxRequest, SandboxResponse } = createGuestCompartment();",
			"      const importResult = await compartment.import(\"guest\");",
			"      const handler = getHandler(importResult.namespace);",
			"      const response = await handler.fetch(new SandboxRequest(request));",
			"",
			"      if (!(response instanceof SandboxResponse) && !(response instanceof Response)) {",
			"        throw new TypeError(\"Guest fetch() must return a Response.\");",
			"      }",
			"",
			"      return withSandboxHeaders(response, requestNumber);",
			"    } catch (error) {",
			"      const message = error instanceof Error ? error.message : String(error);",
			"      return withSandboxHeaders(Response.json({ error: message }, { status: 500 }), requestNumber);",
			"    }",
			"  },",
			"};",
		].join("\n"),
	};
}

function buildInlineGuestModuleSource(moduleSource: string): string {
	if (/\bimport\s*(?:[\{\w*]|\()/m.test(moduleSource)) {
		throw new TypeError("/run currently supports a single-file worker without imports.");
	}

	const defaultExportMatches = moduleSource.match(/\bexport\s+default\b/g) ?? [];
	if (defaultExportMatches.length !== 1) {
		throw new TypeError("/run requires exactly one export default.");
	}

	if (/\bexport\s+(?!default\b)/m.test(moduleSource)) {
		throw new TypeError("/run only supports default exports right now.");
	}

	const program = moduleSource.replace(
		/\bexport\s+default\b/,
		"const __sandboxDefaultExport =",
	);

	return [
		"const guestModuleSource = {",
		"  imports: [],",
		'  exports: ["default"],',
		"  execute(exportsTarget) {",
		indentCode(program, 4),
		"    exportsTarget.default = __sandboxDefaultExport;",
		"  },",
		"};",
	].join("\n");
}

function indentCode(source: string, spaces: number): string {
	const prefix = " ".repeat(spaces);
	return source
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
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
class SandboxPayloadError extends TypeError {}
