/**
 * Placeholder home page (ticket 02 spike). No product features are built in
 * the spike; the dashboard arrives with the auth-core slice.
 */
export default function Home() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>Form — alpha topology spike</h1>
      <p>
        Public Next.js process. API calls are proxied same-origin via the{" "}
        <code>/v1/*</code> rewrite to the internal NestJS process.
      </p>
    </main>
  );
}
