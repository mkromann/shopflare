import "@shopify/shopify-api/adapters/cf-worker";
import {
	type AddHandlersParams,
	ApiVersion,
	BillingInterval,
	BillingReplacementBehavior,
	DeliveryMethod,
	HttpResponseError,
	InvalidJwtError,
	LogSeverity,
	shopifyApi,
	Session,
	type SessionParams,
} from "@shopify/shopify-api";
import { restResources } from "@shopify/shopify-api/rest/admin/2023-01";

import { Env } from "@/functions/types";
import routes from "@/public/_routes.json";

export const config = {
	authPath: "/api/auth",
	authCallbackPath: "/api/auth/callback",
	billing: {
		Basic: {
			amount: 10.0,
			currencyCode: "USD",
			interval: BillingInterval.Annual,
			replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
			trialDays: 30,
			usageTerms: "...",
		},
	},
	billingPlansPath: "/settings",
	exitIframePath: "/exitiframe",
	isEmbeddedApp: true,
	isOnline: true,
	isTest: true,
	logger: {
		level: LogSeverity.Info,
	},
	settings: {
		setting1: "",
		setting2: "",
	},
	storefrontAccessTokenTitle: "shopflare",
	webhooksPath: "/api/webhooks",
};

type Context = EventContext<Env, any, Record<string, unknown>>;

export async function addSessionToStorage(context: Context, session: Session) {
	await context.env.SHOPFLARE_KV.put(
		getSessionKey(session.id),
		JSON.stringify(session.toObject())
	);
}

export async function checkBillingPlan(context: Context) {
	const plans = Object(shopify(context).config.billing).keys();
	if (plans.length > 0) {
		const options = await getBillingPlanConfig(context);
		const hasPayment = await shopify(context).billing.check({
			...options,
			plans,
		});
		if (!hasPayment) {
			let confirmationUrl = config.billingPlansPath;
			if (plans.length === 1) {
				confirmationUrl = await saveBillingPlan(context, plans[0]);
			}
			return redirect(config.billingPlansPath);
		}
	}

	await context.next();
}

type CurrentAppInstallation = {
	data: {
		currentAppInstallation: {
			id: string;
		};
	};
};

export async function createAppDataMetafield(
	context: Context,
	session: Session
) {
	const client = new (shopify(context).clients.Graphql)({ session });

	const appId = await client
		.query<CurrentAppInstallation>({
			data: {
				query: /* graphql */ `query {
				currentAppInstallation {
					id
				}
			}`,
			},
		})
		.then((res) => res.body?.data?.currentAppInstallation?.id);

	await client.query({
		data: {
			query: /* graphql */ `mutation CreateAppDataMetafield($metafieldsSetInput: [MetafieldsSetInput!]!) {
				metafieldsSet(metafields: $metafieldsSetInput) {
					metafields {
						id
						namespace
						key
					}
					userErrors {
						field
						message
					}
				}
			}`,
			variables: {
				metafieldsSetInput: [
					{
						key: "settings",
						namespace: "shopflare",
						ownerId: appId,
						type: "json",
						value: JSON.stringify(config.settings),
					},
				],
			},
		},
	});
}

async function embedAppIntoShopify(
	context: Context,
	shop: string
): Promise<Response> {
	let embeddedUrl: string;
	try {
		embeddedUrl = await shopify(context).auth.getEmbeddedAppUrl({
			rawRequest: context.request,
		});
	} catch (error) {
		shopify(context).logger.error(
			`ensureInstalledOnShop did not receive a host query argument`,
			{ shop }
		);

		return new Response("No host provided", { status: 400 });
	}

	shopify(context).logger.debug(
		`Request is not embedded but app is. Redirecting to ${embeddedUrl} to embed the app`,
		{ shop }
	);

	const { pathname } = new URL(context.request.url);
	return redirect(embeddedUrl + pathname);
}

