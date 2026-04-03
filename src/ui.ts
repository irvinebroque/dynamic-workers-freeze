export function renderHomePage(
	code = getStarterCode(),
	output = "Press Run to execute the code.",
): string {
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
