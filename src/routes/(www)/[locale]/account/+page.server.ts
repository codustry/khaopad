/**
 * /[locale]/account — customer account page (v3.17, #160 Phase D1).
 *
 * Signed out: an email-OTP login form (client-side fetches against the
 * Better Auth endpoints /api/auth/email-otp/send-verification-otp and
 * /api/auth/sign-in/email-otp — the same mounted handler the admin
 * login uses, different flow).
 *
 * Signed in: order history matched by the VERIFIED session email (see
 * listOrdersForCustomer for why email, not user id) + saved-address
 * CRUD via form actions. Works for any signed-in role — a staff member
 * shopping their own store sees their orders too.
 */
import { error, fail } from "@sveltejs/kit";
import { toLocale } from "$lib/i18n";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  listOrdersForCustomer,
  updateAddress,
} from "$lib/server/account";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  if (!locals.user) {
    return { locale, account: null };
  }

  const [orders, addresses] = await Promise.all([
    listOrdersForCustomer(env.DB, {
      email: locals.user.email,
      emailVerified: locals.user.emailVerified,
    }),
    listAddresses(env.DB, locals.user.id),
  ]);

  return {
    locale,
    account: {
      email: locals.user.email,
      orders: orders.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        totalSatang: o.totalSatang,
        createdAt: o.createdAt,
      })),
      addresses,
    },
  };
};

function addressFromForm(fd: FormData) {
  return {
    name: String(fd.get("name") ?? ""),
    line1: String(fd.get("line1") ?? ""),
    line2: String(fd.get("line2") ?? "") || null,
    city: String(fd.get("city") ?? ""),
    region: String(fd.get("region") ?? "") || null,
    postalCode: String(fd.get("postalCode") ?? ""),
    countryCode: String(fd.get("countryCode") ?? ""),
    phone: String(fd.get("phone") ?? "") || null,
    isDefault: fd.get("isDefault") === "on" || fd.get("isDefault") === "true",
  };
}

export const actions: Actions = {
  addAddress: async ({ request, locals, platform }) => {
    if (!locals.user) return fail(401, { error: "Sign in first" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const result = await createAddress(
      env.DB,
      locals.user.id,
      addressFromForm(await request.formData()),
    );
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true };
  },

  updateAddress: async ({ request, locals, platform }) => {
    if (!locals.user) return fail(401, { error: "Sign in first" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const addressId = String(fd.get("addressId") ?? "");
    if (!addressId) return fail(400, { error: "Missing address id" });
    const result = await updateAddress(
      env.DB,
      locals.user.id,
      addressId,
      addressFromForm(fd),
    );
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true };
  },

  deleteAddress: async ({ request, locals, platform }) => {
    if (!locals.user) return fail(401, { error: "Sign in first" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const addressId = String(fd.get("addressId") ?? "");
    if (!addressId) return fail(400, { error: "Missing address id" });
    await deleteAddress(env.DB, locals.user.id, addressId);
    return { success: true };
  },
};