export async function ensureInstalledOnShop(context: Context) {
	const response = await context.next();

	const { pathname, searchParams } = new URL(context.request.url);
	const isApiPath = pathname.startsWith("/api");
	const excludedPaths = routes.exclude.map((v) => v.replace(/[\/\*]*$/, ""));
	const isExcludedPath = excludedPaths.some((v) => pathname.startsWith(v));

	const isWebSocket = context.request.headers.get("Upgrade") === "websocket";

	if (isApiPath || isExcludedPath || isWebSocket) {
		return response;
	}

	shopify(context).logger.info("Running ensureInstalledOnShop");

	if (!config.isEmbeddedApp) {
		shopify(context).logger.warning(
			"ensureInstalledOnShop() should only be used in embedded apps; calling validateAuthenticatedSession() instead"
		);

		return validateAuthenticatedSession(context);
	}

	let shop = searchParams.get("shop");
	try {
		if (!shop) {
			throw new Error("No shop provided");
		}
		shop = shopify(context).utils.sanitizeShop(shop);
		if (!shop) {
			throw new Error("Invalid shop provided");
		}
	} catch (e: any) {
		shopify(context).logger.info(e.message, { shop });

		return redirect("/shop");
	}

	shopify(context).logger.debug("Checking if shop has installed the app", {
		shop,
	});

	const sessionId = shopify(context).session.getOfflineId(shop);
	const session = await getSessionFromStorage(context, sessionId);
	if (!session && context.request.url === config.exitIframePath) {
		shopify(context).logger.debug(
			"ensureInstalledOnShop() should only be used in embedded apps; calling validateAuthenticatedSession() instead"
		);

		return redirectToAuth(context);
	}

	if (config.isEmbeddedApp && searchParams.get("embedded") !== "1") {
		if (await sessionHasValidAccessToken(context, session)) {
			return embedAppIntoShopify(context, shop);
		}

		shopify(context).logger.info(
			"Found a session, but it is not valid. Redirecting to auth",
			{ shop }
		);

		return redirectToAuth(context);
	}

	if (config.isEmbeddedApp && shop) {
		response.headers.set(
			"Content-Security-Policy",
			`frame-ancestors https://${encodeURIComponent(
				shop
			)} https://admin.shopify.com;`
		);
	} else {
		response.headers.set("Content-Security-Policy", "frame-ancestors 'none';");
	}

	shopify(context).logger.info("App is installed and ready to load", {
		shop,
	});

	return response;
}

export async function getBillingPlanConfig(context: Context) {
	const session: any = await getSession(context);
	const options = {
		isTest: config.isTest,
		session,
	};
	return options;
}

export async function getSession(
	context: Context,
	isOnline: boolean = config.isOnline
) {
	const sessionId = await shopify(context).session.getCurrentId({
		isOnline,
		rawRequest: context.request,
	});
	if (!sessionId) {
		return new Response("No session id", { status: 401 });
	}

	const session: any = await getSessionFromStorage(context, sessionId);
	if (!session) {
		return new Response("No session found", { status: 401 });
	}

	return session;
}

function getSessionKey(id: string) {
	const key = `session:${id}`;
	return key;
}

export async function getSessionFromStorage(
	context: Context,
	sessionId: string
): Promise<Session | undefined> {
	const params = await context.env.SHOPFLARE_KV.get(getSessionKey(sessionId), {
		type: "json",
	});
	return params ? new Session(params as SessionParams) : undefined;
}

function redirect(
	url: string,
	status: number = 302,
	headers: Headers = [] as any
) {
	return new Response("", {
		headers: [...headers, ["Location", url]],
		status,
	});
}

