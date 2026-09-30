export function PrivacyPolicyPage() {
  return (
    <main className="privacy-page">
      <header className="privacy-header">
        <a className="privacy-brand" href="/mobile" aria-label="GrowLink Mobile home">
          <span className="privacy-brand-mark" aria-hidden="true">GL</span>
          <span>GrowLink <strong>Mobile</strong></span>
        </a>
        <span className="privacy-label">Privacy</span>
      </header>

      <article className="privacy-content">
        <div className="privacy-intro">
          <p className="privacy-eyebrow">GrowLink Mobile</p>
          <h1>Privacy Policy</h1>
          <p className="privacy-effective">Effective September 29, 2026</p>
          <p>
            GrowLink Mobile is a greenhouse production and operations application. This policy
            describes the information used when you use the app and how it supports its
            greenhouse workflows.
          </p>
        </div>

        <section>
          <h2>Information We Collect</h2>
          <p>GrowLink Mobile collects and processes information you provide or use to access the app, including:</p>
          <ul>
            <li>Your email address and user ID.</li>
            <li>Other user content you enter, including greenhouse operational information such as yield, quality checks, irrigation logs, pest-control records, food-safety records, calibration records, and maintenance records.</li>
          </ul>
          <p>This information can be associated with your account or identity.</p>
        </section>

        <section>
          <h2>How We Use Information</h2>
          <p>
            We use this information for app functionality: to authenticate your account and
            provide greenhouse production and operations features, including recording and
            displaying the operational information you submit.
          </p>
          <p>
            GrowLink does not use this information for third-party advertising, developer
            advertising or marketing, or tracking across apps or websites. GrowLink does not
            sell personal information.
          </p>
        </section>

        <section>
          <h2>How Information Is Stored/Processed</h2>
          <p>
            Information is transmitted to and stored by GrowLink's backend and service providers
            as necessary to operate the application. Account and operational information is
            processed to provide the features you use. Access to organization data and app
            features is managed through account authentication and organization permissions.
          </p>
        </section>

        <section>
          <h2>Sharing of Information</h2>
          <p>
            We may provide information to service providers that process or store it as necessary
            to operate GrowLink Mobile. Operational information may also be available to
            authorized members of your organization through the app, according to account
            permissions. We do not sell personal information or share it for third-party
            advertising or cross-app/cross-site tracking.
          </p>
        </section>

        <section>
          <h2>Data Retention</h2>
          <p>
            Information is kept as needed to provide the application and support its greenhouse
            operations. Retention can depend on how the app and your organization use the records.
            This policy does not specify a retention period or guarantee deletion on a particular
            schedule.
          </p>
        </section>

        <section>
          <h2>Data Security</h2>
          <p>
            GrowLink uses account authentication and organization permissions to manage access
            within the application.
          </p>
        </section>

        <section>
          <h2>Children's Privacy</h2>
          <p>
            GrowLink Mobile is a commercial greenhouse production and operations application
            and is not intended for children.
          </p>
        </section>

        <section>
          <h2>Changes to This Privacy Policy</h2>
          <p>
            We may update this policy as GrowLink Mobile changes. When we do, we will update the
            effective date shown at the top of this page.
          </p>
        </section>

        <section>
          <h2>Contact Us</h2>
          <p>
            <strong>LLTech / GrowLink</strong>
            <br />
            <a href="mailto:support@lltech.io">support@lltech.io</a>
          </p>
        </section>
      </article>

      <footer className="privacy-footer">GrowLink Mobile - Greenhouse operations</footer>
    </main>
  );
}