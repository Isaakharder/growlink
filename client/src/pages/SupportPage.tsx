import { useEffect } from "react";

const SUPPORT_TITLE = "GrowLink Mobile Support";
const SUPPORT_DESCRIPTION =
  "Get help with GrowLink Mobile: account access, troubleshooting, and questions about the app.";

const CONTACT_NAME = "Isaak Harder Hiebert";
const CONTACT_EMAIL = "isaakiya26@live.com";
const CONTACT_PHONE_DISPLAY = "+1 519-990-3015";
const CONTACT_PHONE_HREF = "tel:+15199903015";

// Public page (no sign-in): it is the App Store "Support URL". The SPA shell's static
// <title>/<meta description> are generic, so set the page-specific ones here and put the
// originals back on unmount, so navigating on to /login or the app doesn't keep them.
function usePageMetadata(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const createdMeta = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    const previousDescription = meta.content;

    document.title = title;
    meta.content = description;

    return () => {
      document.title = previousTitle;
      if (createdMeta) meta?.remove();
      else if (meta) meta.content = previousDescription;
    };
  }, [title, description]);
}

export function SupportPage() {
  usePageMetadata(SUPPORT_TITLE, SUPPORT_DESCRIPTION);

  return (
    <div className="login-shell">
      <main className="login-card support-card" aria-labelledby="support-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <h1 id="support-heading">{SUPPORT_TITLE}</h1>
            <p>Farm Data Platform</p>
          </div>
        </div>

        <p className="support-intro">
          Need help with GrowLink Mobile? Contact support for account access, troubleshooting, and any
          questions about GrowLink Mobile.
        </p>

        <section className="support-section" aria-labelledby="support-contact-heading">
          <h2 id="support-contact-heading">Contact</h2>
          <p className="support-contact-name">{CONTACT_NAME}</p>
          <ul className="support-contact-list">
            <li>
              <a className="support-contact-link" href={`mailto:${CONTACT_EMAIL}`}>
                <span className="support-contact-label">Email</span>
                <span className="support-contact-value">{CONTACT_EMAIL}</span>
              </a>
            </li>
            <li>
              <a className="support-contact-link" href={CONTACT_PHONE_HREF}>
                <span className="support-contact-label">Phone</span>
                <span className="support-contact-value">{CONTACT_PHONE_DISPLAY}</span>
              </a>
            </li>
          </ul>
        </section>

        <section className="support-section" aria-labelledby="support-tips-heading">
          <h2 id="support-tips-heading">When you get in touch</h2>
          <p className="support-note">
            Please include the email address you sign in with and a short description of what happened, so
            we can help you as quickly as possible.
          </p>
        </section>
      </main>
    </div>
  );
}
