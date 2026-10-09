/* AIpályázó — public site settings (safe to publish). */
window.AIP_CONFIG = {
  // Cloudflare Turnstile SITE key for the consultation form (public). Empty =
  // no captcha widget; the server then skips verification unless
  // TURNSTILE_SECRET is set (set both together).
  turnstileSiteKey: '0x4AAAAAAFSVV-_PRMUNBXxk',
  // Tax-number quick fill on onboarding (company-lookup → NAV). Turn on only
  // after the NAV_* secrets are set, otherwise the box is hidden.
  taxLookup: false,
  // Name the partner in the UI once they have agreed to it publicly.
  partnerPublic: false,
  partnerName: 'DFT-Hungária',
  functionsUrl: 'https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1'
};
