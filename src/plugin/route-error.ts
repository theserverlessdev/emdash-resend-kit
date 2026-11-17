/**
 * Error for a plugin route with an HTTP status.
 *
 * EmDash recognises a route error by its shape: the name `PluginRouteError`,
 * a `code`, and a `status`. This class has that shape, so the runtime code
 * does not need a value import from `emdash`.
 */
export class PluginRouteError extends Error {
	override readonly name = "PluginRouteError";

	constructor(
		readonly code: string,
		message: string,
		readonly status: number = 400,
	) {
		super(message);
	}
}
