type PagePlaceholderProps = {
  title: string;
  description: string;
};

export function PagePlaceholder({ title, description }: PagePlaceholderProps) {
  return (
    <section className="page-shell">
      <header>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>

      <div className="coming-soon-card">
        <h2>Coming Soon</h2>
        <p>
          This section is ready for future implementation. Core business logic
          and workflows will be added in a later phase.
        </p>
      </div>
    </section>
  );
}
