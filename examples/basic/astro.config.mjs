import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { resendKit } from "emdash-resend-kit";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [
				resendKit({
					// The sender address must be on a domain that you verified in Resend.
					from: "Website <website@mail.example.com>",
					replyTo: "hello@example.com",
					suppression: true,
					// The integration test points the plugin at a local mock server.
					...(process.env.RESEND_BASE_URL ? { baseUrl: process.env.RESEND_BASE_URL } : {}),
				}),
			],
		}),
	],
	devToolbar: { enabled: false },
});