export async function redirectToAuth(
	context: Context,
	isOnline: boolean = config.isOnline
) {
	const { searchParams } = new URL(context.request.url);

	const shop = shopify(context).utils.sanitizeShop(searchParams.get("shop")!)!;
	if (!shop) {
		return new Response("No shop provided", { status: 500 });
	}

	async function clientSideRedirect() {
		const host = shopify(context).utils.sanitizeHost(
			searchParams.get("host")!
		)!;
		if (!host) {
			return new Response("No host provided", { status: 500 });
		}

		const redirectUriParams = new URLSearchParams({ shop, host }).toString();
		const appHost = [
			shopify(context).config.hostScheme,
			shopify(context).config.hostName,
		].join("://");

		const queryParams = new URLSearchParams(searchParams);
		queryParams.set("shop", shop!);
		queryParams.set(
			"redirectUri",
			`${appHost}/${config.authPath}?${redirectUriParams}`
		);

		shopify(context).logger.debug(
			`Redirecting to auth while embedded, going to ${config.exitIframePath}`,
			{ shop }
		);

		return redirect(`${config.exitIframePath}?${queryParams.toString()}`);
	}
	if (searchParams.get("embedded") === "1") {
		return clientSideRedirect();
	}

	async function serverSideRedirect() {
		shopify(context).logger.debug(
			`Redirecting to auth at ${config.authPath}, with callback ${config.authCallbackPath}`,
			{ shop, isOnline }
		);

		return await shopify(context).auth.begin({
			callbackPath: config.authCallbackPath,
			shop,
			isOnline,
			rawRequest: context.request,
		});
	}
	return serverSideRedirect();
}

export async function registerWebhookHandlers(
	context: Context,
	session: Session
) {
	shopify(context).webhooks.addHandlers(webhooks);
	const response = await shopify(context).webhooks.register({
		session,
	});
	const success = Object.values(response).every((res: any) =>
		res.every((v: any) => v.success)
	);
	if (!success) {
		const error = "Registering registerWebhookHandlers() failed";
		shopify(context).logger.error(error, { shop: session.shop });
		throw new Error(error);
	}
}

export async function saveBillingPlan(context: Context, plan: string) {
	const options = await getBillingPlanConfig(context);
	const confirmationUrl = await shopify(context).billing.request({
		...options,
		plan,
	});
	return confirmationUrl;
}

async function sessionHasValidAccessToken(
	context: Context,
	session: Session | undefined
) {
	if (!session) {
		shopify(context).logger.debug("Request session not found");

		return false;
	}

	/* FIXME: bug in scopes when session.scope is string
	const scopes = shopify(context).config.scopes;
	const isActive = session.isActive(scopes);
	if (!isActive) {
		shopify(context).logger.debug("Request session is not active", {
			shop: session.shop,
		});

		return false;
	}
	*/

	try {
		const client = new (shopify(context).clients.Graphql)({
			session,
		});
		await client.query({
			data: /* graphql */ `{
				shop {
					name
				}
			}`,
		});

		shopify(context).logger.debug("Request session has a valid access token", {
			shop: session.shop,
		});

		return true;
	} catch (error: any) {
		shopify(context).logger.error(
			`Could not check if session was valid: ${error}`,
			{
				shop: session.shop,
			}
		);

		if (error instanceof HttpResponseError && error.response.code === 401) {
			return false;
		} else {
			throw error;
		}
	}
}

export function shopify(context: Context) {
	const envs = [
		"SHOPIFY_API_HOST",
		"SHOPIFY_API_KEY",
		"SHOPIFY_API_SECRET_KEY",
		"SHOPIFY_API_SCOPES",
	];
	const missing = envs.filter((env) => !(env in context.env));
	if (missing.length !== 0) {
		throw new Error(`Missing env vars [${envs.join(", ")}]`);
	}

	const [hostScheme, hostName]: any =
		context.env.SHOPIFY_API_HOST.split("://")!;

	return shopifyApi({
		apiKey: context.env.SHOPIFY_API_KEY!,
		apiSecretKey: context.env.SHOPIFY_API_SECRET_KEY!,
		apiVersion: ApiVersion.January23,
		billing: config.billing,
		hostName,
		hostScheme,
		isEmbeddedApp: config.isEmbeddedApp,
		logger: config.logger,
		scopes: context.env.SHOPIFY_API_SCOPES.split(",")!,
		restResources,
	});
}

