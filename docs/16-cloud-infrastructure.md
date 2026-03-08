# Chapter 16: Cloud Infrastructure

> SST on Cloudflare, Workers, Durable Objects, R2 storage, PlanetScale, Stripe billing, and the console.

---

## Overview

OpenCode's cloud infrastructure powers the hosted product at **opencode.ai** — the console, authentication, API gateway, model proxy, billing, and documentation site. Everything is deployed to **Cloudflare** using **[SST](https://sst.dev)** (v3.18.10), an infrastructure-as-code framework that uses Pulumi under the hood.

The infrastructure is defined in TypeScript, lives alongside the application code, and deploys with a single command:

```
bun sst deploy --stage production
```

---

## SST: Infrastructure as Code

### What Is SST?

SST is a framework for building full-stack applications on cloud providers. It provides:

1. **TypeScript-native infrastructure** — Define cloud resources in the same language as your application
2. **Live development** — `sst dev` connects your local code to real cloud resources
3. **Multi-provider** — Supports AWS, Cloudflare, and other providers via Pulumi
4. **Resource linking** — Automatically injects connection strings, secrets, and URLs into your functions

### Entry Point

The infrastructure is configured in `sst.config.ts` at the repo root:

```
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "opencode",
      home: "cloudflare",          // Primary cloud provider
      removal: input.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input.stage),
      providers: {
        cloudflare: true,
        stripe: true,              // Billing
        planetscale: true,         // MySQL database
      },
    }
  },
  async run() {
    await import("./infra/app")
    await import("./infra/console")
    await import("./infra/enterprise")
  },
})
```

Key configuration:

- **`home: "cloudflare"`** — All resources deploy to Cloudflare by default
- **`removal: "retain"`** — Production resources are never accidentally deleted
- **`protect: ["production"]`** — Extra protection for the production stage
- **Three providers** — Cloudflare (hosting), Stripe (billing), PlanetScale (database)

### Stage-Based Deployment

SST uses **stages** to manage environments:

| Stage        | Domain                     | Purpose                            |
| ------------ | -------------------------- | ---------------------------------- |
| `production` | `opencode.ai` / `opncd.ai` | Live product                       |
| `dev`        | `dev.opencode.ai`          | Development environment            |
| `{name}`     | `{name}.dev.opencode.ai`   | Per-developer preview environments |

The stage determines domain routing, database branches, secret values, and resource protection levels.

---

## Infrastructure Organization

The `infra/` directory contains four files:

```
infra/
├── app.ts          # Core product infrastructure
├── console.ts      # Console, auth, billing, gateway
├── enterprise.ts   # Enterprise/teams features
├── secret.ts       # Shared secrets
└── stage.ts        # Domain routing per stage
```

### Domain Routing (`infra/stage.ts`)

```
Production:     opencode.ai, opncd.ai
Dev:            dev.opencode.ai, dev.opncd.ai
Per-stage:      {stage}.dev.opencode.ai
```

The stage module exports domain helpers used by all other infrastructure files, ensuring consistent URL patterns across services.

---

## Core Product (`infra/app.ts`)

### R2 Storage Bucket

```
sst.cloudflare.Bucket("Bucket")
```

An R2 (S3-compatible) bucket for file storage — session shares, uploaded files, and other binary assets. R2 provides:

- S3-compatible API (works with AWS SDK)
- No egress fees (unlike S3)
- Global distribution via Cloudflare's network

### API Worker

```
sst.cloudflare.Worker("Api", {
  url: true,
  domain: `api.${domain}`,
  handler: "packages/function/src/api.ts",
  // ...
})
```

The API Worker is a Cloudflare Worker that handles:

| Endpoint        | Purpose                      |
| --------------- | ---------------------------- |
| GitHub webhooks | Process GitHub App events    |
| Discord bot     | Support bot integration      |
| Feishu bot      | Feishu/Lark integration      |
| Analytics       | Usage tracking and telemetry |
| Share links     | Serve shared session pages   |

