/* Pályázati Értesítő — public site settings (safe to publish). */
window.AIP_CONFIG = {
  // Cloudflare Turnstile SITE key for the consultation form (public). Empty =
  // no captcha widget; the server then skips verification unless
  // TURNSTILE_SECRET is set (set both together).
  turnstileSiteKey: '0x4AAAAAAFSVV-_PRMUNBXxk',
  // Tax-number quick fill on onboarding (company-lookup → NAV). If the NAV_*
  // secrets are missing the server answers 503 and the box hides itself.
  taxLookup: true,
  // Name the partner in the UI once they have agreed to it publicly.
  partnerPublic: true,
  partnerName: 'DFT-Hungária',
  partnerLogo: 'assets/partners/dft-logo.png',
  partnerUrl: 'https://www.dft.hu/',
  functionsUrl: 'https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1'
};