export async function validateAuthenticatedSession(context: Context) {
	shopify(context).logger.info("Running validateAuthenticatedSession");

	const response = context.next();

	const { pathname } = new URL(context.request.url);
	if (pathname.startsWith("/api/auth")) {
		return response;
	}

	let sessionId: string | undefined;
	try {
		sessionId = await shopify(context).session.getCurrentId({
			isOnline: config.isOnline,
			rawRequest: context.request,
		});
	} catch (error: any) {
		shopify(context).logger.error(
			`Error when loading session from storage: ${error}`
		);

		switch (true) {
			case error instanceof InvalidJwtError:
				return new Response(error.message, { status: 401 });
			default:
				return new Response(error.message, { status: 500 });
		}
	}

	let session: Session | undefined;
	if (sessionId) {
		try {
			session = await getSessionFromStorage(context, sessionId!);
		} catch (error: any) {
			shopify(context).logger.error(
				`Error when loading session from storage: ${error}`
			);

			return new Response(error.message, { status: 500 });
		}
	}

	const { searchParams } = new URL(context.request.url);
	let shop = shopify(context).utils.sanitizeShop(searchParams.get("shop")!)!;
	if (session && shop && session?.shop !== shop) {
		shopify(context).logger.debug(
			"Found a session for a different shop in the request",
			{ currentShop: session.shop, requestShop: shop }
		);

		return redirectToAuth(context);
	}

	if (await sessionHasValidAccessToken(context, session)) {
		context.data = { session };
		return response;
	}

	const bearerPresent = context.request.headers
		.get("authorization")
		?.match(/Bearer (.*)/);
	if (bearerPresent && !shop) {
		if (session) {
			shop = session.shop;
		} else if (config.isEmbeddedApp) {
			const payload = await shopify(context).session.decodeSessionToken(
				bearerPresent?.[1]!
			);
			shop = payload.dest.replace("https://", "");
		}
	}

	const host = shopify(context).utils.sanitizeHost(searchParams.get("host")!)!;
	const redirectParams = new URLSearchParams({ host, shop: shop }).toString();
	const redirectUrl = `${config.authPath}?${redirectParams}`;
	if (bearerPresent) {
		return new Response("", {
			headers: {
				"Access-Control-Expose-Headers": [
					"X-Shopify-Api-Request-Failure-Reauthorize",
					"X-Shopify-Api-Request-Failure-Reauthorize-Url",
				].join(";"),
				"X-Shopify-API-Request-Failure-Reauthorize": "1",
				"X-Shopify-API-Request-Failure-Reauthorize-Url": redirectUrl,
			},
			status: 403,
		});
	}
	return redirect(redirectUrl, 302, context.request.headers);
}

const webhooks: AddHandlersParams = {
	CUSTOMERS_DATA_REQUEST: {
		deliveryMethod: DeliveryMethod.Http,
		callbackUrl: config.webhooksPath,
		callback: async (
			topic: string,
			shop: string,
			body: string,
			webhookId: string,
			apiVersion?: string
		) => {
			const payload = JSON.parse(body);
			console.log({ apiVersion, payload, shop, topic, webhookId });
		},
	},

	CUSTOMERS_REDACT: {
		deliveryMethod: DeliveryMethod.Http,
		callbackUrl: config.webhooksPath,
		callback: async (
			topic: string,
			shop: string,
			body: string,
			webhookId: string,
			apiVersion?: string
		) => {
			const payload = JSON.parse(body);
			console.log({ apiVersion, payload, shop, topic, webhookId });
		},
	},

	SHOP_REDACT: {
		deliveryMethod: DeliveryMethod.Http,
		callbackUrl: config.webhooksPath,
		callback: async (
			topic: string,
			shop: string,
			body: string,
			webhookId: string,
			apiVersion?: string
		) => {
			const payload = JSON.parse(body);
			console.log({ apiVersion, payload, shop, topic, webhookId });
		},
	},
};