Key features:

- **Durable Object (`SyncServer`)** — A stateful server for real-time synchronization between clients. Durable Objects maintain persistent WebSocket connections and in-memory state, surviving across requests.
- **Linked secrets** — GitHub App credentials, Discord tokens, Feishu tokens, admin secrets
- **Linked bucket** — R2 bucket for file storage

### Documentation Site

```
sst.cloudflare.x.Astro("Web", {
  path: "packages/web",
  domain: `docs.${domain}`,
})
```

The documentation site is built with **Astro** and deployed as a Cloudflare static site. Astro provides:

- Static HTML generation (zero JavaScript by default)
- MDX support for interactive documentation
- Framework-agnostic (can embed SolidJS components)

### Web Application

```
sst.cloudflare.StaticSite("WebApp", {
  path: "packages/app",
  build: {
    command: "bun run build",
    output: "dist",
  },
  domain: `app.${domain}`,
})
```

The SolidJS web application is deployed as a static site on Cloudflare's CDN. It connects to the user's local OpenCode server for the actual AI agent functionality.

### Secrets

The app module uses several secrets:

| Secret             | Purpose                      |
| ------------------ | ---------------------------- |
| `GITHUB_APP_ID`    | GitHub App identification    |
| `GITHUB_APP_KEY`   | GitHub App private key       |
| `ADMIN_SECRET`     | Admin API authentication     |
| `DISCORD_*`        | Discord bot credentials      |
| `FEISHU_*`         | Feishu/Lark bot credentials  |
| `EMAILOCTOPUS_KEY` | Email newsletter integration |

---

## Console & Billing (`infra/console.ts`)

The console module is the most complex piece of infrastructure — it handles user accounts, billing, authentication, and the model gateway.

### PlanetScale Database

```
// PlanetScale MySQL database
Database("opencode")
```

The console uses **PlanetScale** for its MySQL database, separate from the SQLite database used by the CLI. PlanetScale provides:

- **Branching** — Each stage gets its own database branch (branched from production)
- **Serverless** — No connection pooling needed, ideal for Cloudflare Workers
- **Schema management** — Drizzle ORM manages the console's schema separately

### Authentication Worker

```
sst.cloudflare.Worker("AuthApi", {
  domain: `auth.${domain}`,
  handler: "packages/identity/src/auth.ts",
})
```

Authentication is handled by **@openauthjs/openauth** deployed as a Cloudflare Worker:

| Auth Method  | Provider | Purpose                 |
| ------------ | -------- | ----------------------- |
| GitHub OAuth | GitHub   | Primary developer login |
| Google OAuth | Google   | Alternative login       |

The auth worker:

1. Handles OAuth redirect flows
2. Issues and validates JWTs
3. Stores sessions in **Cloudflare KV** (`AuthStorage`)
4. Provides token refresh endpoints

### Console Application

```
sst.cloudflare.x.SolidStart("Console", {
  path: "packages/console/app",
  domain: domain,
})
```

