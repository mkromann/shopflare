import { createGraphQLClient } from "@shopify/graphql-client";
import { jwtVerify, type JWTPayload } from "jose";
import { type AppLoadContext, redirect } from "react-router";

export const apiVersion = "2025-01";

export function createShopify(context: AppLoadContext) {
	const env = context.cloudflare.env; // TODO: validate
	const config = {
		apiHost: env.SHOPIFY_APP_URL,
		apiKey: env.SHOPIFY_API_KEY,
		apiSecretKey: env.SHOPIFY_API_SECRET_KEY,
		apiVersion,
	};

	async function authorize(request: Request) {
		const url = new URL(request.url);

		let encodedSessionToken = null;
		let decodedSessionToken = null;
		try {
			encodedSessionToken =
				request.headers.get("Authorization")?.replace("Bearer ", "") ||
				url.searchParams.get("id_token") ||
				"";

			const key = config.apiSecretKey;
			const hmacKey = new Uint8Array(key.length);
			for (let i = 0, keyLen = key.length; i < keyLen; i++) {
				hmacKey[i] = key.charCodeAt(i);
			}

			const { payload } = await jwtVerify(encodedSessionToken, hmacKey, {
				algorithms: ["HS256"],
				clockTolerance: 10,
			});

			// The exp and nbf fields are validated by the JWT library
			if (payload.aud !== config.apiKey) {
				throw new ShopifyException("Session token had invalid API key", {
					status: 401,
					type: "JWT",
				});
			}
			decodedSessionToken = payload as ShopifyJWTPayload;
		} catch (_error) {
			const isDocumentRequest = !request.headers.has("Authorization");
			if (isDocumentRequest) {
				// Remove `id_token` from the query string to prevent an invalid session token sent to the redirect path.
				url.searchParams.delete("id_token");

				// Using shopify-reload path to redirect the bounce automatically.
				url.searchParams.append(
					"shopify-reload",
					`${url.pathname}?${url.searchParams.toString()}`,
				);
				throw redirect(
					`/shopify/auth/session-token-bounce?${url.searchParams.toString()}`,
				);
			}

			throw new Response(undefined, {
				headers: new Headers({
					"X-Shopify-Retry-Invalid-Session-Request": "1",
				}),
				status: 401,
				statusText: "Unauthorized",
			});
		}

		const shop = utils.sanitizeShop(new URL(decodedSessionToken.dest).hostname);
		if (!shop) {
			throw new ShopifyException("Received invalid shop argument", {
				status: 400,
				type: "SHOP",
			});
		}

		const body = {
			client_id: config.apiKey,
			client_secret: config.apiSecretKey,
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: encodedSessionToken,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type:
				"urn:shopify:params:oauth:token-type:offline-access-token",
		};

		const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
			method: "POST",
			body: JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
		});
		if (!response.ok) {
			const body: any = await response.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
			if (typeof response === "undefined") {
				const message = body?.errors?.message ?? "";
				throw new ShopifyException(
					`Http request error, no response available: ${message}`,
					{
						status: 400,
						type: "HTTP-REQUEST",
					},
				);
			}

			if (response.status === 200 && body.errors.graphQLErrors) {
				throw new ShopifyException(
					body.errors.graphQLErrors?.[0].message ?? "GraphQL operation failed",
					{
						status: 400,
						type: "GRAPHQL",
					},
				);
			}

			const errorMessages: string[] = [];
			if (body.errors) {
				errorMessages.push(JSON.stringify(body.errors, null, 2));
			}
			const xRequestId = response.headers.get("x-request-id");
			if (xRequestId) {
				errorMessages.push(
					`If you report this error, please include this id: ${xRequestId}`,
				);
			}

			const errorMessage = errorMessages.length
				? `:\n${errorMessages.join("\n")}`
				: "";

			switch (true) {
				case response.status === 429: {
					throw new ShopifyException(
						`Shopify is throttling requests ${errorMessage}`,
						{
							status: response.status,
							type: "THROTTLING",
							// retryAfter: response.headers.has("Retry-After") ? parseFloat(response.headers.get("Retry-After")) : undefined,
						},
					);
				}
				case response.status >= 500:
					throw new ShopifyException(`Shopify internal error${errorMessage}`, {
						status: response.status,
						type: "INTERNAL",
					});
				default:
					throw new ShopifyException(
						`Received an error response (${response.status} ${response.statusText}) from Shopify${errorMessage}`,
						{
							status: response.status,
							type: "HTTP-RESPONSE",
						},
					);
			}
		}

		const accessTokenResponse = await response.json<{
			access_token: string;
			expires_in?: number;
			scope: string;
		}>();
		await session.set({
			id: shop,
			shop,
			scope: accessTokenResponse.scope,
			expires: accessTokenResponse.expires_in
				? new Date(Date.now() + accessTokenResponse.expires_in * 1000)
				: undefined,
			accessToken: accessTokenResponse.access_token,
		});

		const client = createClient({
			headers: { "X-Shopify-Access-Token": accessTokenResponse.access_token },
			shop,
		});
		return client;
	}

	function createClient({
		apiVersion = config.apiVersion,
		headers,
		shop,
	}: {
		apiVersion?: string;
		shop: string;
		headers: Record<string, string | string[]>;
	}) {
		const client = createGraphQLClient({
			customFetchApi: fetch,
			headers: {
				"Content-Type": "application/json",
				...headers,
			},
			url: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
		});
		return client;
	}

	const session = new ShopifySession(env.SESSION_STORAGE);

	const utils = {
		allowedDomains: ["myshopify.com", "shopify.com", "myshopify.io"]
			.map((v) => v.replace(/\./g, "\\.")) // escape
			.join("|"),

		legacyUrlToShopAdminUrl(shop: string) {
			const shopUrl = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
			const regex = /(.+)\\.myshopify\\.com$/;

			const matches = shopUrl.match(regex);
			if (matches && matches.length === 2) {
				const shopName = matches[1];
				return `admin.shopify.com/store/${shopName}`;
			}
			return null;
		},

		sanitizeHost(host: string) {
			const base64regex = /^[0-9a-z+/]+={0,2}$/i;
			let sanitizedHost = base64regex.test(host) ? host : null;
			if (sanitizedHost) {
				const { hostname } = new URL(`https://${atob(sanitizedHost)}`);

				const hostRegex = new RegExp(`\\.(${utils.allowedDomains})$`);
				if (!hostRegex.test(hostname)) {
					sanitizedHost = null;
				}
			}
			return sanitizedHost;
		},

		sanitizeShop(shop: string) {
			let shopUrl: string = shop;

			const shopAdminRegex = new RegExp(
				`^admin\\.(?:${utils.allowedDomains})/store/(?:[a-zA-Z0-9]\\w*)$`,
			);
			if (shopAdminRegex.test(shopUrl)) {
				shopUrl = shopUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
				if (shopUrl.split(".")[0] !== "admin") {
					return null;
				}

				const regex = /admin\..+\/store\/[^/]+/;
				const matches = shopUrl.match(regex);
				if (matches && matches.length === 2) {
					const shopName = matches[1];
					shopUrl = `${shopName}.myshopify.com`;
				} else {
					return null;
				}
			}

			const shopUrlRegex = new RegExp(
				`^[a-zA-Z0-9][\\w-]*\\.(?:${utils.allowedDomains})$`,
			);
			const sanitizedShop = shopUrlRegex.test(shopUrl) ? shopUrl : null;
			return sanitizedShop;
		},
	};

	return {
		authorize,
		config,
		session,
		utils,
	};
}

