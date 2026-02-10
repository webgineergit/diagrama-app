import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
}

// Decode URL-safe base64
function decodeBase64(encoded: string): string {
  // Convert URL-safe base64 back to standard base64
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if needed
  while (base64.length % 4) {
    base64 += "=";
  }

  // Decode base64 to string
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Encode to URL-safe base64
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  // Make URL-safe
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Clean mermaid code - strip markdown fences and comment headers
function cleanMermaidCode(code: string): string {
  let lines = code.trim().split("\n");

  // Remove leading lines that are comments/headers (start with #) or empty
  while (lines.length > 0) {
    const line = lines[0].trim();
    if (line === "" || line.startsWith("#")) {
      lines.shift();
    } else {
      break;
    }
  }

  // Remove ```mermaid opening fence
  if (lines.length > 0 && lines[0].trim().match(/^```\s*mermaid\s*$/i)) {
    lines.shift();
  }

  // Remove trailing ``` closing fence
  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine === "```" || lastLine === "") {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join("\n").trim();
}

// HTML template for rendering Mermaid
function getMermaidHtml(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body { margin: 0; padding: 20px; background: white; }
    #container { display: inline-block; }
  </style>
</head>
<body>
  <div id="container">
    <pre class="mermaid">${escapeHtml(code)}</pre>
  </div>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve static files for root
    if (path === "/" || path === "/index.html") {
      return serveStaticHtml();
    }

    // CORS headers for API responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle OPTIONS preflight for /api/encode
    if (path === "/api/encode" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // API endpoint to encode mermaid code
    if (path === "/api/encode" && request.method === "POST") {
      const body = await request.json<{ code: string }>();
      const cleanCode = cleanMermaidCode(body.code);
      const encoded = encodeBase64(cleanCode);
      const baseUrl = url.origin;
      return Response.json(
        {
          encoded,
          cleanedCode: cleanCode,
          svgUrl: `${baseUrl}/mermaid/svg/${encoded}`,
          pngUrl: `${baseUrl}/mermaid/png/${encoded}`,
        },
        { headers: corsHeaders }
      );
    }

    // Mermaid rendering endpoint: /mermaid/{format}/{encoded}
    const mermaidMatch = path.match(/^\/mermaid\/(svg|png)\/(.+)$/);
    if (mermaidMatch) {
      const format = mermaidMatch[1] as "svg" | "png";
      const encoded = mermaidMatch[2];

      try {
        // Check cache first
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }

        // Decode the mermaid code and clean it
        const rawCode = decodeBase64(encoded);
        const mermaidCode = cleanMermaidCode(rawCode);

        // Render using Puppeteer
        const imageData = await renderMermaid(env, mermaidCode, format);

        const contentType = format === "svg" ? "image/svg+xml" : "image/png";
        const response = new Response(imageData, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
          },
        });

        // Cache the response
        await cache.put(cacheKey, response.clone());

        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return new Response(`Error rendering diagram: ${message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function renderMermaid(
  env: Env,
  code: string,
  format: "svg" | "png"
): Promise<ArrayBuffer | string> {
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();

  try {
    // Set viewport
    await page.setViewport({ width: 1200, height: 800 });

    // Load the HTML with mermaid
    const html = getMermaidHtml(code);
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Wait for mermaid to render
    await page.waitForSelector("svg", { timeout: 10000 });

    // Get the rendered SVG
    const container = await page.$("#container");
    if (!container) {
      throw new Error("Container not found");
    }

    if (format === "svg") {
      // Extract SVG content
      let svgContent = await page.evaluate(() => {
        const svg = document.querySelector("#container svg");
        return svg ? svg.outerHTML : null;
      });
      if (!svgContent) {
        throw new Error("SVG not found");
      }
      // Ensure XML compliance: convert HTML-style void elements to self-closing
      // SVG is XML and requires properly closed tags
      svgContent = svgContent.replace(/<br\s*>/gi, "<br/>");
      return svgContent;
    } else {
      // Take PNG screenshot
      const screenshot = await container.screenshot({ type: "png" });
      return screenshot;
    }
  } finally {
    await browser.close();
  }
}

function serveStaticHtml(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mermaid Renderer</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 800px) {
      .container { grid-template-columns: 1fr; }
    }
    .panel {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .panel h2 { margin-top: 0; color: #444; }
    textarea {
      width: 100%;
      height: 300px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 14px;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      resize: vertical;
    }
    button {
      background: #0052CC;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 12px;
    }
    button:hover { background: #0041a3; }
    .preview {
      min-height: 200px;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 20px;
      background: white;
      overflow: auto;
    }
    .urls {
      margin-top: 16px;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .url-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .url-row:last-child { margin-bottom: 0; }
    .url-label {
      font-weight: 600;
      min-width: 50px;
    }
    .url-input {
      flex: 1;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }
    .copy-btn {
      padding: 8px 12px;
      margin-top: 0;
      font-size: 14px;
    }
    .error { color: #d32f2f; }
    .mermaid { display: flex; justify-content: center; }
  </style>
</head>
<body>
  <h1>Mermaid Diagram Renderer</h1>
  <p class="subtitle">Generate permanent URLs for your Mermaid diagrams</p>

  <div class="container">
    <div class="panel">
      <h2>Mermaid Code</h2>
      <textarea id="code" placeholder="Enter your Mermaid diagram code here...">flowchart TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    D --> B
    C --> E[End]</textarea>
      <button onclick="generate()">Generate URLs</button>
    </div>

    <div class="panel">
      <h2>Preview</h2>
      <div class="preview">
        <div id="preview" class="mermaid"></div>
      </div>
      <div id="urls" class="urls" style="display: none;">
        <div class="url-row">
          <span class="url-label">SVG:</span>
          <input type="text" id="svgUrl" class="url-input" readonly>
          <button class="copy-btn" onclick="copyUrl('svgUrl')">Copy</button>
        </div>
        <div class="url-row">
          <span class="url-label">PNG:</span>
          <input type="text" id="pngUrl" class="url-input" readonly>
          <button class="copy-btn" onclick="copyUrl('pngUrl')">Copy</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    mermaid.initialize({ startOnLoad: false, theme: 'default' });

    // Clean mermaid code - strip markdown fences and comment headers
    function cleanMermaidCode(code) {
      let lines = code.trim().split('\\n');

      // Remove leading lines that are comments/headers (start with #) or empty
      while (lines.length > 0) {
        const line = lines[0].trim();
        if (line === '' || line.startsWith('#')) {
          lines.shift();
        } else {
          break;
        }
      }

      // Remove \`\`\`mermaid opening fence
      if (lines.length > 0 && /^\`\`\`\\s*mermaid\\s*$/i.test(lines[0].trim())) {
        lines.shift();
      }

      // Remove trailing \`\`\` closing fence
      while (lines.length > 0) {
        const lastLine = lines[lines.length - 1].trim();
        if (lastLine === '\`\`\`' || lastLine === '') {
          lines.pop();
        } else {
          break;
        }
      }

      return lines.join('\\n').trim();
    }

    async function generate() {
      const rawCode = document.getElementById('code').value.trim();
      if (!rawCode) return;

      // Clean the code before rendering
      const code = cleanMermaidCode(rawCode);

      // Update preview
      const previewEl = document.getElementById('preview');
      previewEl.innerHTML = code;
      previewEl.removeAttribute('data-processed');

      try {
        await mermaid.run({ nodes: [previewEl] });
      } catch (e) {
        previewEl.innerHTML = '<p class="error">Error: ' + e.message + '</p>';
        return;
      }

      // Generate URLs
      try {
        const response = await fetch('/api/encode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await response.json();

        document.getElementById('svgUrl').value = data.svgUrl;
        document.getElementById('pngUrl').value = data.pngUrl;
        document.getElementById('urls').style.display = 'block';
      } catch (e) {
        console.error('Failed to generate URLs:', e);
      }
    }

    function copyUrl(inputId) {
      const input = document.getElementById(inputId);
      input.select();
      document.execCommand('copy');

      const btn = input.nextElementSibling;
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = originalText, 1500);
    }

    // Initial render
    generate();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
