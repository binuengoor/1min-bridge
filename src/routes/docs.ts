// ============================================================================
// 1min-bridge — OpenAPI Documentation Routes
// GET /openapi.json → JSON spec
// GET /docs → Swagger UI
// ============================================================================

import { Hono } from "hono";
import { openApiSpec } from "../openapi-spec.js";
import type { Env } from "../types.js";

const app = new Hono<Env>();

// Serve the OpenAPI spec as JSON
app.get("/openapi.json", (c) => {
  return c.json(openApiSpec);
});

// Serve Swagger UI HTML
app.get("/docs", (c) => {
  // Check if client wants JSON (Accept header)
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("application/json")) {
    return c.json(openApiSpec);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>1min-bridge API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: 'BaseLayout',
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 2,
      docExpansion: 'list'
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

export default app;
