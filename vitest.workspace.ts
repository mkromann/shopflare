import {
	defineWorkersConfig,
	defineWorkersProject,
} from "@cloudflare/vitest-pool-workers/config";
import { defineConfig, defineWorkspace, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default defineWorkspace([
	defineConfig((config) =>
		mergeConfig(
			viteConfig(config),
			defineConfig({
				test: {
					environment: "happy-dom",
					include: ["app/**/*.test.tsx"],
					name: "app/client",
				},
			}),
		),
	),
	defineConfig((config) =>
		mergeConfig(
			viteConfig(config),
			defineConfig({
				test: {
					environment: "node",
					include: ["app/**/*.server.test.ts"],
					name: "app/server",
				},
			}),
		),
	),
	defineWorkersConfig((config) =>
		mergeConfig(
			viteConfig(config),
			defineWorkersProject({
				test: {
					include: ["server.test.ts"],
					name: "server",
					poolOptions: {
						workers: {
							main: "./server.ts",
							miniflare: {
								compatibilityFlags: ["service_binding_extra_handlers"],
								kvNamespaces: ["SESSION_STORAGE"],
							},
							singleWorker: true,
							wrangler: { configPath: "./wrangler.json" },
						},
					},
				},
			}),
		),
	),
]);
