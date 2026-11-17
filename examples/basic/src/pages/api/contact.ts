/**
 * Contact form endpoint that sends an email with the client.
 *
 * The client reads RESEND_API_KEY at request time. The key is never part of
 * the build output.
 */
import type { APIRoute } from "astro";
import { createResendClient, isResendError } from "emdash-resend-kit/client";

export const prerender = false;

const resend = createResendClient({
	from: "Website <website@mail.example.com>",
	// The integration test points the client at a local mock server.
	...(process.env.RESEND_BASE_URL ? { baseUrl: process.env.RESEND_BASE_URL } : {}),
});

export const POST: APIRoute = async ({ request, redirect }) => {
	const form = await request.formData();
	const email = String(form.get("email") ?? "").trim();
	const message = String(form.get("message") ?? "").trim();
	if (!email.includes("@") || !message) return redirect("/?sent=0", 303);

	try {
		await resend.send({
			to: "hello@example.com",
			replyTo: email,
			subject: "New message from the contact form",
			text: message,
			tags: { category: "contact_form" },
		});
		return redirect("/?sent=1", 303);
	} catch (error) {
		// The error message contains no secret.
		console.error(isResendError(error) ? `${error.code}: ${error.message}` : error);
		return redirect("/?sent=0", 303);
	}
};
