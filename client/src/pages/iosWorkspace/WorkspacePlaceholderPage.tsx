import { WORKSPACE_SECTIONS, type WorkspaceSectionId } from "./workspaceNav";

// Shell-only stand-in for a workspace page; each is replaced by its real
// compact page in a follow-up PR.
export default function WorkspacePlaceholderPage({ section }: { section: WorkspaceSectionId }) {
  const { label } = WORKSPACE_SECTIONS.find((s) => s.id === section)!;
  return (
    <section className="iosws-page" aria-labelledby="iosws-page-title">
      <h2 id="iosws-page-title" className="iosws-page-title">
        {label}
      </h2>
      <p className="iosws-page-note">Coming soon to the compact workspace.</p>
    </section>
  );
}
