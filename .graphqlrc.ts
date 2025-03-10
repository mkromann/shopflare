import { shopifyApiProject, ApiType } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";
import fs from "node:fs"; // eslint-disable-line import-x/no-nodejs-modules

import { apiVersion } from "./app/shopify.server";

function getConfig() {
	const config: IGraphQLConfig = {
		projects: {
			default: shopifyApiProject({
				apiType: ApiType.Admin,
				apiVersion,
				documents: ["./app/**/*[!test].{ts,tsx}"],
				outputDir: "./app/types",
			}),
		},
	};

	let extensions: string[] = [];
	try {
		extensions = fs.readdirSync("./extensions");
	} catch {
		// ignore if no extensions
	}

	for (const entry of extensions) {
		const extensionPath = `./extensions/${entry}`;
		const schema = `${extensionPath}/schema.graphql`;
		if (!fs.existsSync(schema)) {
			continue;
		}
		config.projects[entry] = {
			schema,
			documents: [`${extensionPath}/**/*.graphql`],
		};
	}

	return config;
}

export default getConfig();