export class ShopifyException extends Error {
	errors?: unknown[];
	status = 500;
	type:
		| "GRAPHQL"
		| "HTTP-REQUEST"
		| "HTTP-RESPONSE"
		| "INTERNAL"
		| "JWT"
		| "SERVER"
		| "SHOP"
		| "THROTTLING" = "SERVER";

	constructor(
		message: string,
		options: ErrorOptions & {
			errors?: string[];
			status: number;
			type: string;
		},
	) {
		super(message);

		Object.setPrototypeOf(this, new.target.prototype);
		Object.assign(this, {
			name: this.constructor.name,
			errors: [],
			...(options ?? {}),
		});
	}
}

interface ShopifyJWTPayload extends Required<JWTPayload> {
	dest: string;
}

interface Session {
	id: string;
	shop: string;
	scope: string;
	expires?: Date;
	accessToken: string;
}

type SerializedSession = [string, string | number | boolean][];

export class ShopifySession {
	#namespace: KVNamespace;
	#properties = ["accessToken", "expires", "id", "scope", "shop"];

	constructor(namespace: KVNamespace) {
		this.#namespace = namespace;
	}

	async delete(id: string | undefined) {
		if (!id) return false;

		const session = await this.get(id);
		if (!session) return false;

		await this.#namespace.delete(id);
		return true;
	}

	deserialize(data: SerializedSession): Session {
		const obj = Object.fromEntries(
			data
				.filter(([_key, value]) => value !== null && value !== undefined)
				.map(([key, value]) => {
					switch (key.toLowerCase()) {
						case "accesstoken":
							return ["accessToken", value];
						default:
							return [key.toLowerCase(), value];
					}
				}),
		);

		return Object.entries(obj).reduce((session, [key, value]) => {
			switch (key) {
				case "scope":
					session[key] = value.toString();
					break;
				case "expires":
					session[key] = value ? new Date(Number(value)) : undefined;
					break;
				default:
					(session as any)[key] = value; // eslint-disable-line @typescript-eslint/no-explicit-any
					break;
			}
			return session;
		}, {} as Session);
	}

	async get(id: string | undefined) {
		if (!id) return;

		const data = await this.#namespace.get<[string, string | number][]>(
			id,
			"json",
		);
		return data ? this.deserialize(data) : undefined;
	}

	async set(session: Session) {
		return this.#namespace.put(
			session.id,
			JSON.stringify(this.serialize(session)),
		);
	}

	serialize(session: Session): SerializedSession {
		return Object.entries(session)
			.filter(
				([key, value]) =>
					this.#properties.includes(key) &&
					value !== undefined &&
					value !== null,
			)
			.flatMap(([key, value]): [string, string | number | boolean][] => {
				switch (key) {
					case "expires":
						return [[key, value ? value.getTime() : undefined]];
					default:
						return [[key, value]];
				}
			})
			.filter(([_key, value]) => value !== undefined);
	}
}
