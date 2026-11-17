/**
 * Browser checks of the admin pages for the integration test.
 *
 * The script starts its own headless Chromium with a new context. Install
 * Playwright first:
 *
 *   npm install --no-save playwright && npx playwright install chromium
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = "emdash-resend-kit";

/**
 * @param {{ origin: string, outDir: string, check: (name: string, ok: unknown, detail?: string) => void }} input
 */
export async function browserCheck({ origin, outDir, check }) {
	const { chromium } = await import("playwright");
	mkdirSync(outDir, { recursive: true });
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	/** @type {string[]} */
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });
	const pluginUrl = (path) => `${origin}/_emdash/admin/plugins/${PLUGIN_ID}${path}`;

	try {
		await page.goto(`${origin}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`);
		await page.waitForURL(/\/_emdash\/admin/, { timeout: 60_000 });

		// A new account gets a welcome dialog. Close it.
		await page
			.getByRole("button", { name: "Get Started" })
			.click({ timeout: 20_000 })
			.catch(() => {});
		await page.waitForTimeout(1000);

		// Dashboard widget.
		await page.getByText("Email delivery").first().waitFor({ timeout: 60_000 });
		await page.getByText("Last 7 days").first().waitFor({ timeout: 30_000 });
		check("browser: the dashboard shows the delivery widget", true);
		await shot("dashboard");

		// Sidebar navigation.
		const navigation = await page.locator("nav, aside").allInnerTexts();
		check(
			"browser: the sidebar lists the plugin pages",
			navigation.join(" ").includes("Email log"),
			navigation.join(" ").slice(0, 300),
		);

		// Settings page.
		await page.goto(pluginUrl("/settings"));
		await page
			.getByText("Present. Environment variable RESEND_API_KEY.")
			.first()
			.waitFor({ timeout: 60_000 });
		check("browser: the settings page shows the API key status", true);
		check(
			"browser: the settings page shows the domain table",
			await page.getByText("mail.example.com").first().isVisible(),
		);
		check(
			"browser: the settings page shows the webhook URL",
			await page.getByText(`/_emdash/api/plugins/${PLUGIN_ID}/webhook`).first().isVisible(),
		);
		check(
			"browser: the settings page links to the EmDash email settings",
			await page
				.getByRole("link", { name: /Open email settings/ })
				.first()
				.isVisible(),
		);
		await shot("settings");

		// Test email button.
		await page.getByLabel("Recipient", { exact: true }).fill("browser@example.com");
		await page.getByRole("button", { name: "Send test email" }).click();
		await page.getByText("Resend accepted the test email.").first().waitFor({ timeout: 30_000 });
		check("browser: the test email button shows the result", true);
		await shot("settings-test-result");

		// Delivery log with filter and detail view.
		await page.goto(pluginUrl("/log"));
		// The integration run set the recipient privacy to "masked" before this check.
		await page.getByText("b***@example.com").first().waitFor({ timeout: 60_000 });
		check("browser: the log lists the test email with a masked recipient", true);
		await shot("log");
		await page.getByText("Filters", { exact: true }).first().click();
		await page.getByLabel("Search", { exact: true }).fill("browser@example.com");
		await page.getByRole("button", { name: "Apply filters" }).click();
		await page.waitForTimeout(1500);
		const rows = await page.locator("table tbody tr").count();
		check("browser: the search filter narrows the log", rows === 1, `rows: ${rows}`);
		await page.getByRole("button", { name: "View" }).first().click();
		await page.getByText("Email details").first().waitFor({ timeout: 30_000 });
		await page.getByText("Timeline").first().waitFor({ timeout: 30_000 });
		check("browser: the detail view shows the timeline", true);
		await shot("log-detail");
		await page.getByRole("button", { name: "Back to the log" }).click();
		await page.getByText("Email log").first().waitFor({ timeout: 30_000 });

		// Suppression list.
		await page.goto(pluginUrl("/suppressions"));
		await page.getByText("Suppression list").first().waitFor({ timeout: 60_000 });
		await page.getByLabel("Add an address", { exact: true }).fill("blocked@example.com");
		await page.getByRole("button", { name: "Add to list" }).click();
		await page.getByRole("cell", { name: "b***@example.com" }).first().waitFor({ timeout: 30_000 });
		check("browser: an administrator can add a suppressed address", true);
		await shot("suppressions");

		// Email settings of EmDash list the provider.
		await page.goto(`${origin}/_emdash/admin/settings/email`);
		await page
			.getByText(/resend/i)
			.first()
			.waitFor({ timeout: 60_000 });
		check("browser: the EmDash email settings list the plugin", true);
		await shot("emdash-email-settings");

		check(
			"browser: the pages raise no script error",
			pageErrors.length === 0,
			pageErrors.join(" | ").slice(0, 500),
		);
	} catch (error) {
		await shot("failure").catch(() => {});
		check(
			"browser: the browser run completes",
			false,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		await browser.close();
	}
}
