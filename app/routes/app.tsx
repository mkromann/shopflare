import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider, type AppProviderProps } from "@shopify/polaris";
import type {
	LinkLikeComponent,
	LinkLikeComponentProps,
} from "@shopify/polaris/build/ts/src/utilities/link";
import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLoaderData } from "react-router";

import type { Route } from "./+types/app";
import { APP_BRIDGE_URL } from "~/const";
import { createShopify } from "~/shopify.server";

export async function loader({ context, request }: Route.LoaderArgs) {
	const shopify = createShopify(context);
	console.debug("app");

	const response = await shopify.authorize(request);
	if (response instanceof Response) throw response;

	return { apiKey: shopify.config.apiKey };
}

export default function App() {
	const { apiKey } = useLoaderData<typeof loader>();

	const { t } = useTranslation("polaris");
	const i18n = {
		Polaris: t("Polaris", { returnObjects: true }),
	} as AppProviderProps["i18n"];

	return (
		<>
			<script data-api-key={apiKey} src={APP_BRIDGE_URL} />

			<AppProvider i18n={i18n} linkComponent={ReactRouterPolarisLink}>
				<NavMenu>
					<Link rel="home" to="/app">
						ShopFlare
					</Link>
				</NavMenu>

				<Outlet />
			</AppProvider>
		</>
	);
}

export function ErrorBoundary(error: Route.ErrorBoundaryProps) {
	if (
		error.constructor.name === "ErrorResponse" ||
		error.constructor.name === "ErrorResponseImpl"
	) {
		return (
			<div
				dangerouslySetInnerHTML={{
					__html: (error as any).data || "Handling response", // eslint-disable-line @typescript-eslint/no-explicit-any
				}}
			/>
		);
	}

	throw error;
}
ErrorBoundary.displayName = "AppErrorBoundary";

export function headers({
	parentHeaders,
	loaderHeaders,
	actionHeaders,
	errorHeaders,
}: Route.HeadersArgs) {
	if (errorHeaders && Array.from(errorHeaders.entries()).length > 0) {
		return errorHeaders;
	}

	return new Headers([
		...(parentHeaders ? Array.from(parentHeaders.entries()) : []),
		...(loaderHeaders ? Array.from(loaderHeaders.entries()) : []),
		...(actionHeaders ? Array.from(actionHeaders.entries()) : []),
	]);
}

export const ReactRouterPolarisLink = forwardRef<
	HTMLAnchorElement,
	LinkLikeComponentProps
>((props, ref) => (
	<Link {...props} ref={ref} to={props.url ?? props.to} />
)) as LinkLikeComponent;
ReactRouterPolarisLink.displayName = "ReactRouterPolarisLink";