The console is a **SolidStart** application (SolidJS's meta-framework, similar to Next.js for React). It provides:

- **Server-side rendering** — Fast initial page loads
- **Account management** — User profiles, API keys, team management
- **Billing dashboard** — Subscription management, usage monitoring
- **Model gateway config** — Configure which models are available

Linked resources:

| Resource       | Purpose                            |
| -------------- | ---------------------------------- |
| Database       | PlanetScale MySQL for console data |
| AuthApi        | Authentication service             |
| Stripe secrets | Billing integration                |
| Bucket         | R2 storage for user files          |
| LogProcessor   | Observability pipeline             |

### Stripe Billing

The console integrates with **Stripe** for subscription billing:

#### Products

| Product        | Price      | Description       |
| -------------- | ---------- | ----------------- |
| OpenCode Go    | $10/month  | Basic tier        |
| OpenCode Black | $20/month  | Standard tier     |
| OpenCode Black | $100/month | Professional tier |
| OpenCode Black | $200/month | Enterprise tier   |

#### Webhook Events

The Stripe webhook endpoint listens for 25+ event types:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_succeeded
invoice.payment_failed
payment_method.attached
... and more
```

These events trigger updates to the user's subscription status, usage limits, and account state.

### Model Gateway

The console manages a **model gateway** — a proxy that routes AI model requests through OpenCode's infrastructure:

```
ZEN_MODELS1 through ZEN_MODELS30 (sst.Secret)
```

These 30 secret slots store API keys for various model providers. The gateway:

1. Authenticates the user via their OpenCode account
2. Routes the request to the appropriate model provider
3. Deducts usage from the user's subscription
4. Handles rate limiting via **Cloudflare KV** (`GatewayKv`)

This allows users on paid plans to access models without managing their own API keys.

### Log Processing

```
sst.cloudflare.Worker("LogProcessor", {
  // Tail consumer configuration
})
```

The log processor is a **Cloudflare Tail Consumer** — it receives logs from all other Workers and forwards them to **Honeycomb** for observability:

```
Worker logs → Tail Consumer → Honeycomb
```

This provides distributed tracing, error tracking, and performance monitoring across all Cloudflare Workers.

---

## Enterprise (`infra/enterprise.ts`)

### Enterprise Storage

```
sst.cloudflare.Bucket("EnterpriseStorage")
```

A dedicated R2 bucket for enterprise data — team configurations, shared sessions, and organization-level assets.

### Teams Application

```
sst.cloudflare.x.SolidStart("Teams", {
  path: "packages/enterprise",
  domain: `opncd.ai`,  // Short domain for teams
})
```

The teams application runs on the short domain `opncd.ai` and provides:

- Team creation and management
- Member invitation and role assignment
- Shared configurations and model access
- Organization-level billing

---

## Shared Secrets (`infra/secret.ts`)

```
R2AccessKey — R2 storage access key
R2SecretKey — R2 storage secret key
```

These secrets are shared across modules that need direct R2 API access (not through Cloudflare bindings).

---

## Cloudflare Resources Summary

Here's every Cloudflare resource type used:

| Resource Type      | Instance(s)                         | Purpose                        |
| ------------------ | ----------------------------------- | ------------------------------ |
| **Worker**         | Api, AuthApi, LogProcessor, Gateway | Serverless compute             |
| **Durable Object** | SyncServer (in Api Worker)          | Stateful real-time sync        |
| **KV Namespace**   | AuthStorage, GatewayKv              | Key-value storage              |
| **R2 Bucket**      | Bucket, EnterpriseStorage           | Object storage (S3-compatible) |
| **StaticSite**     | WebApp                              | CDN-hosted SolidJS app         |
| **Astro Site**     | Web (docs)                          | CDN-hosted documentation       |
| **SolidStart**     | Console, Teams                      | SSR applications               |

### Why Cloudflare?

OpenCode chose Cloudflare over AWS/GCP/Azure for the cloud layer because:

1. **Edge-first** — Workers run in 300+ data centers, providing low latency globally
2. **No cold starts** — Workers start in under 5ms (vs. 100ms+ for Lambda)
3. **R2 is S3-compatible with no egress fees** — Critical for serving shared sessions
4. **Durable Objects** — Unique to Cloudflare, perfect for the real-time sync server
5. **KV** — Global key-value store with sub-millisecond reads
6. **Integrated CDN** — Static sites are automatically edge-cached
7. **Simple pricing** — Workers are billed per request, not per compute-second

---

## Deployment Pipeline

### CI/CD Workflow

The `deploy.yml` GitHub Actions workflow handles deployment:

```
Push to branch
      │
      ├── dev branch    → deploy to "dev" stage
      │
      └── production branch → deploy to "production" stage
```

The deployment command:

```bash
bun sst deploy --stage={branch}
```

SST handles:

1. **Diffing** — Compares current state with desired state
2. **Provisioning** — Creates/updates/deletes Cloudflare resources
3. **Building** — Builds Workers, SolidStart apps, and static sites
4. **Deploying** — Uploads to Cloudflare
5. **DNS** — Configures domain routing

### Preview Environments

Any developer can create a preview environment:

```bash
bun sst deploy --stage=my-feature
```

This creates a complete copy of the infrastructure at `my-feature.dev.opencode.ai` with:

- Its own Workers
- Its own database branch (from production data)
- Its own static sites
- Its own auth service

When the preview is no longer needed:

```bash
bun sst remove --stage=my-feature
```

SST tears down all resources (because `removal: "remove"` for non-production stages).

---

## Architecture Diagram

```
Internet
    │
    ├── opencode.ai ──────────► Console (SolidStart Worker)
    │                               ├── PlanetScale MySQL
    │                               ├── Stripe Billing
    │                               └── Auth (OpenAuth Worker)
    │                                       └── KV (sessions)
    │
    ├── app.opencode.ai ──────► WebApp (Static Site / CDN)
    │
    ├── docs.opencode.ai ─────► Docs (Astro / CDN)
    │
    ├── api.opencode.ai ──────► API Worker
    │                               ├── R2 Bucket (storage)
    │                               ├── Durable Object (sync)
    │                               └── GitHub/Discord/Feishu
    │
    ├── auth.opencode.ai ─────► Auth Worker
    │                               └── KV (auth sessions)
    │
    └── opncd.ai ─────────────► Teams (SolidStart Worker)
                                    └── R2 (enterprise storage)

Internal:
    LogProcessor (Tail Consumer) ──► Honeycomb (observability)
    Gateway Worker ──► Model Providers (via ZEN_MODELS secrets)
                   └── KV (rate limiting)
```

---

## Local Development vs Cloud

It's important to understand what runs locally vs. in the cloud:

| Component          | Local (CLI)            | Cloud (opencode.ai)         |
| ------------------ | ---------------------- | --------------------------- |
| AI Agent Engine    | ✅ Bun process         | ❌ (runs on user's machine) |
| SQLite Database    | ✅ Local file          | ❌                          |
| HTTP Server (Hono) | ✅ localhost:4096      | ❌                          |
| LLM API calls      | ✅ Direct to providers | ✅ Via gateway (paid plans) |
| Console (billing)  | ❌                     | ✅ Cloudflare Worker        |
| Authentication     | ❌ (optional)          | ✅ OpenAuth Worker          |
| Session sharing    | Uploads to cloud       | ✅ R2 + API Worker          |
| Real-time sync     | ❌ (single user)       | ✅ Durable Objects          |
| Documentation      | ❌                     | ✅ Astro on CDN             |

The core AI functionality runs entirely locally — the cloud infrastructure is for the hosted product (accounts, billing, sharing, teams).

---

## Key Takeaways

1. **SST provides TypeScript-native infrastructure** — Cloud resources are defined in the same language as the application, with full type safety and IDE support.

2. **Cloudflare is the sole cloud provider** — Workers, KV, R2, Durable Objects, and static sites handle all cloud needs. No AWS Lambda, no S3, no DynamoDB.

3. **Stage-based environments** — Every branch can have its own complete environment, with automatic cleanup for non-production stages.

4. **The core runs locally** — The AI agent, database, and tools all run on the user's machine. The cloud handles accounts, billing, sharing, and teams.

5. **Stripe handles billing** — Four subscription tiers with webhook-driven state management.

6. **PlanetScale for the console** — MySQL with branching for the cloud console, separate from the local SQLite database.

7. **Observability via Honeycomb** — All Worker logs flow through a tail consumer to Honeycomb for monitoring and debugging.

---

**Next:** [Chapter 17: Testing Patterns →](./17-testing-patterns.md) — Bun's native test runner, isolation patterns, and the no-mocks philosophy.

**Previous:** [Chapter 15: Build & Release Pipeline](./15-build-and-release.md)
