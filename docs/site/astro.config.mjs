import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

export default defineConfig({
  integrations: [
    starlight({
      title: "OpenCode",
      description: "AI-powered development tool — tech stack & architecture guide",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/anomalyco/opencode",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [{ label: "Project Overview", slug: "01-project-overview" }],
        },
        {
          label: "Core Concepts",
          items: [
            { label: "Runtime & Toolchain", slug: "02-runtime-and-toolchain" },
            { label: "The Core Package", slug: "03-core-package" },
            { label: "LLM Provider System", slug: "04-llm-providers" },
            { label: "Agent & Session Architecture", slug: "05-agents-and-sessions" },
            { label: "Tool System", slug: "06-tool-system" },
            { label: "Database & Storage", slug: "07-database-and-storage" },
          ],
        },
        {
          label: "User Interfaces",
          items: [
            { label: "Terminal UI (TUI)", slug: "08-terminal-ui" },
            { label: "Web Application", slug: "09-web-application" },
            { label: "Desktop Application", slug: "10-desktop-application" },
          ],
        },
        {
          label: "Server & Communication",
          items: [
            { label: "HTTP Server & API", slug: "11-http-server-and-api" },
            { label: "Event Bus System", slug: "12-event-bus" },
          ],
        },
        {
          label: "Extensibility",
          items: [
            { label: "MCP & ACP Protocols", slug: "13-mcp-and-acp" },
            { label: "SDK & Plugin System", slug: "14-sdk-and-plugins" },
          ],
        },
        {
          label: "Infrastructure",
          items: [
            { label: "Build & Release Pipeline", slug: "15-build-and-release" },
            { label: "Cloud Infrastructure", slug: "16-cloud-infrastructure" },
            { label: "Testing Patterns", slug: "17-testing-patterns" },
          ],
        },
      ],
      editLink: {
        baseUrl: "https://github.com/anomalyco/opencode/edit/dev/docs/site/",
      },
      lastUpdated: true,
    }),
  ],
})
